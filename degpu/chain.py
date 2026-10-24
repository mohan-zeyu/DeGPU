"""Blockchain plumbing for DeGPU: a local anvil node, contract deployment and
small web3.py (v8) helpers used by the client, the provider agents and the demo.

Main pieces (docs/INTERFACE.md v2, sections 7 and 8):

* ``Anvil`` starts and stops a local anvil node on a free port (default
  mnemonic, so account 0 is the deployer, 1 the client, 2-7 providers A-F).
* ``load_artifact`` reads ABI and bytecode from ``contracts/out/``, running
  ``forge build`` first if the artifacts are missing.
* ``Chain`` wraps a Web3 connection plus the two deployed contracts. It sends
  transactions from anvil's unlocked accounts, keeps a per-account tally of the
  gas spent (so balances can be checked net of gas), reads and decodes market
  events, and offers the time-travel helpers ``increase_time`` / ``mine``.
* ``deploy`` deploys ProviderRegistry (minStake 0.8 ETH) and JobMarket with the
  demo Params, calls ``setMarket`` and registers task type 1
  (``image-classify-v1`` with the local runner hash).

Run ``uv run python -m degpu.chain`` to start a fresh anvil with the contracts
deployed and print the addresses (handy for the CLI agents / client).
"""

from __future__ import annotations

import argparse
import atexit
import json
import signal
import socket
import subprocess
import sys
import time
from collections import defaultdict
from enum import IntEnum
from pathlib import Path
from typing import Any

from eth_utils import event_abi_to_log_topic
from web3 import Web3
from web3.exceptions import ContractLogicError

REPO_ROOT = Path(__file__).resolve().parent.parent
CONTRACTS_DIR = REPO_ROOT / "contracts"
OUT_DIR = CONTRACTS_DIR / "out"

ETHER = 10**18
ZERO_ADDRESS = "0x" + "00" * 20
ZERO32 = b"\x00" * 32

# Demo settings (INTERFACE.md sections 6, 7 and 9).
MIN_STAKE = 8 * ETHER // 10  # 0.8 ETH
PROVIDER_STAKE = 1 * ETHER  # each provider registers with 1 ETH
PRICE_PER_ITEM = ETHER // 10_000  # 0.0001 ETH per item
TASK_NAME = "image-classify-v1"
TASK_TYPE_ID = 1

# Field order of JobMarket.Params.
DEMO_PARAMS = (
    300,  # acceptWindow
    600,  # computeWindow
    300,  # decideWindow
    600,  # checkWindow
    300,  # revealWindow
    300,  # publishWindow
    600,  # tiebreakWindow
    2 * ETHER // 1000,  # tiebreakFee 0.002 ETH
    3000,  # wrongSlashBps
    1000,  # missedSlashBps
    500,  # checkMissedSlashBps
    0,  # maxMismatch
    2,  # numVerifiers
)
NUM_VERIFIERS = DEMO_PARAMS[-1]

# Account roles for anvil's default mnemonic (INTERFACE.md section 1).
DEPLOYER_INDEX = 0
CLIENT_INDEX = 1
PROVIDER_NAMES = ["A", "B", "C", "D", "E", "F"]
PROVIDER_INDICES = {name: 2 + i for i, name in enumerate(PROVIDER_NAMES)}


# ---------------------------------------------------------------------------
# Enums mirrored from the contracts
# ---------------------------------------------------------------------------

class Status(IntEnum):
    NONE = 0
    OPEN = 1
    COMMITTING = 2
    DECIDING = 3
    CHECKING = 4
    CHECK_REVEAL = 5
    PUBLISHING = 6
    TIE_BREAK = 7
    CLOSED = 8


class Outcome(IntEnum):
    NONE = 0
    CANCELLED = 1
    DELIVERED = 2
    VERIFIED = 3
    MAIN_OUTVOTED = 4
    VERIFIER_OUTVOTED = 5
    BOTH_OUTVOTED = 6
    NO_MAJORITY = 7
    MAIN_MISSED = 8
    TIEBREAKER_MISSED = 9
    TIE_CLIENT_NO_SHARE = 10


class Drop(IntEnum):
    NONE = 0
    CLIENT_NO_REVEAL = 1
    NO_ELIGIBLE_VERIFIER = 2


class VState(IntEnum):
    NONE = 0
    ASSIGNED = 1
    SHARED = 2
    COMMITTED = 3
    REVEALED = 4
    NO_SHARE = 5
    BAD_INPUT = 6
    MISSED = 7
    OUTVOTED = 8


class Stat(IntEnum):
    VERIFIED_COMPLETED = 0
    UNVERIFIED_COMPLETED = 1
    MISSED = 2
    OUTVOTED = 3
    CHECKS_COMPLETED = 4
    CHECKS_MISSED = 5
    CHECKS_OUTVOTED = 6


# ---------------------------------------------------------------------------
# anvil
# ---------------------------------------------------------------------------

