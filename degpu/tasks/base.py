"""The interface every DeGPU job type implements (see docs/ADDING_A_JOB_TYPE.md).

A job type ("task") is one folder under ``degpu/tasks/`` whose ``task.py`` defines ``TASK``,
an instance of a subclass of one of the two classes below. The class you subclass picks the
task's **verification mode**, i.e. which market contract runs its jobs:

* ``ReplicatedTask`` -> ``ReplicatedMarket``: the platform checks work by re-running it on
  randomly drawn providers and comparing hashes. For tasks with deterministic results per item
  (ML inference, rendering...). Results come back as salted 32-byte words.
* ``CheckedTask`` -> ``CheckedMarket``: a checker contract verifies each answer on-chain. For
  puzzles that are hard to solve and cheap to check (mining, key search...).

Everything else (deployment, the provider agents, the client CLI, the demo plumbing) finds a
task through ``degpu.tasks.all_tasks()``; nothing outside the task's folder (and, for a checked
task, its checker contract) needs editing.
"""

from __future__ import annotations

import argparse
import random
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from degpu.crypto import keccak

ETHER = 10**18


class Task:
    """Fields and hooks common to every task. Subclass ``ReplicatedTask`` or ``CheckedTask``."""

    #: on-chain task-type name, e.g. "image-classify-v1"; bump the suffix for incompatible changes
    name: str = ""
    #: "replicated" or "checked"; set by the subclass you derive from
    mode: str = ""
    #: wei per item an agent offers by default (``ProviderRegistry.setPrice``)
    default_price: int = ETHER // 10_000
    #: extra deadline seconds per item a phase must process (registered on-chain)
    seconds_per_item: int = 1
    #: one line for ``client post --help`` and the demo
    description: str = ""
    #: the task's folder; filled in by the task registry
    folder: Path

    def add_cli_args(self, parser: argparse.ArgumentParser) -> None:
        """Add this task's flags to ``client post --task <name>``."""

    def prepare(self, args: argparse.Namespace):
        """Client side: turn the parsed CLI flags into this task's job inputs."""
        raise NotImplementedError

    def example_inputs(self):
        """A few small job inputs for the conformance tests (tests/test_tasks.py), in the same form
        ``prepare`` returns; None if they aren't available (e.g. assets not downloaded)."""
        raise NotImplementedError

    def __repr__(self) -> str:
        return f"<{type(self).__name__} {self.name}>"


# ---------------------------------------------------------------------------
# Replicated mode
# ---------------------------------------------------------------------------

@dataclass
class ReplicatedInputs:
    """What a replicated job runs on. Every blob is encrypted before it leaves the client."""

    shared: bytes | None  # one blob every provider of the job needs (e.g. the model); None if none
    items: list[bytes]  # one blob per item (e.g. an image file)


class ReplicatedTask(Task):
    """A task checked by re-running it. Implement ``load``, ``run``, ``candidates`` and ``present``.

    Rules (enforced by the conformance tests in tests/test_tasks.py):

    * ``run`` must be deterministic: an item's word may depend only on the shared blob and that
      item, never on other items, the batch size, the machine or the time.
    * Every ``.py`` file in the task's folder is pinned on-chain through ``runner_hash``: a
      provider whose copy differs refuses the job. Any edit therefore needs a new deployment.
    * Each word is exactly 32 bytes. It goes into the leaf
      ``keccak256(abi.encode(jobSalt, i, word))``; the client recovers it by trying every
      word in ``candidates()``, so the set of possible words must be small (say <= 10_000).
    """

    mode = "replicated"

    # -- provider side (pinned) ------------------------------------------------

    def load(self, shared: bytes | None) -> Any:
        """Set up whatever ``run`` needs (e.g. an ONNX session for the model). Called once per job."""
        return shared

    def run(self, state: Any, items: list[bytes]) -> list[bytes]:
        """Compute one 32-byte word per item, in order."""
        raise NotImplementedError

    # -- client side -------------------------------------------------------------

    def candidates(self) -> Iterable[bytes]:
        """Every word ``run`` can return (used to decode the published leaves)."""
        raise NotImplementedError

    def present(self, word: bytes | None) -> Any:
        """Turn a decoded word into a user-facing value (None: the leaf matched no candidate)."""
        return word

    # -- demo behaviours (optional) -----------------------------------------------

    def wrong_output(self, word: bytes, rng: random.Random) -> bytes:
        """A plausible but wrong word, used by the ``cheat`` behaviour."""
        options = [c for c in self._candidate_list() if c != word]
        return rng.choice(options)

    def random_output(self, rng: random.Random) -> bytes:
        """A random word, used by the ``liar`` behaviour."""
        return rng.choice(self._candidate_list())

    # -- provided by the base class ------------------------------------------------

    def runner_hash(self) -> bytes:
        """The on-chain ``runnerHash``: keccak256 over every .py file of the task's folder,
        in sorted path order, of keccak256(relative path) || keccak256(file bytes)."""
        files = sorted(p for p in self.folder.rglob("*.py") if "__pycache__" not in p.parts)
        parts = [keccak(p.relative_to(self.folder).as_posix().encode()) + keccak(p.read_bytes()) for p in files]
        return keccak(b"".join(parts))

    def _candidate_list(self) -> list[bytes]:
        if not hasattr(self, "_candidates_cache"):
            self._candidates_cache = list(self.candidates())
        return self._candidates_cache


# ---------------------------------------------------------------------------
# Checked mode
# ---------------------------------------------------------------------------

class CheckedTask(Task):
    """A task whose answers a checker contract verifies on-chain.
    Implement ``prepare``, ``solve``, ``check`` and ``present``, and write the checker contract.

    Rules (enforced by the conformance tests in tests/test_tasks.py):

    * An item is a ``bytes`` value the checker contract decodes (usually ``abi.encode(...)``).
      Items are public: they are posted on-chain with the job.
    * An answer is exactly 32 bytes.
    * ``check`` is a Python port of the checker contract and must agree with it; pin that with
      a golden vector checked on both sides.
    * ``solve`` returns None when it finds no answer: the provider then isn't paid for that
      item (and isn't slashed). It must never return an answer that ``check`` rejects.
    """

    mode = "checked"

    #: name of the Solidity checker contract (its artifact in contracts/out/), e.g. "NonceChecker"
    checker_contract: str = ""

    # -- provider side -------------------------------------------------------------

    def solve(self, item: bytes) -> bytes | None:
        """Find a 32-byte answer for ``item``, or return None if there is none (in the search space)."""
        raise NotImplementedError

    # -- both sides ----------------------------------------------------------------

    def check(self, item: bytes, answer: bytes) -> bool:
        """Python port of the checker contract."""
        raise NotImplementedError

    # -- client side -----------------------------------------------------------------

    def present(self, item: bytes, answer: bytes | None) -> Any:
        """Turn an item and its answer (None: not found) into a user-facing value."""
        return answer

    # -- demo behaviours (optional) ---------------------------------------------------

    def wrong_answer(self, item: bytes, rng: random.Random) -> bytes:
        """An answer the checker rejects, used by the ``cheat`` behaviour."""
        while True:
            answer = rng.randbytes(32)
            if not self.check(item, answer):
                return answer
