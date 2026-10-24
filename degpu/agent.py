"""DeGPU provider agent: the program a GPU provider runs.

A ``ProviderAgent`` is a thin shell around one account: its X25519 keypair, the shared store,
its demo behaviour, its saved per-job state, and the task types it offers (by default every
task installed under ``degpu/tasks/``). ``register()`` stakes, publishes the key and offers each
task at its default price. Each ``step()`` hands over to one driver per verification mode
(``degpu/modes/``), which scans that market's events for jobs the agent takes part in and does
the agent's next action in each:

* replicated mode: main provider, verifier or tie-breaker (``degpu/modes/replicated.py``);
* checked mode: main provider solving puzzles (``degpu/modes/checked.py``).

Behaviours (for the demo): ``honest``; ``cheat`` (as main: fakes a fraction of its results,
default 0.2, in the replicated mode, and makes up every answer in the checked mode); ``liar``
(as replicated verifier only, submits random results); ``offline`` (accepts as main, then never
acts again).

Per-job secrets live in memory. The CLI daemon also persists them, together with the agent's
keypair, in ``.degpu-state/<address>.json``:

    uv run python -m degpu.agent --index 2 --behavior honest --registry 0x...
"""

from __future__ import annotations

import argparse
import json
import os
import random
import time
from pathlib import Path
from typing import Callable

from degpu import crypto
from degpu.chain import MODES, PROVIDER_STAKE, REPO_ROOT, Chain
from degpu.modes import PROVIDER_DRIVERS
from degpu.storage import Store
from degpu.tasks import Task, all_tasks

BEHAVIORS = ("honest", "cheat", "liar", "offline")
STATE_DIR = REPO_ROOT / ".degpu-state"


def _hex(b: bytes) -> str:
    return "0x" + bytes(b).hex()


def _unhex(s: str) -> bytes:
    return bytes.fromhex(s.removeprefix("0x"))