def free_port() -> int:
    """Ask the OS for a free TCP port on localhost."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Anvil:
    """A local anvil node running as a subprocess. Use as a context manager
    or call ``start()`` / ``stop()`` yourself."""

    def __init__(self, port: int | None = None, accounts: int = 10, balance_eth: int = 10_000):
        self.port = port or free_port()
        self.accounts = accounts
        self.balance_eth = balance_eth
        self.proc: subprocess.Popen | None = None

    @property
    def rpc_url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def start(self, timeout: float = 15.0) -> "Anvil":
        cmd = [
            "anvil",
            "--port", str(self.port),
            "--accounts", str(self.accounts),
            "--balance", str(self.balance_eth),
        ]
        try:
            self.proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except FileNotFoundError:
            raise RuntimeError("anvil not found: install Foundry (brew install foundry)") from None
        atexit.register(self.stop)  # never leave an orphaned anvil behind
        # Wait until the node answers JSON-RPC.
        w3 = Web3(Web3.HTTPProvider(self.rpc_url))
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.proc.poll() is not None:
                raise RuntimeError(f"anvil exited early with code {self.proc.returncode}")
            try:
                if w3.is_connected():
                    return self
            except Exception:
                pass
            time.sleep(0.1)
        self.stop()
        raise RuntimeError("anvil did not start in time")

    def stop(self) -> None:
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        self.proc = None

    def __enter__(self) -> "Anvil":
        return self.start()

    def __exit__(self, *exc) -> None:
        self.stop()


# ---------------------------------------------------------------------------
# Contract artifacts
# ---------------------------------------------------------------------------

def load_artifact(name: str) -> tuple[list, str]:
    """Return (abi, bytecode hex) of contract ``name`` from ``contracts/out``.
    Runs ``forge build`` once if the artifact is missing."""
    path = OUT_DIR / f"{name}.sol" / f"{name}.json"
    if not path.exists():
        subprocess.run(["forge", "build"], cwd=CONTRACTS_DIR, check=True, stdout=subprocess.DEVNULL)
    data = json.loads(path.read_text())
    return data["abi"], data["bytecode"]["object"]


# ---------------------------------------------------------------------------
# Chain: Web3 + contracts + helpers
# ---------------------------------------------------------------------------

class TxFailed(RuntimeError):
    """A transaction reverted (the message is the revert reason when known)."""


class Chain:
    """A Web3 connection with the DeGPU contracts attached."""

    def __init__(self, rpc_url: str, registry_address: str | None = None, market_address: str | None = None):
        self.rpc_url = rpc_url
        self.w3 = Web3(Web3.HTTPProvider(rpc_url, request_kwargs={"timeout": 60}))
        if not self.w3.is_connected():
            raise RuntimeError(f"cannot reach {rpc_url}")
        self.registry_abi, self.registry_bytecode = load_artifact("ProviderRegistry")
        self.market_abi, self.market_bytecode = load_artifact("JobMarket")
        self.registry = None
        self.market = None
        self._tag: str | None = None
        # wei of gas paid by each account through ``send`` (for net-of-gas checks)
        self.gas_spent: dict[str, int] = defaultdict(int)
        # topic0 -> event name, to decode raw market logs
        self._topics = {
            event_abi_to_log_topic(e): e["name"] for e in self.market_abi if e["type"] == "event"
        }
        if market_address:
            self.attach(market_address, registry_address)

    # -- setup ---------------------------------------------------------------

    @property
    def accounts(self) -> list[str]:
        """anvil's unlocked accounts (default mnemonic)."""
        return list(self.w3.eth.accounts)

    def attach(self, market_address: str, registry_address: str | None = None) -> None:
        """Use already-deployed contracts. The registry address is read from the market if omitted."""
        self._tag = None
        self.market = self.w3.eth.contract(
            address=Web3.to_checksum_address(market_address), abi=self.market_abi, decode_tuples=True
        )
        if registry_address is None:
            registry_address = self.market.functions.registry().call()
        self.registry = self.w3.eth.contract(
            address=Web3.to_checksum_address(registry_address), abi=self.registry_abi, decode_tuples=True
        )

    def deploy(self, runner_hash: bytes, owner: str | None = None) -> None:
        """Deploy the registry and the market with the demo parameters, link them
        and register task type 1 (``image-classify-v1``)."""
        owner = owner or self.accounts[DEPLOYER_INDEX]
        reg_factory = self.w3.eth.contract(abi=self.registry_abi, bytecode=self.registry_bytecode)
        r = self._wait(reg_factory.constructor(MIN_STAKE).transact({"from": owner}), owner)
        registry_address = r["contractAddress"]
        mk_factory = self.w3.eth.contract(abi=self.market_abi, bytecode=self.market_bytecode)
        r = self._wait(mk_factory.constructor(registry_address, DEMO_PARAMS).transact({"from": owner}), owner)
        self.attach(r["contractAddress"], registry_address)
        self.send(self.registry.functions.setMarket(self.market.address), owner)
        self.send(self.market.functions.addTaskType(runner_hash, TASK_NAME), owner)
        assert self.market.functions.taskTypeCount().call() == TASK_TYPE_ID

    # -- transactions --------------------------------------------------------

    def send(self, fn, sender: str, value: int = 0) -> dict:
        """Send contract call ``fn`` from the unlocked account ``sender`` and wait
        for the receipt. Raises ``TxFailed`` with the revert reason on failure."""
        try:
            tx_hash = fn.transact({"from": sender, "value": value})
        except ContractLogicError as e:  # web3 estimates gas first, which surfaces the revert
            raise TxFailed(_revert_reason(e)) from None
        return self._wait(tx_hash, sender)

    def _wait(self, tx_hash, sender: str) -> dict:
        receipt = self.w3.eth.wait_for_transaction_receipt(tx_hash)
        self.gas_spent[sender] += receipt["gasUsed"] * receipt["effectiveGasPrice"]
        if receipt["status"] != 1:
            raise TxFailed(f"transaction {tx_hash.hex()} reverted")
        return receipt

    # -- time travel ---------------------------------------------------------

    def increase_time(self, seconds: int) -> None:
        self.w3.provider.make_request("evm_increaseTime", [int(seconds)])

    def mine(self, blocks: int = 1) -> None:
        for _ in range(blocks):
            self.w3.provider.make_request("evm_mine", [])

    def now(self) -> int:
        """Timestamp of the latest block."""
        return self.w3.eth.get_block("latest")["timestamp"]

    def block_number(self) -> int:
        return self.w3.eth.block_number

    # -- reads -----------------------------------------------------------------

    def balance(self, addr: str) -> int:
        return self.w3.eth.get_balance(addr)

    def provider(self, addr: str):
        """registry.getProvider(addr) as a named tuple
        (registered, stake, encPubKey, pricePerItem, locks)."""
        return self.registry.functions.getProvider(addr).call()

    def stake(self, addr: str) -> int:
        return self.provider(addr).stake

    def stat(self, addr: str, s: Stat) -> int:
        return self.registry.functions.statOf(addr, int(s)).call()

    def job(self, job_id: int):
        """market.getJob(jobId) as a named tuple (job.status, job.verifiers, ...)."""
        return self.market.functions.getJob(job_id).call()

    def range_of(self, job_id: int, slot: int) -> tuple[int, int]:
        """Items [start, end) covered by verifier ``slot`` of the job."""
        start, end = self.market.functions.rangeOf(job_id, slot).call()
        return start, end

    def runner_hash_of(self, task_type: int) -> bytes:
        return bytes(self.market.functions.taskTypeOf(task_type).call()[0])

    # -- events --------------------------------------------------------------

    def market_events(self, from_block: int = 0, to_block: int | str = "latest", job_id: int | None = None) -> list:
        """All JobMarket events in [from_block, to_block], decoded, in chain order.
        Each item is web3 EventData: ``ev["event"]``, ``ev["args"]``, ``ev["blockNumber"]``...
        With ``job_id`` only that job's events are returned (jobId is the first indexed topic
        of every market event)."""
        flt: dict[str, Any] = {"address": self.market.address, "fromBlock": from_block, "toBlock": to_block}
        if job_id is not None:
            flt["topics"] = [None, "0x" + job_id.to_bytes(32, "big").hex()]
        out = []
        for log in self.w3.eth.get_logs(flt):
            name = self._topics.get(bytes(log["topics"][0]))
            if name is None:
                continue
            out.append(self.market.events[name]().process_log(log))
        return out

    def tag(self) -> str:
        """Identifies this chain + deployment (genesis hash and market address), so
        state files written against an earlier anvil run can be recognised and reset."""
        if self._tag is None:
            genesis = self.w3.eth.get_block(0)["hash"]
            self._tag = f"{bytes(genesis).hex()}:{self.market.address}"
        return self._tag


