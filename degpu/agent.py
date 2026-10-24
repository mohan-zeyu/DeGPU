"""DeGPU provider agent: the program a GPU provider runs.

A ``ProviderAgent`` registers in the ProviderRegistry with a stake, a price per
item and its own X25519 public key. Each ``step()`` it

1. polls new JobMarket events to find jobs it takes part in (as main provider
   M, as one of the randomly drawn verifiers or as the tie-breaker T) and to
   pick up the sealed payloads addressed to it, then
2. reads each of its open jobs with ``getJob`` and does the next action of its
   role (docs/INTERFACE.md v2, section 7):

   * **main**: unseal ``k_job``; check the task type's runner hash against the
     local runner; fetch the manifest, check it against ``dataHash`` and check
     every decrypted file against its manifest hash; ``accept``; run all N
     items; ``commitResults`` (always: M never knows whether the job will be
     verified); ``publishResults`` once the job is in the Publishing phase.
   * **verifier**: wait for its ``RangeShared``; unseal it; check the range and
     the inputs (``reportBadInput`` on a mismatch); run its share of the items;
     ``commitCheck``; ``revealCheck`` in the CheckReveal phase.
   * **tie-breaker**: wait for ``TiebreakShared``; unseal it; check the inputs
     (``reportBadInput`` on a mismatch); run only the mismatched items;
     ``submitTiebreak``.

Behaviours (for the demo): ``honest``; ``cheat`` (as main, replaces a fraction
of its labels, default 0.2, with wrong ones); ``liar`` (as verifier only,
submits random labels); ``offline`` (accepts as main, then never acts again).

Per-job secrets live in memory. The CLI daemon also persists them, together
with the agent's keypair, in ``.degpu-state/<address>.json``:

    uv run python -m degpu.agent --index 2 --behavior honest --rpc http://127.0.0.1:8545 --market 0x...
"""

from __future__ import annotations

import argparse
import json
import os
import random
import time
from pathlib import Path
from typing import Callable

from nacl.exceptions import CryptoError

from degpu import crypto
from degpu.chain import (
    PRICE_PER_ITEM,
    PROVIDER_STAKE,
    REPO_ROOT,
    TASK_NAME,
    Chain,
    Status,
    TxFailed,
    VState,
)
from degpu.storage import Store
from degpu.tasks.image_classify_v1.runner import NUM_CLASSES, Runner, runner_hash

BEHAVIORS = ("honest", "cheat", "liar", "offline")
STATE_DIR = REPO_ROOT / ".degpu-state"


def _hex(b: bytes) -> str:
    return "0x" + bytes(b).hex()


def _unhex(s: str) -> bytes:
    return bytes.fromhex(s.removeprefix("0x"))


