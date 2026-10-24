"""DeGPU client: posts jobs of any installed task type and collects the results.

A ``Client`` is a thin shell around one account: the shared store, display names for logs, and
its saved per-job secrets. It hands each job to the driver of its task's verification mode
(``degpu/modes/``):

* replicated tasks (``degpu/modes/replicated.py``): encrypt and upload the inputs, commit to a
  secret verify yes/no and deposit 2 x price; later reveal the decision, share each verifier's
  range and the tie-break items, and decode the published leaves;
* checked tasks (``degpu/modes/checked.py``): post the (public) items with N x price and read
  the checked answers.

``post`` returns a ``JobRef`` such as ``checked:1`` (job ids are numbered per market).

CLI (accounts are anvil's unlocked accounts; the client is index 1). ``post`` has one
subcommand per installed task, with the task's own flags:

    uv run python -m degpu.client --registry 0x... post image-classify-v1 --main A --limit 20 --verify --wait
    uv run python -m degpu.client --registry 0x... post nonce-search-v1 --main A --puzzles 10 --wait
    uv run python -m degpu.client --registry 0x... results replicated:1
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Callable

from degpu.chain import CLIENT_INDEX, MODES, PROVIDER_INDICES, REPO_ROOT, Chain, JobRef
from degpu.modes import CLIENT_DRIVERS
from degpu.storage import Store
from degpu.tasks import Task, all_tasks, get

STATE_DIR = REPO_ROOT / ".degpu-state"


class Client:
    """A client account that posts jobs and follows them until they close."""

    def __init__(
        self,
        chain: Chain,
        account: str,
        *,
        store: Store | None = None,
        name: str = "client",
        state_path: str | os.PathLike | None = None,
        log: Callable[[str], None] = print,
        names: dict[str, str] | None = None,
    ):
        self.chain = chain
        self.account = account
        self.store = store or Store()
        self.name = name
        self.state_path = Path(state_path) if state_path else None
        self._log = log
        self.names = names if names is not None else {}  # address -> display name, for logs
        # mode -> jobId -> JSON-able secrets and progress
        self.jobs: dict[str, dict[int, dict]] = {mode: {} for mode in MODES}
        self.drivers = {mode: CLIENT_DRIVERS[mode](self) for mode in MODES if mode in chain.markets}
        if self.state_path and self.state_path.exists():
            data = json.loads(self.state_path.read_text())
            if data.get("chain") == chain.tag():  # ignore state from an earlier chain
                for mode, jobs in data["jobs"].items():
                    if mode in self.jobs:
                        self.jobs[mode] = {int(k): v for k, v in jobs.items()}

    def log(self, msg: str) -> None:
        self._log(f"[{self.name}] {msg}")

    def nm(self, addr: str) -> str:
        return self.names.get(addr, addr[:10])

    # ------------------------------------------------------------------
    # Jobs
    # ------------------------------------------------------------------

    def post(self, task: Task | str, main: str, inputs, **options) -> JobRef:
        """Post a job of ``task`` (a Task or its name) to provider ``main``. ``inputs`` is what the
        task's ``prepare`` returns; ``options`` are the mode's (e.g. ``verify=True`` for a
        replicated task)."""
        task = get(task) if isinstance(task, str) else task
        job_id = self.drivers[task.mode].post(task, main, inputs, **options)
        self._save_state()
        return JobRef(task.mode, job_id)

    def step(self) -> bool:
        """Do the client's next action in every open job. Returns True if anything was done."""
        did = False
        for driver in self.drivers.values():
            did |= driver.step()
        if did:
            self._save_state()
        return did

    def results(self, ref: JobRef) -> list:
        """One user-facing value per item (via the task's ``present``)."""
        return self.drivers[ref.mode].results(ref.id)

    def outcome(self, ref: JobRef) -> int | None:
        """The job's outcome once ``step`` has seen it close, else None."""
        return self.jobs[ref.mode].get(ref.id, {}).get("outcome")

    def expire(self, ref: JobRef) -> dict:
        """Call expire() on a job whose phase deadline has passed."""
        r = self.chain.send(self.chain.markets[ref.mode].functions.expire(ref.id), self.account)
        self.log(f"job {ref}: called expire()")
        return r

    def cancel(self, ref: JobRef) -> dict:
        r = self.chain.send(self.chain.markets[ref.mode].functions.cancel(ref.id), self.account)
        self.log(f"job {ref}: cancelled")
        return r

    def _save_state(self) -> None:
        if not self.state_path:
            return
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.state_path.with_suffix(".tmp")
        jobs = {mode: {str(k): v for k, v in js.items()} for mode, js in self.jobs.items()}
        tmp.write_text(json.dumps({"chain": self.chain.tag(), "jobs": jobs}, indent=1))
        os.replace(tmp, self.state_path)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _resolve_main(chain: Chain, main: str) -> str:
    """A provider letter A-F (anvil accounts 2-7) or an address."""
    if main.upper() in PROVIDER_INDICES:
        return chain.accounts[PROVIDER_INDICES[main.upper()]]
    return chain.w3.to_checksum_address(main)


