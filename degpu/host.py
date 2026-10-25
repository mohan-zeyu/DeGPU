"""The DeGPU network host: the shared chain, file store and faucet that one laptop serves to
everyone on the local network.

``degpu host`` runs:

* **anvil, on 127.0.0.1 only**, with a secret random mnemonic and its state saved to disk, so
  the chain (blocks, events, balances) survives restarts. The first run deploys the contracts.
* **one HTTP server for the LAN** (default port 8600):

  - ``/rpc``: a JSON-RPC gateway to anvil. It lets through reads and transactions the sender
    signed (``eth_sendRawTransaction``) and nothing else: no time travel (``evm_*``), no free
    balances (``anvil_*``) and no sending from the host's own accounts (``eth_sendTransaction``).
  - ``/blobs/<sha256hex>``: the encrypted file store (``storage.HttpStore`` on the nodes).
  - ``/faucet``: test ETH, once per address.
  - ``/artifacts/<contract>``: the deployed contracts' ABIs, so users don't need Foundry.
  - ``/network.json``: what a node needs to join (chain id, registry, the paths above).

Everything the host keeps is in ``<home>/host/`` (``DEGPU_HOME``, default ``~/.degpu``):
``mnemonic.txt``, ``anvil-state.json``, ``network.json``, ``faucet.json`` and ``store/``.

    uv run degpu host                 # prints the join URL to give to classmates
    uv run degpu host --fresh         # start over with a new chain
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import socket
import threading
from pathlib import Path
from typing import Any

import requests
import uvicorn
from eth_account.hdaccount import generate_mnemonic
from eth_account.types import Language
from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import Response
from pydantic import BaseModel
from web3 import Web3

from degpu.chain import ETHER, MARKET_CONTRACTS, Anvil, Chain, load_artifact
from degpu.storage import PREFIX, Store, digest_of
from degpu.wallet import home

DEFAULT_PORT = 8600
DEFAULT_FAUCET_WEI = 2 * ETHER
MAX_BLOB = 256 * 1024 * 1024  # 256 MiB per file
OWNER_INDEX = 0  # deploys the contracts
FAUCET_INDEX = 1  # pays out test ETH
ARTIFACTS = frozenset({"ProviderRegistry", *MARKET_CONTRACTS.values()})

#: JSON-RPC methods the gateway passes on: reads, and transactions signed by their sender.
ALLOWED_RPC = frozenset({
    "web3_clientVersion", "net_version", "net_listening", "eth_chainId", "eth_syncing",
    "eth_blockNumber", "eth_gasPrice", "eth_maxPriorityFeePerGas", "eth_feeHistory",
    "eth_getBalance", "eth_getCode", "eth_getStorageAt", "eth_getTransactionCount",
    "eth_getBlockByNumber", "eth_getBlockByHash", "eth_getTransactionByHash",
    "eth_getTransactionReceipt", "eth_getLogs", "eth_call", "eth_estimateGas",
    "eth_sendRawTransaction",
})


class FaucetError(Exception):
    """The faucet won't pay this address (it already did)."""


class Host:
    """The chain, store and faucet of one DeGPU network. Call ``start()``, then serve ``app()``."""

    def __init__(self, folder: str | os.PathLike | None = None, *, faucet_wei: int = DEFAULT_FAUCET_WEI,
                 anvil_port: int | None = None):
        self.folder = Path(folder) if folder else home() / "host"
        self.faucet_wei = faucet_wei
        self.anvil_port = anvil_port
        self.anvil: Anvil | None = None
        self.chain: Chain | None = None
        self.store: Store | None = None
        self._faucet_lock = threading.Lock()
        self._local = threading.local()  # one HTTP session to anvil per server thread

    def start(self, fresh: bool = False) -> "Host":
        """Start anvil (loading the saved chain) and deploy the contracts if this chain has none.
        With ``fresh``, forget the old chain, its faucet claims and its files first."""
        self.folder.mkdir(parents=True, exist_ok=True)
        if fresh:
            for name in ("anvil-state.json", "network.json", "faucet.json"):
                (self.folder / name).unlink(missing_ok=True)
            shutil.rmtree(self.folder / "store", ignore_errors=True)
        self.anvil = Anvil(self.anvil_port, accounts=2, balance_eth=1_000_000, mnemonic=self._mnemonic(),
                           state=self.folder / "anvil-state.json").start()
        self.chain = Chain(self.anvil.rpc_url)
        saved = self._read("network.json")
        if saved and self.chain.w3.eth.get_code(saved["registry"]):
            self.chain.attach(saved["registry"])
        else:
            self.chain.deploy(owner=self.chain.accounts[OWNER_INDEX])
            self._write("network.json", {"registry": self.chain.registry.address})
            self._write("faucet.json", {})  # claims made on an older chain don't count here
        self.store = Store(self.folder / "store")
        return self

    def stop(self) -> None:
        if self.anvil:
            self.anvil.stop()

    # -- what the server offers -----------------------------------------------------

    def network_info(self) -> dict:
        """``/network.json``. URLs are relative to the network URL the node joined with."""
        return {
            "name": "DeGPU",
            "chain_id": self.chain.w3.eth.chain_id,
            "registry": self.chain.registry.address,
            "rpc": "rpc",
            "store": "blobs",
            "faucet": "faucet",
            "artifacts": "artifacts",
            "faucet_wei": str(self.faucet_wei),
        }

    def rpc(self, req: Any) -> dict:
        """Answer one JSON-RPC request: forward it to anvil if it is allowed."""
        if not isinstance(req, dict) or not isinstance(req.get("method"), str):
            return _rpc_error(None, -32600, "invalid JSON-RPC request")
        rid, method = req.get("id"), req["method"]
        if method == "eth_accounts":
            return {"jsonrpc": "2.0", "id": rid, "result": []}  # the host's accounts are not for sending
        if method not in ALLOWED_RPC:
            return _rpc_error(rid, -32601, f"{method} is not allowed through the DeGPU gateway")
        if not hasattr(self._local, "http"):
            self._local.http = requests.Session()
        try:
            return self._local.http.post(self.anvil.rpc_url, json=req, timeout=60).json()
        except (requests.RequestException, ValueError) as e:
            return _rpc_error(rid, -32603, f"the chain did not answer: {e}")

    def faucet(self, address: str) -> dict:
        """Send ``faucet_wei`` test ETH to ``address``, once per address."""
        if not Web3.is_address(address):
            raise ValueError(f"{address!r} is not an Ethereum address")
        address = Web3.to_checksum_address(address)
        with self._faucet_lock:
            claims = self._read("faucet.json") or {}
            if address in claims:
                raise FaucetError("this address already got its test ETH")
            w3 = self.chain.w3
            tx = w3.eth.send_transaction({"from": self.chain.accounts[FAUCET_INDEX], "to": address,
                                          "value": self.faucet_wei})
            w3.eth.wait_for_transaction_receipt(tx)
            claims[address] = "0x" + bytes(tx).hex()
            self._write("faucet.json", claims)
        return {"address": address, "amount_wei": str(self.faucet_wei), "tx": claims[address]}

    def app(self) -> FastAPI:
        return build_app(self)

    # -- files ------------------------------------------------------------------------

    def _mnemonic(self) -> str:
        """The chain's secret mnemonic, made on the first run (anvil's default one is public,
        so anyone could sign as the contract owner or the faucet)."""
        path = self.folder / "mnemonic.txt"
        if not path.exists():
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w") as f:
                f.write(generate_mnemonic(12, Language.ENGLISH))
        return path.read_text().strip()

    def _read(self, name: str) -> dict | None:
        path = self.folder / name
        return json.loads(path.read_text()) if path.exists() else None

    def _write(self, name: str, data: dict) -> None:
        path = self.folder / name
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=1))
        os.replace(tmp, path)


