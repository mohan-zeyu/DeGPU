"""Off-chain side of the replicated mode (ReplicatedMarket, docs/INTERFACE.md section 7).

Job data (both sides):

* ``pack_inputs`` (client): encrypt the task's shared blob and every item with keys derived from
  a random ``k_job``, upload them and a plaintext manifest, and compute ``dataHash``.
* ``load_inputs`` (providers): fetch the manifest, check it against the on-chain ``dataHash``,
  decrypt the blobs a role needs and check each against its manifest hash.

Provider roles (``ReplicatedProvider``), as before but through the task's hooks:

* **main**: unseal ``k_job``; check the task's runner hash and the inputs; ``accept``; run all
  N items; ``commitResults`` (always: M never knows whether the job will be verified);
  ``publishResults`` in Publishing.
* **verifier**: wait for its ``RangeShared``; check its range and inputs (``reportBadInput`` on a
  mismatch); run its share of the items; ``commitCheck``; ``revealCheck`` in CheckReveal.
* **tie-breaker**: wait for ``TiebreakShared``; check the inputs; run only the mismatched items;
  ``submitTiebreak``.

Client (``ReplicatedClient``): post with a hidden verify decision and a 2 x price deposit, reveal
the decision once M has committed, share each verifier's range and the tie items, and decode the
published leaves with the task's ``candidates``.
"""

from __future__ import annotations

import json
import os
import secrets

from nacl.exceptions import CryptoError

from degpu import crypto
from degpu.chain import ZERO32, Outcome, Status, TxFailed, VState
from degpu.modes.base import ClientDriver, ProviderDriver
from degpu.tasks.base import ReplicatedInputs, ReplicatedTask

MODE = "replicated"


def _hex(b: bytes) -> str:
    return "0x" + bytes(b).hex()


def _unhex(s: str) -> bytes:
    return bytes.fromhex(s.removeprefix("0x"))


class InputError(Exception):
    """The inputs a provider received do not match what the job committed to."""


# ---------------------------------------------------------------------------
# Job data: manifest, encryption, input checks
# ---------------------------------------------------------------------------

def pack_inputs(store, k_job: bytes, task: ReplicatedTask, inputs: ReplicatedInputs) -> tuple[str, bytes]:
    """Encrypt and upload the inputs; return (dataURI of the manifest, dataHash)."""
    shared = None
    if inputs.shared is not None:
        shared = {
            "uri": store.put(crypto.encrypt(crypto.shared_key(k_job), inputs.shared)),
            "hash": _hex(crypto.keccak(inputs.shared)),
        }
    manifest = {
        "task": task.name,
        "shared": shared,
        "items": [
            {"uri": store.put(crypto.encrypt(crypto.item_key(k_job, i), item)), "hash": _hex(crypto.keccak(item))}
            for i, item in enumerate(inputs.items)
        ],
    }
    data_uri = store.put(json.dumps(manifest).encode("utf-8"))
    shared_hash = crypto.keccak(inputs.shared) if inputs.shared is not None else ZERO32
    data_hash = crypto.data_hash(shared_hash, [crypto.keccak(item) for item in inputs.items])
    return data_uri, data_hash


def load_inputs(store, job, task: ReplicatedTask, shared_key: bytes,
                item_keys: dict[int, bytes]) -> tuple[bytes | None, dict[int, bytes]]:
    """Fetch the manifest, check it against the on-chain dataHash, then fetch and decrypt the
    shared blob and the items in ``item_keys`` and check each plaintext against its manifest
    hash. Raises InputError on any mismatch."""
    try:
        manifest = json.loads(store.get(job.dataURI))
        if manifest.get("task") != task.name:
            raise InputError("manifest is for another task")
        items = manifest["items"]
        if len(items) != job.numItems:
            raise InputError("manifest has the wrong number of items")
        entry = manifest.get("shared")
        shared_hash = _unhex(entry["hash"]) if entry else ZERO32
        item_hashes = [_unhex(it["hash"]) for it in items]
        if crypto.data_hash(shared_hash, item_hashes) != bytes(job.dataHash):
            raise InputError("manifest does not match dataHash")
        shared = None
        if entry:
            shared = crypto.decrypt(shared_key, store.get(entry["uri"]))
            if crypto.keccak(shared) != shared_hash:
                raise InputError("shared input does not match its hash")
        blobs = {}
        for i, key in item_keys.items():
            blob = crypto.decrypt(key, store.get(items[i]["uri"]))
            if crypto.keccak(blob) != item_hashes[i]:
                raise InputError(f"item {i} does not match its hash")
            blobs[i] = blob
    except InputError:
        raise
    except KeyError as e:
        raise InputError(f"missing data {e}") from None
    except CryptoError:
        raise InputError("cannot decrypt the inputs") from None
    except (ValueError, TypeError, IndexError) as e:
        raise InputError(f"malformed manifest ({e})") from None
    return shared, blobs


