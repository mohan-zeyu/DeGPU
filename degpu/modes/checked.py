"""Off-chain side of the checked mode (CheckedMarket, docs/INTERFACE.md section 8).

There are no verifiers or secrets here: the items are public (posted on-chain with the job) and
the task's checker contract verifies every answer when the main provider submits.

* **Client** (``CheckedClient``): ``createJob`` with the task's items and N x price; read the
  answers from ``ResultsSubmitted`` once the job closes.
* **Main provider** (``CheckedProvider``): on ``JobCreated`` naming it, check it offers the task
  and that the items match the on-chain hash; ``accept``; ``solve`` each item (None = not
  found); ``submitResults``. A wrong answer makes the whole submission revert, so a ``cheat``
  agent (which submits made-up answers) is never paid and ends up missing its deadline.
"""

from __future__ import annotations

from eth_abi import encode as abi_encode

from degpu import crypto
from degpu.chain import ZERO32, CheckedOutcome, CheckedStatus, TxFailed
from degpu.modes.base import ClientDriver, ProviderDriver
from degpu.tasks.base import CheckedTask

MODE = "checked"


def _hex(b: bytes) -> str:
    return "0x" + bytes(b).hex()


def _unhex(s: str) -> bytes:
    return bytes.fromhex(s.removeprefix("0x"))


def items_hash(items: list[bytes]) -> bytes:
    """keccak256(abi.encode(bytes[] items)), as the market stores it."""
    return crypto.keccak(abi_encode(["bytes[]"], [list(items)]))


# ---------------------------------------------------------------------------
# Provider
# ---------------------------------------------------------------------------

class CheckedProvider(ProviderDriver):
    mode = MODE
    closed_status = CheckedStatus.CLOSED

    def on_event(self, name: str, a) -> bool:
        job_id = a["jobId"]
        if name == "JobCreated" and a["main"] == self.agent.account and job_id not in self.jobs:
            self.jobs[job_id] = {"role": "main", "items": [_hex(x) for x in a["items"]]}
            self.log(job_id, f"offered as main ({len(a['items'])} items)")
            return True
        return False

    def act(self, job_id: int, st: dict, job) -> bool:
        m = self.market.functions
        items = [_unhex(x) for x in st["items"]]
        if job.status == CheckedStatus.OPEN:
            if st.get("accepted") or st.get("refused"):
                return False
            task = self.agent.task_for(MODE, job.taskType)
            if task is None:
                st["refused"] = f"task type {job.taskType} is not offered by this agent"
            elif items_hash(items) != bytes(job.itemsHash):
                st["refused"] = "items do not match the on-chain hash"
            if st.get("refused"):
                self.log(job_id, f"refusing: {st['refused']}")
                return False
            try:
                self.chain.send(m.accept(job_id), self.agent.account)
            except TxFailed as e:  # e.g. our stake fell below minStake
                st["refused"] = f"accept failed: {e}"
                self.log(job_id, st["refused"])
                return False
            st["accepted"] = True
            self.log(job_id, "accepted")
            return True

        if (
            job.status != CheckedStatus.WORKING
            or not st.get("accepted")
            or st.get("submitted")
            or st.get("rejected")
        ):
            return False
        if self.agent.behavior == "offline":
            if not st.get("offline"):
                st["offline"] = True
                self.log(job_id, "goes offline")
            return False

        task: CheckedTask = self.agent.task_for(MODE, job.taskType)
        if self.agent.behavior == "cheat":
            answers = [task.wrong_answer(item, self.agent.rng) for item in items]
            found = [True] * len(items)
            self.log(job_id, f"makes up answers for all {len(items)} items")
        else:
            solved = [task.solve(item) for item in items]
            answers = [a if a is not None else ZERO32 for a in solved]
            found = [a is not None for a in solved]
            self.log(job_id, f"solved {sum(found)} of {len(items)} items")
        try:
            self.chain.send(m.submitResults(job_id, items, answers, found), self.agent.account)
        except TxFailed as e:
            st["rejected"] = str(e)
            self.log(job_id, f"submission rejected on-chain: {e}")
            return True
        st["submitted"] = True
        self.log(job_id, "submitted its answers")
        return True


# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------

class CheckedClient(ClientDriver):
    mode = MODE
    closed_status = CheckedStatus.CLOSED
    outcome_names = CheckedOutcome

    def post(self, task: CheckedTask, main: str, inputs: list[bytes], **options) -> int:
        """Create a job with the task's (public) items; deposit N x main's price."""
        if options:
            raise TypeError(f"the checked mode takes no options, got {sorted(options)}")
        items = [bytes(x) for x in inputs]
        if not items:
            raise ValueError("no items")
        task_id = self.chain.task_id(task.name)
        if task_id is None:
            raise ValueError(f"task {task.name} is not registered on this chain")
        value = len(items) * self.chain.price_of(main, MODE, task_id)
        receipt = self.chain.send(self.market.functions.createJob(main, task_id, items), self.client.account,
                                  value=value)
        job_id = self._job_id_from(receipt)
        self.jobs[job_id] = {
            "task": task.name,
            "items": [_hex(x) for x in items],
            "block": receipt["blockNumber"],
            "paid": value,
        }
        self.log(job_id, f"posted {len(items)} {task.name} items to {self.client.nm(main)}, "
                         f"deposit {value / 1e18:g} ETH")
        return job_id

    def results(self, job_id: int) -> list:
        """One value per item from the ResultsSubmitted answers (the task's ``present``; the answer
        is None for items marked not found). Raises LookupError if nothing was submitted."""
        from degpu.tasks import get

        st = self.jobs[job_id]
        task = get(st["task"])
        items = [_unhex(x) for x in st["items"]]
        for ev in self.chain.events(MODE, st.get("block", 0), job_id=job_id):
            if ev["event"] == "ResultsSubmitted":
                answers = [bytes(x) for x in ev["args"]["answers"]]
                found = list(ev["args"]["found"])
                return [task.present(item, a if f else None) for item, a, f in zip(items, answers, found)]
        raise LookupError(f"job {job_id} has no submitted results")
