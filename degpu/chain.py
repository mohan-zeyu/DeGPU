"""Blockchain plumbing for DeGPU: a local anvil node, contract deployment and
small web3.py (v8) helpers used by the client, the provider agents and the demo.

Main pieces (docs/INTERFACE.md sections 6 to 9):

* ``Anvil`` starts and stops a local anvil node on a free port (default
  mnemonic, so account 0 is the deployer, 1 the client, 2-7 providers A-F).
* ``load_artifact`` reads ABI and bytecode from ``contracts/out/``, running
  ``forge build`` first if the artifacts are missing.
* ``Chain`` wraps a Web3 connection plus the deployed contracts: the
  ProviderRegistry and one market per verification mode, found through the
  registry (``Chain.markets["replicated"]``, ``Chain.markets["checked"]``). It
  sends transactions from anvil's unlocked accounts, keeps a per-account tally
  of the gas spent (so balances can be checked net of gas), resolves task-type
  ids by name, reads and decodes market events, and offers the time-travel
  helpers ``increase_time`` / ``mine``.
* ``Chain.deploy`` deploys the registry (minStake 0.8 ETH) and both markets
  with the demo Params, and registers every task installed under
  ``degpu/tasks/`` in its mode's market (deploying its checker contract first
  for a checked task).

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
from typing import Any, NamedTuple

from eth_utils import event_abi_to_log_topic
from web3 import Web3
from web3.exceptions import ContractLogicError

REPO_ROOT = Path(__file__).resolve().parent.parent
CONTRACTS_DIR = REPO_ROOT / "contracts"
OUT_DIR = CONTRACTS_DIR / "out"

ETHER = 10**18
ZERO_ADDRESS = "0x" + "00" * 20
ZERO32 = b"\x00" * 32

# Demo settings (INTERFACE.md sections 6 to 10).
MIN_STAKE = 8 * ETHER // 10  # 0.8 ETH
PROVIDER_STAKE = 1 * ETHER  # each provider registers with 1 ETH

# Field order of ReplicatedMarket.Params.
DEMO_PARAMS = (
    300,  # acceptWindow
    600,  # computeWindow (+ secondsPerItem x N)
    300,  # decideWindow
    600,  # checkWindow (+ secondsPerItem x range size)
    300,  # revealWindow
    300,  # publishWindow
    300,  # disputeWindow (similar tasks: the client reviews the results)
    600,  # tiebreakWindow (+ secondsPerItem x mismatched items)
    2 * ETHER // 1000,  # tiebreakFee 0.002 ETH
    3000,  # wrongSlashBps
    1000,  # missedSlashBps
    500,  # checkMissedSlashBps
    0,  # maxMismatch
    2,  # numVerifiers
)
NUM_VERIFIERS = DEMO_PARAMS[-1]

# Field order of CheckedMarket.Params.
CHECKED_PARAMS = (
    300,  # acceptWindow
    300,  # workWindow (+ secondsPerItem x N)
    1000,  # missedSlashBps
)

# Verification modes and the market contract that implements each.
MARKET_CONTRACTS = {"replicated": "ReplicatedMarket", "checked": "CheckedMarket"}
MODES = tuple(MARKET_CONTRACTS)

# Account roles for anvil's default mnemonic (INTERFACE.md section 1).
DEPLOYER_INDEX = 0
CLIENT_INDEX = 1
PROVIDER_NAMES = ["A", "B", "C", "D", "E", "F"]
PROVIDER_INDICES = {name: 2 + i for i, name in enumerate(PROVIDER_NAMES)}


# ---------------------------------------------------------------------------
# Enums mirrored from the contracts
# ---------------------------------------------------------------------------

# ReplicatedMarket

class Status(IntEnum):
    NONE = 0
    OPEN = 1
    COMMITTING = 2
    DECIDING = 3
    CHECKING = 4
    CHECK_REVEAL = 5
    PUBLISHING = 6
    DISPUTING = 7
    TIE_BREAK = 8
    CLOSED = 9


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
    DISPUTE_REJECTED = 11


class Compare(IntEnum):
    EXACT = 0
    SIMILAR = 1


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


# CheckedMarket

class CheckedStatus(IntEnum):
    NONE = 0
    OPEN = 1
    WORKING = 2
    CLOSED = 3


class CheckedOutcome(IntEnum):
    NONE = 0
    CANCELLED = 1
    DELIVERED = 2
    MAIN_MISSED = 3


class CheckedStat(IntEnum):
    COMPLETED = 0
    MISSED = 1
    ITEMS_SOLVED = 2
    ITEMS_NOT_FOUND = 3


class JobRef(NamedTuple):
    """A job is identified by its market's mode and its id in that market ("checked:1")."""

    mode: str
    id: int

    def __str__(self) -> str:
        return f"{self.mode}:{self.id}"

    @classmethod
    def parse(cls, s: str) -> "JobRef":
        mode, _, num = s.partition(":")
        if mode not in MODES or not num.isdigit():
            raise ValueError(f"expected <mode>:<id> with mode in {MODES}, got {s!r}")
        return cls(mode, int(num))


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
    Runs ``forge build`` once if the artifact is missing (after editing a contract,
    run ``forge build`` yourself: an existing artifact is never rebuilt here)."""
    matches = sorted(OUT_DIR.glob(f"*.sol/{name}.json"))
    if not matches:
        subprocess.run(["forge", "build"], cwd=CONTRACTS_DIR, check=True, stdout=subprocess.DEVNULL)
        matches = sorted(OUT_DIR.glob(f"*.sol/{name}.json"))
    if not matches:
        raise FileNotFoundError(f"no artifact for contract {name!r} in {OUT_DIR}")
    data = json.loads(matches[0].read_text())
    return data["abi"], data["bytecode"]["object"]


# ---------------------------------------------------------------------------
# Chain: Web3 + contracts + helpers
# ---------------------------------------------------------------------------

class TxFailed(RuntimeError):
    """A transaction reverted (the message is the revert reason when known)."""


class Chain:
    """A Web3 connection with the DeGPU contracts attached."""

    def __init__(self, rpc_url: str, registry_address: str | None = None):
        self.rpc_url = rpc_url
        self.w3 = Web3(Web3.HTTPProvider(rpc_url, request_kwargs={"timeout": 60}))
        if not self.w3.is_connected():
            raise RuntimeError(f"cannot reach {rpc_url}")
        self.registry_abi, self.registry_bytecode = load_artifact("ProviderRegistry")
        self.market_artifacts = {mode: load_artifact(name) for mode, name in MARKET_CONTRACTS.items()}
        self.registry = None
        self.markets: dict[str, Any] = {}
        self._tag: str | None = None
        self._task_ids: dict[str, int] = {}
        # wei of gas paid by each account through ``send`` (for net-of-gas checks)
        self.gas_spent: dict[str, int] = defaultdict(int)
        # per mode: topic0 -> event name, to decode raw market logs
        self._topics = {
            mode: {event_abi_to_log_topic(e): e["name"] for e in abi if e["type"] == "event"}
            for mode, (abi, _) in self.market_artifacts.items()
        }
        if registry_address:
            self.attach(registry_address)

    # -- setup ---------------------------------------------------------------

    @property
    def accounts(self) -> list[str]:
        """anvil's unlocked accounts (default mnemonic)."""
        return list(self.w3.eth.accounts)

    def attach(self, registry_address: str) -> None:
        """Use already-deployed contracts: the registry, and every market it lists (by mode)."""
        self._tag = None
        self._task_ids = {}
        self.registry = self.w3.eth.contract(
            address=Web3.to_checksum_address(registry_address), abi=self.registry_abi, decode_tuples=True
        )
        self.markets = {}
        mode_abi = [{"type": "function", "name": "mode", "stateMutability": "pure", "inputs": [],
                     "outputs": [{"name": "", "type": "string"}]}]
        for i in range(self.registry.functions.marketCount().call()):
            addr = self.registry.functions.marketAt(i).call()
            mode = self.w3.eth.contract(address=addr, abi=mode_abi).functions.mode().call()
            if mode in self.market_artifacts:
                abi = self.market_artifacts[mode][0]
                self.markets[mode] = self.w3.eth.contract(address=addr, abi=abi, decode_tuples=True)

    def deploy(self, owner: str | None = None, tasks=None) -> None:
        """Deploy the registry and one market per mode with the demo parameters, link them and
        register ``tasks`` (default: every installed task) in their modes' markets."""
        from degpu.tasks import all_tasks

        owner = owner or self.accounts[DEPLOYER_INDEX]
        registry_address = self._deploy_contract(self.registry_abi, self.registry_bytecode, [MIN_STAKE], owner)
        params = {"replicated": DEMO_PARAMS, "checked": CHECKED_PARAMS}
        market_addresses = []
        for mode, (abi, bytecode) in self.market_artifacts.items():
            market_addresses.append(self._deploy_contract(abi, bytecode, [registry_address, params[mode]], owner))
        registry = self.w3.eth.contract(address=registry_address, abi=self.registry_abi)
        for addr in market_addresses:
            self.send(registry.functions.addMarket(addr), owner)
        self.attach(registry_address)
        for task in (all_tasks().values() if tasks is None else tasks):
            self.register_task(task, owner)

    def register_task(self, task, owner: str | None = None) -> int:
        """Owner only: add ``task`` to its mode's market. Returns its task-type id."""
        owner = owner or self.accounts[DEPLOYER_INDEX]
        market = self.markets[task.mode]
        if task.mode == "replicated":
            compare = Compare.SIMILAR if task.compare == "similar" else Compare.EXACT
            fn = market.functions.addTaskType(task.runner_hash(), task.name, task.seconds_per_item, int(compare))
        elif task.mode == "checked":
            abi, bytecode = load_artifact(task.checker_contract)
            checker = self._deploy_contract(abi, bytecode, [], owner)
            fn = market.functions.addTaskType(checker, task.name, task.seconds_per_item)
        else:
            raise ValueError(f"unknown mode {task.mode!r}")
        self.send(fn, owner)
        task_id = market.functions.taskTypeCount().call()
        self._task_ids[task.name] = task_id
        return task_id

    def _deploy_contract(self, abi, bytecode, args, owner: str) -> str:
        factory = self.w3.eth.contract(abi=abi, bytecode=bytecode)
        return self._wait(factory.constructor(*args).transact({"from": owner}), owner)["contractAddress"]

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
        """registry.getProvider(addr) as a named tuple (registered, stake, encPubKey, locks)."""
        return self.registry.functions.getProvider(addr).call()

    def stake(self, addr: str) -> int:
        return self.provider(addr).stake

    def price_of(self, addr: str, mode: str, task_id: int) -> int:
        """Wei per item ``addr`` charges for task type ``task_id`` of the ``mode`` market (0 = not offered)."""
        return self.registry.functions.priceOf(addr, self.markets[mode].address, task_id).call()

    def stat(self, addr: str, mode: str, s: int) -> int:
        """Reputation counter ``s`` (a ``Stat`` / ``CheckedStat``) that the ``mode`` market keeps for ``addr``."""
        return self.registry.functions.statOf(addr, self.markets[mode].address, int(s)).call()

    def job(self, mode: str, job_id: int):
        """market.getJob(jobId) of the ``mode`` market as a named tuple (job.status, ...)."""
        return self.markets[mode].functions.getJob(job_id).call()

    def range_of(self, job_id: int, slot: int) -> tuple[int, int]:
        """Items [start, end) covered by verifier ``slot`` of a replicated job."""
        start, end = self.markets["replicated"].functions.rangeOf(job_id, slot).call()
        return start, end

    def task_type(self, mode: str, task_id: int):
        """taskTypeOf(id) of the ``mode`` market: (runnerHash, name, secondsPerItem, compare) for
        the replicated market, (checker, name, secondsPerItem) for the checked one."""
        return self.markets[mode].functions.taskTypeOf(task_id).call()

    def task_id(self, name: str) -> int | None:
        """On-chain id of the task type called ``name`` in its mode's market (None if not registered)."""
        if name not in self._task_ids:
            from degpu.tasks import get

            market = self.markets[get(name).mode]
            for tid in range(1, market.functions.taskTypeCount().call() + 1):
                self._task_ids.setdefault(market.functions.taskTypeOf(tid).call()[1], tid)
        return self._task_ids.get(name)

    # -- events --------------------------------------------------------------

    def events(self, mode: str, from_block: int = 0, to_block: int | str = "latest",
               job_id: int | None = None) -> list:
        """All job events of the ``mode`` market in [from_block, to_block], decoded, in chain order.
        Each item is web3 EventData: ``ev["event"]``, ``ev["args"]``, ``ev["blockNumber"]``...
        With ``job_id`` only that job's events are returned (jobId is the first indexed topic
        of every job event). Events without a jobId (e.g. TaskTypeAdded) are left out."""
        market = self.markets[mode]
        flt: dict[str, Any] = {"address": market.address, "fromBlock": from_block, "toBlock": to_block}
        if job_id is not None:
            flt["topics"] = [None, "0x" + job_id.to_bytes(32, "big").hex()]
        out = []
        for log in self.w3.eth.get_logs(flt):
            name = self._topics[mode].get(bytes(log["topics"][0]))
            if name is None:
                continue
            ev = market.events[name]().process_log(log)
            if "jobId" in ev["args"]:
                out.append(ev)
        return out

    def tag(self) -> str:
        """Identifies this chain + deployment (genesis hash and registry address), so
        state files written against an earlier anvil run can be recognised and reset."""
        if self._tag is None:
            genesis = self.w3.eth.get_block(0)["hash"]
            self._tag = f"{bytes(genesis).hex()}:{self.registry.address}"
        return self._tag


def _revert_reason(e: ContractLogicError) -> str:
    msg = str(e.args[0]) if e.args else str(e)
    return msg.removeprefix("execution reverted: ")


def start_local_chain(port: int | None = None, tasks=None) -> tuple[Anvil, Chain]:
    """Start a fresh anvil and deploy everything (``tasks``: default every installed task).
    Returns (anvil, chain)."""
    anvil = Anvil(port=port).start()
    try:
        chain = Chain(anvil.rpc_url)
        chain.deploy(tasks=tasks)
    except Exception:
        anvil.stop()
        raise
    return anvil, chain


def main() -> None:
    from degpu.tasks import all_tasks

    ap = argparse.ArgumentParser(description="Start anvil with the DeGPU contracts deployed.")
    ap.add_argument("--port", type=int, default=8545)
    args = ap.parse_args()
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))  # run the cleanup on `kill` too
    anvil, chain = start_local_chain(port=args.port)
    print(f"anvil      {anvil.rpc_url}")
    print(f"registry   {chain.registry.address}   (pass this as --registry)")
    for mode, market in chain.markets.items():
        print(f"{mode:<10} {market.address}")
    for name, task in all_tasks().items():
        print(f"task       {name} ({task.mode}, id {chain.task_id(name)})")
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