def _leaves(st: dict, indices) -> list[bytes]:
    """Leaves for ``indices`` from the stored words (which are in ``indices`` order)."""
    salt = _unhex(st["job_salt"])
    return [crypto.leaf(salt, i, _unhex(w)) for i, w in zip(indices, st["words"])]


# ---------------------------------------------------------------------------
# Provider
# ---------------------------------------------------------------------------

class ReplicatedProvider(ProviderDriver):
    mode = MODE
    closed_status = Status.CLOSED

    def __init__(self, agent):
        super().__init__(agent)
        # in-memory caches (not persisted)
        self._inputs: dict[int, tuple[bytes | None, dict[int, bytes]]] = {}
        self._states: dict[tuple[str, bytes], object] = {}

    def on_event(self, name: str, a) -> bool:
        me = self.agent.account
        job_id = a["jobId"]
        # setdefault-style: a re-scan (e.g. after a daemon restart) never wipes a job's progress
        if name == "JobCreated" and a["main"] == me and job_id not in self.jobs:
            self.jobs[job_id] = {"role": "main", "sealed": _hex(a["sealedForMain"])}
            self.log(job_id, f"offered as main ({a['numItems']} items, verification unknown)")
        elif name == "VerifiersDrawn" and me in a["verifiers"] and job_id not in self.jobs:
            slot = list(a["verifiers"]).index(me)
            self.jobs[job_id] = {"role": "verifier", "slot": slot}
            self.log(job_id, f"drawn as verifier (slot {slot})")
        elif name == "RangeShared" and a["verifier"] == me and job_id in self.jobs:
            self.jobs[job_id].setdefault("sealed", _hex(a["sealedForVerifier"]))
        elif name == "TiebreakStarted" and a["tiebreaker"] == me and job_id not in self.jobs:
            self.jobs[job_id] = {"role": "tiebreaker", "mismatched": list(a["mismatched"])}
            self.log(job_id, f"drawn as tie-breaker ({len(a['mismatched'])} items)")
        elif name == "TiebreakShared" and a["tiebreaker"] == me and job_id in self.jobs:
            self.jobs[job_id].setdefault("sealed", _hex(a["sealedForTiebreaker"]))
        else:
            return False
        return True

    def act(self, job_id: int, st: dict, job) -> bool:
        role = st["role"]
        if role == "main":
            return self._act_main(job_id, st, job)
        if self.agent.behavior == "offline":
            return False  # an offline provider never answers as verifier or tie-breaker either
        if role == "verifier":
            return self._act_verifier(job_id, st, job)
        if role == "tiebreaker":
            return self._act_tiebreaker(job_id, st, job)
        return False

    def forget(self, job_id: int) -> None:
        self._inputs.pop(job_id, None)

    # -- main --------------------------------------------------------------------

    def _act_main(self, job_id: int, st: dict, job) -> bool:
        m = self.market.functions
        if job.status == Status.OPEN:
            if st.get("accepted") or st.get("refused"):
                return False
            try:
                k_job = _unhex(crypto.unseal(self.agent.priv, _unhex(st["sealed"]))["k_job"])
                st["k_job"] = _hex(k_job)
                task = self._task(job)
                keys = {i: crypto.item_key(k_job, i) for i in range(job.numItems)}
                self._inputs[job_id] = load_inputs(self.agent.store, job, task, crypto.shared_key(k_job), keys)
            except (InputError, CryptoError, KeyError, ValueError) as e:
                st["refused"] = str(e) or type(e).__name__
                self.log(job_id, f"refusing: {st['refused']}")
                return False
            try:
                self.chain.send(m.accept(job_id), self.agent.account)
            except TxFailed as e:  # e.g. our stake fell below minStake
                st["refused"] = f"accept failed: {e}"
                self.log(job_id, st["refused"])
                self._inputs.pop(job_id, None)
                return False
            st["accepted"] = True
            self.log(job_id, "inputs match dataHash, accepted")
            return True

        if not st.get("accepted"):
            return False
        if self.agent.behavior == "offline":
            if not st.get("offline"):
                st["offline"] = True
                self.log(job_id, "goes offline")
            return False

        if "words" not in st and job.status in (Status.COMMITTING, Status.PUBLISHING):
            self._compute_main(job_id, st, job)
            return True

        if job.status == Status.COMMITTING:
            leaves = _leaves(st, range(job.numItems))
            self.chain.send(m.commitResults(job_id, crypto.results_commit(leaves)), self.agent.account)
            self.log(job_id, "committed results")
            return True

        if job.status == Status.PUBLISHING and not st.get("published"):
            leaves = _leaves(st, range(job.numItems))
            self.chain.send(m.publishResults(job_id, leaves), self.agent.account)
            st["published"] = True
            self.log(job_id, f"published {len(leaves)} leaves")
            return True
        return False

    def _compute_main(self, job_id: int, st: dict, job) -> None:
        k_job = _unhex(st["k_job"])
        task = self._task(job)
        if job_id not in self._inputs:  # e.g. the daemon was restarted
            keys = {i: crypto.item_key(k_job, i) for i in range(job.numItems)}
            self._inputs[job_id] = load_inputs(self.agent.store, job, task, crypto.shared_key(k_job), keys)
        shared, items = self._inputs.pop(job_id)
        words = self._run(task, shared, [items[i] for i in range(job.numItems)])
        rng = self.agent.rng
        if self.agent.behavior == "cheat":
            n_fake = round(self.agent.cheat_fraction * len(words))
            fake = sorted(rng.sample(range(len(words)), n_fake))
            for i in fake:
                words[i] = task.wrong_output(words[i], rng)
            st["cheated"] = fake
            self.log(job_id, f"ran {len(words)} items, faked {n_fake} results")
        else:
            self.log(job_id, f"ran {len(words)} items")
        st["job_salt"] = _hex(crypto.job_salt(k_job))
        st["words"] = [_hex(w) for w in words]

    # -- verifier ------------------------------------------------------------------

    def _act_verifier(self, job_id: int, st: dict, job) -> bool:
        m = self.market.functions
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
                payload = crypto.unseal(self.agent.priv, _unhex(st["sealed"]))
                if (int(payload["start"]), int(payload["end"])) != (start, end):
                    raise InputError("shared range differs from the on-chain range")
                task = self._task(job)
                keys = self._item_keys(payload, indices)
                shared, items = load_inputs(self.agent.store, job, task, _unhex(payload["shared_key"]), keys)
            except (InputError, CryptoError, KeyError, ValueError) as e:
                st["reported"] = str(e) or type(e).__name__
                self.chain.send(m.reportBadInput(job_id), self.agent.account)
                self.log(job_id, f"bad input ({st['reported']}), reported")
                return True

            if self.agent.behavior == "liar":
                words = [task.random_output(self.agent.rng) for _ in indices]
                self.log(job_id, f"making up {len(indices)} random results for items {start}-{end - 1}")
            else:
                words = self._run(task, shared, [items[i] for i in indices])
                self.log(job_id, f"ran items {start}-{end - 1}")
            st.update(job_salt=payload["job_salt"], indices=indices, words=[_hex(w) for w in words],
                      v_salt=_hex(os.urandom(32)))
            leaves = _leaves(st, indices)
            commit = crypto.check_commit(_unhex(st["v_salt"]), leaves)
            self.chain.send(m.commitCheck(job_id, commit), self.agent.account)
            st["committed"] = True
            self.log(job_id, "committed its check")
            return True

        if job.status == Status.CHECK_REVEAL and my_state == VState.COMMITTED and not st.get("revealed"):
            leaves = _leaves(st, st["indices"])
            self.chain.send(m.revealCheck(job_id, leaves, _unhex(st["v_salt"])), self.agent.account)
            st["revealed"] = True
            self.log(job_id, "revealed its check")
            return True
        return False

    # -- tie-breaker -------------------------------------------------------------------

    def _act_tiebreaker(self, job_id: int, st: dict, job) -> bool:
        if (
            job.status != Status.TIE_BREAK
            or not job.tieShared
            or st.get("submitted")
            or st.get("reported")
            or "sealed" not in st
        ):
            return False
        m = self.market.functions
        mismatched = [int(i) for i in job.mismatched]
        try:
            payload = crypto.unseal(self.agent.priv, _unhex(st["sealed"]))
            if [int(i) for i in payload["indices"]] != mismatched:
                raise InputError("shared items differ from the mismatched items")
            task = self._task(job)
            keys = self._item_keys(payload, mismatched)
            shared, items = load_inputs(self.agent.store, job, task, _unhex(payload["shared_key"]), keys)
        except (InputError, CryptoError, KeyError, ValueError) as e:
            st["reported"] = str(e) or type(e).__name__
            self.chain.send(m.reportBadInput(job_id), self.agent.account)
            self.log(job_id, f"bad input ({st['reported']}), reported")
            return True

        # A liar only lies as verifier; as tie-breaker every behaviour runs honestly.
        words = self._run(task, shared, [items[i] for i in mismatched])
        st.update(job_salt=payload["job_salt"], indices=mismatched, words=[_hex(w) for w in words])
        leaves = _leaves(st, mismatched)
        self.chain.send(m.submitTiebreak(job_id, leaves), self.agent.account)
        st["submitted"] = True
        self.log(job_id, f"ran {len(mismatched)} mismatched items, submitted tie-break")
        return True

    # -- helpers ---------------------------------------------------------------------------

    def _task(self, job) -> ReplicatedTask:
        """The local task for the job's task type; InputError if this agent can't run it exactly."""
        task = self.agent.task_for(MODE, job.taskType)
        if task is None:
            raise InputError(f"task type {job.taskType} is not offered by this agent")
        if bytes(self.chain.task_type(MODE, job.taskType)[0]) != task.runner_hash():
            raise InputError("task type runnerHash differs from the local task code")
        return task

    @staticmethod
    def _item_keys(payload: dict, indices: list[int]) -> dict[int, bytes]:
        keys = {int(i): _unhex(k) for i, k in payload["item_keys"].items()}
        missing = [i for i in indices if i not in keys]
        if missing:
            raise InputError(f"no key for items {missing[:5]}")
        return {i: keys[i] for i in indices}

    def _run(self, task: ReplicatedTask, shared: bytes | None, items: list[bytes]) -> list[bytes]:
        key = (task.name, crypto.keccak(shared) if shared is not None else ZERO32)
        if key not in self._states:
            self._states[key] = task.load(shared)
        words = task.run(self._states[key], items)
        if len(words) != len(items) or any(len(w) != 32 for w in words):
            raise ValueError(f"{task.name}: run() must return one 32-byte word per item")
        return words


# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------

class ReplicatedClient(ClientDriver):
    mode = MODE
    closed_status = Status.CLOSED
    outcome_names = Outcome

    @staticmethod
    def add_cli_args(parser) -> None:
        parser.add_argument("--verify", action="store_true", help="secretly ask for full verification")

    @staticmethod
    def options_from(args) -> dict:
        return {"verify": args.verify}

    def post(self, task: ReplicatedTask, main: str, inputs: ReplicatedInputs, *, verify: bool = False,
             reveal: bool = True) -> int:
        """Encrypt and upload the inputs, then create the job with a hidden verify decision.
        With ``reveal=False`` the client never reveals it (the job then counts as unverified)."""
        n = len(inputs.items)
        if n == 0:
            raise ValueError("no items")
        task_id = self.chain.task_id(task.name)
        if task_id is None:
            raise ValueError(f"task {task.name} is not registered on this chain")

        # Keys: everything derives from one random k_job.
        k_job = secrets.token_bytes(32)
        data_uri, data_hash = pack_inputs(self.client.store, k_job, task, inputs)

        # The hidden decision: only its commitment goes on-chain now.
        verify_salt = secrets.token_bytes(32)
        verify_commit = crypto.verify_commit(verify_salt, verify)

        # Seal k_job to M's registered key; the deposit is 2 x price either way.
        sealed = crypto.seal(bytes(self.chain.provider(main).encPubKey), {"k_job": _hex(k_job)})
        value = 2 * n * self.chain.price_of(main, MODE, task_id)
        fn = self.market.functions.createJob(main, task_id, n, data_hash, data_uri, verify_commit, sealed)
        receipt = self.chain.send(fn, self.client.account, value=value)
        job_id = self._job_id_from(receipt)

        self.jobs[job_id] = {
            "task": task.name,
            "k_job": _hex(k_job),
            "num_items": n,
            "verify": bool(verify),
            "verify_salt": _hex(verify_salt),
            "reveal": reveal,
            "block": receipt["blockNumber"],
            "paid": value,
        }
        self.log(job_id, f"posted {n} {task.name} items to {self.client.nm(main)}, deposit {value / 1e18:g} ETH "
                         f"(secretly: {'verify' if verify else 'no verification'})")
        return job_id

    def act(self, job_id: int, st: dict, job) -> bool:
        if job.status == Status.DECIDING and st.get("reveal", True):
            self._reveal(job_id, st)
            return True
        if job.status == Status.CHECKING:
            did = False
            for slot, state in enumerate(job.vstate):
                if VState(state) == VState.ASSIGNED:
                    self._share_range(job_id, st, job, slot)
                    did = True
            return did
        if job.status == Status.TIE_BREAK and not job.tieShared:
            self._share_tiebreak(job_id, st, job)
            return True
        return False

    def _reveal(self, job_id: int, st: dict) -> None:
        fn = self.market.functions.revealDecision(job_id, _unhex(st["verify_salt"]), st["verify"])
        self.chain.send(fn, self.client.account)
        self.log(job_id, f"main provider committed; revealed decision: {'verify' if st['verify'] else 'no'}")

    @staticmethod
    def _keys_payload(k_job: bytes, indices: list[int]) -> dict:
        return {
            "job_salt": _hex(crypto.job_salt(k_job)),
            "shared_key": _hex(crypto.shared_key(k_job)),
            "item_keys": {str(i): _hex(crypto.item_key(k_job, i)) for i in indices},
        }

    def _share_range(self, job_id: int, st: dict, job, slot: int) -> None:
        start, end = self.chain.range_of(job_id, slot)
        payload = self._keys_payload(_unhex(st["k_job"]), list(range(start, end)))
        payload.update(start=start, end=end)
        verifier = job.verifiers[slot]
        sealed = crypto.seal(bytes(self.chain.provider(verifier).encPubKey), payload)
        self.chain.send(self.market.functions.shareRange(job_id, slot, sealed), self.client.account)
        self.log(job_id, f"shared items {start}-{end - 1} with verifier {self.client.nm(verifier)}")

    def _share_tiebreak(self, job_id: int, st: dict, job) -> None:
        mismatched = [int(i) for i in job.mismatched]
        payload = self._keys_payload(_unhex(st["k_job"]), mismatched)
        payload["indices"] = mismatched
        sealed = crypto.seal(bytes(self.chain.provider(job.tiebreaker).encPubKey), payload)
        self.chain.send(self.market.functions.shareTiebreak(job_id, sealed), self.client.account)
        self.log(job_id, f"shared {len(mismatched)} mismatched items with tie-breaker "
                         f"{self.client.nm(job.tiebreaker)}")

    def results(self, job_id: int) -> list:
        """One value per item decoded from the ResultsPublished leaves (None = undecodable).
        Raises LookupError if nothing was published."""
        from degpu.tasks import get

        st = self.jobs[job_id]
        task = get(st["task"])
        for ev in self.chain.events(MODE, st.get("block", 0), job_id=job_id):
            if ev["event"] == "ResultsPublished":
                leaves = [bytes(x) for x in ev["args"]["leaves"]]
                words = crypto.decode_leaves(crypto.job_salt(_unhex(st["k_job"])), leaves, task._candidate_list())
                return [task.present(w) for w in words]
        raise LookupError(f"job {job_id} has no published results")