def _rpc_error(rid, code: int, message: str) -> dict:
    return {"jsonrpc": "2.0", "id": rid, "error": {"code": code, "message": message}}


class FaucetRequest(BaseModel):
    address: str


def build_app(host: Host) -> FastAPI:
    """The host's HTTP server (see the module docstring)."""
    app = FastAPI(title="DeGPU network host", version="1",
                  description="Chain gateway, file store and faucet of one DeGPU network.")

    @app.get("/network.json")
    def network() -> dict:
        return host.network_info()

    @app.post("/rpc")
    def rpc(payload: Any = Body(...)) -> Any:
        if isinstance(payload, list):  # a JSON-RPC batch
            return [host.rpc(r) for r in payload]
        return host.rpc(payload)

    @app.put("/blobs/{digest}")
    async def put_blob(digest: str, request: Request) -> dict:
        _check_digest(digest)
        if int(request.headers.get("content-length") or 0) > MAX_BLOB:
            raise HTTPException(413, f"files are limited to {MAX_BLOB // 2**20} MiB")
        data = await request.body()
        if len(data) > MAX_BLOB:
            raise HTTPException(413, f"files are limited to {MAX_BLOB // 2**20} MiB")
        if hashlib.sha256(data).hexdigest() != digest:
            raise HTTPException(400, "the content does not match its sha256")
        await run_in_threadpool(host.store.put, data)
        return {"uri": PREFIX + digest}

    @app.get("/blobs/{digest}")
    def get_blob(digest: str) -> Response:
        _check_digest(digest)
        try:
            return Response(host.store.get(PREFIX + digest), media_type="application/octet-stream")
        except KeyError:
            raise HTTPException(404, "no such file") from None

    @app.post("/faucet")
    def faucet(req: FaucetRequest) -> dict:
        try:
            return host.faucet(req.address)
        except FaucetError as e:
            raise HTTPException(409, str(e)) from None
        except ValueError as e:
            raise HTTPException(400, str(e)) from None

    @app.get("/artifacts/{name}")
    def artifact(name: str) -> dict:
        if name not in ARTIFACTS:
            raise HTTPException(404, f"no contract {name!r}")
        abi, bytecode = load_artifact(name)
        return {"abi": abi, "bytecode": bytecode}

    return app


def _check_digest(digest: str) -> None:
    try:
        digest_of(PREFIX + digest)
    except KeyError:
        raise HTTPException(400, "a file is named by its sha256: 64 lowercase hex digits") from None


def lan_ip() -> str:
    """This laptop's address on the local network (no packet is sent)."""
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        try:
            s.connect(("10.255.255.255", 1))
            return s.getsockname()[0]
        except OSError:
            return "127.0.0.1"


def run(folder=None, *, port: int = DEFAULT_PORT, bind: str = "0.0.0.0", faucet_wei: int = DEFAULT_FAUCET_WEI,
        fresh: bool = False) -> None:
    """``degpu host``: start the host and serve it until Ctrl-C."""
    host = Host(folder, faucet_wei=faucet_wei).start(fresh=fresh)
    try:
        info = host.network_info()
        print("DeGPU network is running.")
        print(f"  join URL   http://{lan_ip() if bind == '0.0.0.0' else bind}:{port}   (give this to the other users)")
        print(f"  chain id   {info['chain_id']}, registry {info['registry']}")
        print(f"  faucet     {host.faucet_wei / ETHER:g} ETH per new wallet")
        print(f"  data       {host.folder}")
        print("Ctrl-C to stop.", flush=True)
        uvicorn.run(host.app(), host=bind, port=port, log_level="warning")
    finally:
        host.stop()