class InputError(Exception):
    """The inputs a provider received do not match what the job committed to."""


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
        self.local_runner_hash = runner_hash()

        # jobId -> JSON-able per-job state: role, sealed payload, secrets, progress flags
        self.jobs: dict[int, dict] = {}
        self.next_block = 0  # first block whose events are not processed yet
        # in-memory caches (not persisted)
        self._inputs: dict[int, tuple[bytes, dict[int, bytes]]] = {}
        self._runners: dict[bytes, Runner] = {}

        if self.state_path and self.state_path.exists():
            self._load_state()

    # ------------------------------------------------------------------
    # Registration
    # ------------------------------------------------------------------

    def log(self, msg: str) -> None:
        self._log(f"[{self.name}] {msg}")

    def register(self, stake: int = PROVIDER_STAKE, price_per_item: int = PRICE_PER_ITEM) -> None:
        """Register with ``stake`` wei, or update the on-chain key if already registered."""
        p = self.chain.provider(self.account)
        reg = self.chain.registry.functions
        if not p.registered:
            self.chain.send(reg.register(self.pub, price_per_item), self.account, value=stake)
            self.log(f"registered: stake {stake / 1e18:g} ETH, {price_per_item / 1e18:g} ETH/item")
        elif bytes(p.encPubKey) != self.pub:
            self.chain.send(reg.setEncPubKey(self.pub), self.account)
            self.log("updated encPubKey")
        self._save_state()

    # ------------------------------------------------------------------
    # Main loop
    # ------------------------------------------------------------------

    def step(self) -> bool:
        """Process new events, then act on every open job. Returns True if anything was done."""
        self._scan_events()
        progressed = False
        for job_id, st in sorted(self.jobs.items()):
            if st.get("closed") or st.get("error"):
                continue
            # Several actions can follow each other at once (e.g. commitSample then revealSample).
            for _ in range(5):
                job = self.chain.job(job_id)
                if job.status == Status.CLOSED:
                    st["closed"] = True
                    self._inputs.pop(job_id, None)
                    break
                try:
                    did = self._act(job_id, st, job)
                except TxFailed as e:
                    self.log(f"job {job_id}: transaction failed: {e}")
                    did = False
                except Exception as e:  # e.g. the runner cannot decode an image
                    st["error"] = f"{type(e).__name__}: {e}"
                    self.log(f"job {job_id}: giving up on this job: {st['error']}")
                    did = False
                if not did:
                    break
                progressed = True
        if progressed:
            self._save_state()
        return progressed

    def _scan_events(self) -> None:
        latest = self.chain.block_number()
        if latest < self.next_block:
            return
        me = self.account
        found = False
        for ev in self.chain.market_events(self.next_block, latest):
            name, a = ev["event"], ev["args"]
            job_id = a["jobId"]
            # setdefault: a re-scan (e.g. after a daemon restart) never wipes a job's progress
            if name == "JobCreated" and a["main"] == me and job_id not in self.jobs:
                self.jobs[job_id] = {"role": "main", "sealed": _hex(a["sealedForMain"])}
                self.log(f"job {job_id}: offered as main ({a['numItems']} items, verification unknown)")
            elif name == "VerifiersDrawn" and me in a["verifiers"] and job_id not in self.jobs:
                slot = list(a["verifiers"]).index(me)
                self.jobs[job_id] = {"role": "verifier", "slot": slot}
                self.log(f"job {job_id}: drawn as verifier (slot {slot})")
            elif name == "RangeShared" and a["verifier"] == me and job_id in self.jobs:
                self.jobs[job_id].setdefault("sealed", _hex(a["sealedForVerifier"]))
            elif name == "TiebreakStarted" and a["tiebreaker"] == me and job_id not in self.jobs:
                self.jobs[job_id] = {"role": "tiebreaker", "mismatched": list(a["mismatched"])}
                self.log(f"job {job_id}: drawn as tie-breaker ({len(a['mismatched'])} items)")
            elif name == "TiebreakShared" and a["tiebreaker"] == me and job_id in self.jobs:
                self.jobs[job_id].setdefault("sealed", _hex(a["sealedForTiebreaker"]))
            else:
                continue
            found = True
        self.next_block = latest + 1
        if found:
            self._save_state()

    def _act(self, job_id: int, st: dict, job) -> bool:
        role = st["role"]
        if role == "main":
            return self._act_main(job_id, st, job)
        if self.behavior == "offline":
            return False  # an offline provider never answers as verifier or tie-breaker either
        if role == "verifier":
            return self._act_verifier(job_id, st, job)
        if role == "tiebreaker":
            return self._act_tiebreaker(job_id, st, job)
        return False

    # ------------------------------------------------------------------
    # Main provider
    # ------------------------------------------------------------------

    def _act_main(self, job_id: int, st: dict, job) -> bool:
        m = self.chain.market.functions
        if job.status == Status.OPEN:
            if st.get("accepted") or st.get("refused"):
                return False
            try:
                k_job = _unhex(crypto.unseal(self.priv, _unhex(st["sealed"]))["k_job"])
                st["k_job"] = _hex(k_job)
                self._check_runner(job)
                keys = {i: crypto.item_key(k_job, i) for i in range(job.numItems)}
                self._inputs[job_id] = self._load_inputs(job, crypto.model_key(k_job), keys)
            except (InputError, CryptoError, KeyError, ValueError) as e:
                st["refused"] = str(e) or type(e).__name__
                self.log(f"job {job_id}: refusing: {st['refused']}")
                return False
            try:
                self.chain.send(m.accept(job_id), self.account)
            except TxFailed as e:  # e.g. our stake fell below minStake
                st["refused"] = f"accept failed: {e}"
                self.log(f"job {job_id}: {st['refused']}")
                self._inputs.pop(job_id, None)
                return False
            st["accepted"] = True
            self.log(f"job {job_id}: inputs match dataHash, accepted")
            return True

        if not st.get("accepted"):
            return False
        if self.behavior == "offline":
            if not st.get("offline"):
                st["offline"] = True
                self.log(f"job {job_id}: goes offline")
            return False

        if "labels" not in st and job.status in (Status.COMMITTING, Status.PUBLISHING):
            self._compute_main(job_id, st, job)
            return True

        if job.status == Status.COMMITTING:
            leaves = self._leaves(st, range(job.numItems))
            self.chain.send(m.commitResults(job_id, crypto.results_commit(leaves)), self.account)
            self.log(f"job {job_id}: committed results")
            return True

        if job.status == Status.PUBLISHING and not st.get("published"):
            leaves = self._leaves(st, range(job.numItems))
            self.chain.send(m.publishResults(job_id, leaves), self.account)
            st["published"] = True
            self.log(f"job {job_id}: published {len(leaves)} leaves")
            return True
        return False

    def _compute_main(self, job_id: int, st: dict, job) -> None:
        k_job = _unhex(st["k_job"])
        if job_id not in self._inputs:  # e.g. the daemon was restarted
            keys = {i: crypto.item_key(k_job, i) for i in range(job.numItems)}
            self._inputs[job_id] = self._load_inputs(job, crypto.model_key(k_job), keys)
        model, images = self._inputs.pop(job_id)
        labels = self._runner(model).classify([images[i] for i in range(job.numItems)])
        if self.behavior == "cheat":
            n_fake = round(self.cheat_fraction * len(labels))
            fake = sorted(self.rng.sample(range(len(labels)), n_fake))
            for i in fake:  # a guaranteed-wrong label
                labels[i] = (labels[i] + self.rng.randrange(1, NUM_CLASSES)) % NUM_CLASSES
            st["cheated"] = fake
            self.log(f"job {job_id}: ran {len(labels)} items, faked {n_fake} labels")
        else:
            self.log(f"job {job_id}: ran {len(labels)} items")
        st["job_salt"] = _hex(crypto.job_salt(k_job))
        st["labels"] = labels

    # ------------------------------------------------------------------
    # Verifier
    # ------------------------------------------------------------------

    def _act_verifier(self, job_id: int, st: dict, job) -> bool:
        m = self.chain.market.functions
        slot = st["slot"]
        my_state = VState(job.vstate[slot])
        if (
            job.status == Status.CHECKING
            and my_state == VState.SHARED
            and not st.get("committed")
            and not st.get("reported")
            and "sealed" in st
        ):
            start, end = self.chain.range_of(job_id, slot)
            indices = list(range(start, end))
            try:
                payload = crypto.unseal(self.priv, _unhex(st["sealed"]))
                if (int(payload["start"]), int(payload["end"])) != (start, end):
                    raise InputError("shared range differs from the on-chain range")
                self._check_runner(job)
                keys = self._item_keys(payload, indices)
                model, images = self._load_inputs(job, _unhex(payload["model_key"]), keys)
            except (InputError, CryptoError, KeyError, ValueError) as e:
                st["reported"] = str(e) or type(e).__name__
                self.chain.send(m.reportBadInput(job_id), self.account)
                self.log(f"job {job_id}: bad input ({st['reported']}), reported")
                return True

            if self.behavior == "liar":
                labels = [self.rng.randrange(NUM_CLASSES) for _ in indices]
                self.log(f"job {job_id}: making up {len(indices)} random labels for items {start}-{end - 1}")
            else:
                labels = self._runner(model).classify([images[i] for i in indices])
                self.log(f"job {job_id}: ran items {start}-{end - 1}")
            st.update(job_salt=payload["job_salt"], indices=indices, labels=labels, v_salt=_hex(os.urandom(32)))
            leaves = self._leaves(st, indices)
            commit = crypto.check_commit(_unhex(st["v_salt"]), leaves)
            self.chain.send(m.commitCheck(job_id, commit), self.account)
            st["committed"] = True
            self.log(f"job {job_id}: committed its check")
            return True

        if job.status == Status.CHECK_REVEAL and my_state == VState.COMMITTED and not st.get("revealed"):
            leaves = self._leaves(st, st["indices"])
            self.chain.send(m.revealCheck(job_id, leaves, _unhex(st["v_salt"])), self.account)
            st["revealed"] = True
            self.log(f"job {job_id}: revealed its check")
            return True
        return False

    # ------------------------------------------------------------------
    # Tie-breaker
    # ------------------------------------------------------------------

    def _act_tiebreaker(self, job_id: int, st: dict, job) -> bool:
        if (
            job.status != Status.TIE_BREAK
            or not job.tieShared
            or st.get("submitted")
            or st.get("reported")
            or "sealed" not in st
        ):
            return False
        m = self.chain.market.functions
        mismatched = [int(i) for i in job.mismatched]
        try:
            payload = crypto.unseal(self.priv, _unhex(st["sealed"]))
            if [int(i) for i in payload["indices"]] != mismatched:
                raise InputError("shared items differ from the mismatched items")
            self._check_runner(job)
            keys = self._item_keys(payload, mismatched)
            model, images = self._load_inputs(job, _unhex(payload["model_key"]), keys)
        except (InputError, CryptoError, KeyError, ValueError) as e:
            st["reported"] = str(e) or type(e).__name__
            self.chain.send(m.reportBadInput(job_id), self.account)
            self.log(f"job {job_id}: bad input ({st['reported']}), reported")
            return True

        # A liar only lies as verifier; as tie-breaker every behaviour runs honestly.
        labels = self._runner(model).classify([images[i] for i in mismatched])
        st.update(job_salt=payload["job_salt"], indices=mismatched, labels=labels)
        leaves = self._leaves(st, mismatched)
        self.chain.send(m.submitTiebreak(job_id, leaves), self.account)
        st["submitted"] = True
        self.log(f"job {job_id}: ran {len(mismatched)} mismatched items, submitted tie-break")
        return True

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _check_runner(self, job) -> None:
        if self.chain.runner_hash_of(job.taskType) != self.local_runner_hash:
            raise InputError("task type runnerHash differs from the local runner")

    @staticmethod
    def _item_keys(payload: dict, indices: list[int]) -> dict[int, bytes]:
        keys = {int(i): _unhex(k) for i, k in payload["item_keys"].items()}
        missing = [i for i in indices if i not in keys]
        if missing:
            raise InputError(f"no key for items {missing[:5]}")
        return {i: keys[i] for i in indices}

    def _load_inputs(self, job, model_key: bytes, item_keys: dict[int, bytes]) -> tuple[bytes, dict[int, bytes]]:
        """Fetch the manifest, check it against the on-chain dataHash, then fetch and
        decrypt the model and the items in ``item_keys`` and check each plaintext
        against its manifest hash. Raises InputError on any mismatch."""
        try:
            manifest = json.loads(self.store.get(job.dataURI))
            if manifest.get("task") != TASK_NAME:
                raise InputError("manifest is for another task")
            items = manifest["items"]
            if len(items) != job.numItems:
                raise InputError("manifest has the wrong number of items")
            model_hash = _unhex(manifest["model"]["hash"])
            item_hashes = [_unhex(it["hash"]) for it in items]
            if crypto.data_hash(model_hash, item_hashes) != bytes(job.dataHash):
                raise InputError("manifest does not match dataHash")
            model = crypto.decrypt(model_key, self.store.get(manifest["model"]["uri"]))
            if crypto.keccak(model) != model_hash:
                raise InputError("model does not match its hash")
            images = {}
            for i, key in item_keys.items():
                img = crypto.decrypt(key, self.store.get(items[i]["uri"]))
                if crypto.keccak(img) != item_hashes[i]:
                    raise InputError(f"item {i} does not match its hash")
                images[i] = img
        except InputError:
            raise
        except KeyError as e:
            raise InputError(f"missing data {e}") from None
        except CryptoError:
            raise InputError("cannot decrypt the inputs") from None
        except (ValueError, TypeError, IndexError) as e:
            raise InputError(f"malformed manifest ({e})") from None
        return model, images

    def _runner(self, model: bytes) -> Runner:
        h = crypto.keccak(model)
        if h not in self._runners:
            self._runners[h] = Runner(model)
        return self._runners[h]

    @staticmethod
    def _leaves(st: dict, indices) -> list[bytes]:
        """Leaves for ``indices`` from the stored labels (which are in ``indices`` order)."""
        salt = _unhex(st["job_salt"])
        return [crypto.leaf(salt, i, label) for i, label in zip(indices, st["labels"])]

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
            "jobs": {str(k): v for k, v in self.jobs.items()},
        }
        tmp = self.state_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=1))
        os.replace(tmp, self.state_path)

    def _load_state(self) -> None:
        data = json.loads(self.state_path.read_text())
        self.priv, self.pub = _unhex(data["priv"]), _unhex(data["pub"])
        if data.get("chain") != self.chain.tag():
            return  # written against another chain: keep the keypair, forget the jobs
        self.next_block = data.get("next_block", 0)
        self.jobs = {int(k): v for k, v in data.get("jobs", {}).items()}


# ---------------------------------------------------------------------------
# CLI daemon
# ---------------------------------------------------------------------------

def main() -> None:
    ap = argparse.ArgumentParser(description="Run a DeGPU provider agent against a running chain.")
    ap.add_argument("--index", type=int, required=True, help="anvil account index (providers are 2-7)")
    ap.add_argument("--behavior", default="honest", choices=BEHAVIORS)
    ap.add_argument("--cheat-fraction", type=float, default=0.2)
    ap.add_argument("--rpc", default="http://127.0.0.1:8545")
    ap.add_argument("--market", required=True, help="JobMarket address")
    ap.add_argument("--poll", type=float, default=1.0, help="seconds between steps")
    ap.add_argument("--state-dir", default=str(STATE_DIR), help="where to keep the keypair and job secrets")
    args = ap.parse_args()

    chain = Chain(args.rpc, market_address=args.market)
    account = chain.accounts[args.index]
    agent = ProviderAgent(
        chain,
        account,
        args.behavior,
        name=f"agent {args.index}",
        cheat_fraction=args.cheat_fraction,
        state_path=Path(args.state_dir) / f"{account}.json",
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