def _revert_reason(e: ContractLogicError) -> str:
    msg = str(e.args[0]) if e.args else str(e)
    return msg.removeprefix("execution reverted: ")


def start_local_chain(runner_hash: bytes | None = None, port: int | None = None) -> tuple[Anvil, Chain]:
    """Start a fresh anvil and deploy everything. Returns (anvil, chain)."""
    if runner_hash is None:
        from degpu.tasks.image_classify_v1.runner import runner_hash as local_runner_hash

        runner_hash = local_runner_hash()
    anvil = Anvil(port=port).start()
    try:
        chain = Chain(anvil.rpc_url)
        chain.deploy(runner_hash)
    except Exception:
        anvil.stop()
        raise
    return anvil, chain


def main() -> None:
    ap = argparse.ArgumentParser(description="Start anvil with the DeGPU contracts deployed.")
    ap.add_argument("--port", type=int, default=8545)
    args = ap.parse_args()
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))  # run the cleanup on `kill` too
    anvil, chain = start_local_chain(port=args.port)
    print(f"anvil      {anvil.rpc_url}")
    print(f"registry   {chain.registry.address}")
    print(f"market     {chain.market.address}")
    print("Ctrl-C to stop.", flush=True)
    try:
        while anvil.proc and anvil.proc.poll() is None:
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        anvil.stop()


if __name__ == "__main__":
    main()