class ProviderAgent:
    """One provider. Call ``register()`` once, then ``step()`` repeatedly."""

    def __init__(
        self,
        chain: Chain,
        account: str,
        behavior: str = "honest",
        *,
        name: str | None = None,
        store: Store | None = None,
        cheat_fraction: float = 0.2,
        keypair: tuple[bytes, bytes] | None = None,
        state_path: str | os.PathLike | None = None,
        log: Callable[[str], None] = print,
        rng: random.Random | None = None,
        tasks: list[str] | None = None,
    ):
        if behavior not in BEHAVIORS:
            raise ValueError(f"unknown behavior {behavior!r}; choose from {BEHAVIORS}")
        self.chain = chain
        self.account = account
        self.behavior = behavior
        self.name = name or account[:8]
        self.store = store or Store()
        self.cheat_fraction = cheat_fraction
        self.priv, self.pub = keypair or crypto.generate_keypair()
        self.state_path = Path(state_path) if state_path else None
        self._log = log
        self.rng = rng or random.Random()
        installed = all_tasks()
        unknown = set(tasks or []) - set(installed)
        if unknown:
            raise ValueError(f"unknown tasks {sorted(unknown)}; installed: {', '.join(installed)}")
        #: the tasks this agent offers and can run, by name
        self.tasks: dict[str, Task] = {n: t for n, t in installed.items() if tasks is None or n in tasks}

        # mode -> jobId -> JSON-able per-job state; mode -> first block whose events are unprocessed
        self.jobs: dict[str, dict[int, dict]] = {mode: {} for mode in MODES}
        self.next_block: dict[str, int] = {mode: 0 for mode in MODES}
        self.drivers = {mode: PROVIDER_DRIVERS[mode](self) for mode in MODES if mode in chain.markets}
        self._task_names: dict[tuple[str, int], str] = {}

        if self.state_path and self.state_path.exists():
            self._load_state()

    def log(self, msg: str) -> None:
        self._log(f"[{self.name}] {msg}")

    # ------------------------------------------------------------------
    # Registration and offers
    # ------------------------------------------------------------------

    def register(self, stake: int = PROVIDER_STAKE, prices: dict[str, int] | None = None) -> None:
        """Register with ``stake`` wei (or update the on-chain key if already registered), then
        offer every task of this agent that is deployed on the chain, at ``prices[name]`` or the
        task's default price."""
        p = self.chain.provider(self.account)
        reg = self.chain.registry.functions
        if not p.registered:
            self.chain.send(reg.register(self.pub), self.account, value=stake)
            self.log(f"registered: stake {stake / 1e18:g} ETH")
        elif bytes(p.encPubKey) != self.pub:
            self.chain.send(reg.setEncPubKey(self.pub), self.account)
            self.log("updated encPubKey")
        offered = []
        for name, task in self.tasks.items():
            task_id = self.chain.task_id(name)
            if task_id is None or task.mode not in self.chain.markets:
                continue  # not deployed on this chain
            price = (prices or {}).get(name, task.default_price)
            if self.chain.price_of(self.account, task.mode, task_id) != price:
                market = self.chain.markets[task.mode].address
                self.chain.send(reg.setPrice(market, task_id, price), self.account)
            offered.append(f"{name} at {price / 1e18:g} ETH/item")
        if offered:
            self.log("offers " + ", ".join(offered))
        self._save_state()

    def task_for(self, mode: str, task_id: int) -> Task | None:
        """The local task behind task type ``task_id`` of the ``mode`` market, if this agent offers it."""
        key = (mode, int(task_id))
        if key not in self._task_names:
            self._task_names[key] = self.chain.task_type(mode, task_id)[1]
        task = self.tasks.get(self._task_names[key])
        return task if task is not None and task.mode == mode else None

    # ------------------------------------------------------------------
    # Main loop
    # ------------------------------------------------------------------

    def step(self) -> bool:
        """Let every mode driver process new events and act on its open jobs.
        Returns True if anything was done."""
        progressed = False
        for driver in self.drivers.values():
            progressed |= driver.step()
        if progressed:
            self._save_state()
        return progressed

    # ------------------------------------------------------------------
    # Persistence (CLI daemon)
    # ------------------------------------------------------------------

    def _save_state(self) -> None:
        if not self.state_path:
            return
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        data = {
            "chain": self.chain.tag(),
            "address": self.account,
            "priv": _hex(self.priv),
            "pub": _hex(self.pub),
            "next_block": self.next_block,
            "jobs": {mode: {str(k): v for k, v in jobs.items()} for mode, jobs in self.jobs.items()},
        }
        tmp = self.state_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=1))
        os.replace(tmp, self.state_path)

    def _load_state(self) -> None:
        data = json.loads(self.state_path.read_text())
        self.priv, self.pub = _unhex(data["priv"]), _unhex(data["pub"])
        if data.get("chain") != self.chain.tag():
            return  # written against another chain: keep the keypair, forget the jobs
        self.next_block.update(data.get("next_block", {}))
        for mode, jobs in data.get("jobs", {}).items():
            if mode in self.jobs:
                self.jobs[mode] = {int(k): v for k, v in jobs.items()}


# ---------------------------------------------------------------------------
# CLI daemon
# ---------------------------------------------------------------------------

def main() -> None:
    ap = argparse.ArgumentParser(description="Run a DeGPU provider agent against a running chain.")
    ap.add_argument("--index", type=int, required=True, help="anvil account index (providers are 2-7)")
    ap.add_argument("--behavior", default="honest", choices=BEHAVIORS)
    ap.add_argument("--cheat-fraction", type=float, default=0.2)
    ap.add_argument("--tasks", help="comma-separated task names to offer (default: every installed task)")
    ap.add_argument("--rpc", default="http://127.0.0.1:8545")
    ap.add_argument("--registry", required=True, help="ProviderRegistry address (printed by degpu.chain)")
    ap.add_argument("--poll", type=float, default=1.0, help="seconds between steps")
    ap.add_argument("--state-dir", default=str(STATE_DIR), help="where to keep the keypair and job secrets")
    args = ap.parse_args()

    chain = Chain(args.rpc, registry_address=args.registry)
    account = chain.accounts[args.index]
    agent = ProviderAgent(
        chain,
        account,
        args.behavior,
        name=f"agent {args.index}",
        cheat_fraction=args.cheat_fraction,
        state_path=Path(args.state_dir) / f"{account}.json",
        log=lambda msg: print(msg, flush=True),  # show up in redirected logs right away
        tasks=args.tasks.split(",") if args.tasks else None,
    )
    agent.register()
    agent.log(f"{account} running as {args.behavior}; state in {agent.state_path}")
    try:
        while True:
            agent.step()
            time.sleep(args.poll)
    except KeyboardInterrupt:
        agent.log("stopped")


if __name__ == "__main__":
    main()