def main() -> int:
    ap = argparse.ArgumentParser(description="DeGPU client")
    ap.add_argument("--index", type=int, default=CLIENT_INDEX, help="anvil account index (default 1)")
    ap.add_argument("--rpc", default="http://127.0.0.1:8545")
    ap.add_argument("--registry", required=True, help="ProviderRegistry address (printed by degpu.chain)")
    ap.add_argument("--state-dir", default=str(STATE_DIR), help="where to keep the job secrets")
    sub = ap.add_subparsers(dest="cmd", required=True)

    post = sub.add_parser("post", help="post a job").add_subparsers(dest="task", required=True, metavar="TASK")
    for name, task in all_tasks().items():
        p = post.add_parser(name, help=f"{task.description} ({task.mode})")
        p.add_argument("--main", required=True, help="provider letter A-F or address")
        p.add_argument("--wait", action="store_true", help="keep watching until the job closes")
        CLIENT_DRIVERS[task.mode].add_cli_args(p)
        task.add_cli_args(p)

    sub.add_parser("watch", help="do the client's part in every open job until interrupted")
    for name in ("results", "status", "expire", "cancel"):
        q = sub.add_parser(name)
        q.add_argument("job", type=JobRef.parse, help="<mode>:<id>, as printed by post (e.g. checked:1)")
    args = ap.parse_args()

    chain = Chain(args.rpc, registry_address=args.registry)
    account = chain.accounts[args.index]
    client = Client(chain, account, state_path=Path(args.state_dir) / f"client-{account}.json")

    if args.cmd == "post":
        task = get(args.task)
        options = CLIENT_DRIVERS[task.mode].options_from(args)
        ref = client.post(task, _resolve_main(chain, args.main), task.prepare(args), **options)
        print(ref)
        if args.wait:
            while client.outcome(ref) is None:
                client.step()
                time.sleep(1)
            try:
                print(json.dumps(client.results(ref)))
            except LookupError as e:
                print(e)
    elif args.cmd == "watch":
        try:
            while True:
                client.step()
                time.sleep(1)
        except KeyboardInterrupt:
            pass
    elif args.cmd == "results":
        print(json.dumps(client.results(args.job)))
    elif args.cmd == "status":
        job = chain.job(args.job.mode, args.job.id)
        driver = client.drivers[args.job.mode]
        status = type(driver.closed_status)(job.status).name
        print(f"{args.job}: status {status}, outcome {driver.outcome_names(job.outcome).name}, main {job.main}")
    elif args.cmd == "expire":
        client.expire(args.job)
    elif args.cmd == "cancel":
        client.cancel(args.job)
    return 0


if __name__ == "__main__":
    sys.exit(main())
