"""Base classes for the off-chain side of a verification mode.

A mode is one market contract (ReplicatedMarket, CheckedMarket...) plus two drivers here:

* a ``ProviderDriver``, run by every ``ProviderAgent``: it scans the market's events for jobs the
  agent takes part in and performs the agent's next action in each;
* a ``ClientDriver``, run by the ``Client``: it posts jobs to the market, performs the client's
  actions while a job runs and reads the results.

The agent and the client are thin shells (wallet, keys, store, saved state) that hand each job
to the driver of its mode. Adding a job type never touches this layer; adding a verification
mode means writing one market contract and these two drivers.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from degpu.chain import JobRef, TxFailed
from degpu.storage import StoreUnavailable

if TYPE_CHECKING:
    from degpu.agent import ProviderAgent
    from degpu.client import Client


class ProviderDriver:
    """A provider's side of one market. Subclasses set ``mode`` and ``closed_status`` and
    implement ``on_event`` and ``act``."""

    mode: str = ""
    closed_status: int = 0

    def __init__(self, agent: "ProviderAgent"):
        self.agent = agent
        self.chain = agent.chain
        self.market = agent.chain.markets[self.mode]

    @property
    def jobs(self) -> dict[int, dict]:
        """jobId -> JSON-able per-job state (role, secrets, progress flags), saved by the agent."""
        return self.agent.jobs[self.mode]

    def log(self, job_id: int, msg: str) -> None:
        self.agent.log(f"job {JobRef(self.mode, job_id)}: {msg}")

    def step(self) -> bool:
        """Process new events, then act on every open job. Returns True if anything was done."""
        progressed = self._scan()
        for job_id, st in sorted(self.jobs.items()):
            if st.get("closed") or st.get("error"):
                continue
            # Several actions can follow each other at once (e.g. accept, compute, commit).
            for _ in range(5):
                job = self.chain.job(self.mode, job_id)
                if job.status == self.closed_status:
                    st["closed"] = True
                    self.forget(job_id)
                    break
                try:
                    did = self.act(job_id, st, job)
                except TxFailed as e:
                    self.log(job_id, f"transaction failed: {e}")
                    did = False
                except StoreUnavailable as e:  # a network hiccup: try again on the next step
                    self.log(job_id, str(e))
                    did = False
                except Exception as e:  # e.g. the task's code cannot handle an item
                    st["error"] = f"{type(e).__name__}: {e}"
                    self.log(job_id, f"giving up on this job: {st['error']}")
                    did = False
                if not did:
                    break
                progressed = True
        return progressed

    def _scan(self) -> bool:
        latest = self.chain.block_number()
        start = self.agent.next_block[self.mode]
        if latest < start:
            return False
        found = False
        for ev in self.chain.events(self.mode, start, latest):
            found |= bool(self.on_event(ev["event"], ev["args"]))
        self.agent.next_block[self.mode] = latest + 1
        return found

    def on_event(self, name: str, args) -> bool:
        """Record a job (or a payload) that concerns this agent. Returns True if it did."""
        raise NotImplementedError

    def act(self, job_id: int, st: dict, job) -> bool:
        """Do this agent's next action in the job, if any. Returns True if it did something."""
        raise NotImplementedError

    def forget(self, job_id: int) -> None:
        """Drop in-memory caches of a closed job."""


class ClientDriver:
    """The client's side of one market. Subclasses set ``mode``, ``closed_status`` and
    ``outcome_names`` and implement ``post``, ``act`` and ``results``."""

    mode: str = ""
    closed_status: int = 0
    outcome_names: type = int

    def __init__(self, client: "Client"):
        self.client = client
        self.chain = client.chain
        self.market = client.chain.markets[self.mode]

    @property
    def jobs(self) -> dict[int, dict]:
        """jobId -> JSON-able per-job state (secrets, progress flags), saved by the client."""
        return self.client.jobs[self.mode]

    def log(self, job_id: int, msg: str) -> None:
        self.client.log(f"job {JobRef(self.mode, job_id)}: {msg}")

    def step(self) -> bool:
        """Do the client's next action in every open job. Returns True if anything was done."""
        did = False
        for job_id, st in sorted(self.jobs.items()):
            if "outcome" in st:
                continue
            job = self.chain.job(self.mode, job_id)
            if job.status == self.closed_status:
                st["outcome"] = int(job.outcome)
                self.log(job_id, f"closed, outcome {self.outcome_names(job.outcome).name}")
                did = True
            else:
                did |= bool(self.act(job_id, st, job))
        return did

    def _job_id_from(self, receipt) -> int:
        for log in receipt["logs"]:
            if log["address"] != self.market.address:
                continue
            ev = self.market.events.JobCreated().process_log(log)
            return ev["args"]["jobId"]
        raise RuntimeError("no JobCreated event in the receipt")

    @staticmethod
    def add_cli_args(parser) -> None:
        """Add this mode's posting options to ``client post <task>``."""

    @staticmethod
    def options_from(args) -> dict:
        """The ``post`` options parsed by ``add_cli_args``."""
        return {}

    def post(self, task, main: str, inputs, **options) -> int:
        """Create a job for ``task`` with main provider ``main``; returns its id in this market."""
        raise NotImplementedError

    def act(self, job_id: int, st: dict, job) -> bool:
        """Do the client's next action in the job, if any."""
        return False

    def results(self, job_id: int) -> list:
        """The job's results, one user-facing value per item (via the task's ``present``)."""
        raise NotImplementedError
