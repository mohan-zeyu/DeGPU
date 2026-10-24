"""DeGPU client: posts batch-inference jobs and collects the results.

``Client.post`` does everything the client does before a job exists on-chain
(docs/INTERFACE.md sections 3 and 4):

* draw a random job key ``k_job``; derive the model key and per-item keys;
* encrypt the model and every image and upload them to the store;
* upload a plaintext manifest (ciphertext URIs + plaintext hashes) and
  compute ``dataHash`` from it;
* if verifying, pick a secret random sample of ``k`` items, sort it and
  commit to it with ``sampleHash``;
* seal ``k_job`` to the main provider's on-chain X25519 key and call
  ``createJob`` with exactly ``(numItems + k) * pricePerItem(main)``.

``Client.step`` watches the client's open jobs and shares, at the right
moment, the sample's keys with the drawn verifier (``shareSample``) and the
mismatched items' keys with the drawn tie-breaker (``shareTiebreak``).
``Client.results`` decodes the labels from the published leaves.

CLI (accounts are anvil's unlocked accounts; the client is index 1):

    uv run python -m degpu.client --market 0x... post --main A --images assets/images --sample-rate 0.1 --wait
    uv run python -m degpu.client --market 0x... results 1
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import sys
import time
from pathlib import Path
from typing import Callable

from degpu import crypto
from degpu.chain import (
    CLIENT_INDEX,
    PROVIDER_INDICES,
    REPO_ROOT,
    TASK_NAME,
    TASK_TYPE_ID,
    ZERO32,
    ZERO_ADDRESS,
    Chain,
    Outcome,
    Status,
)
from degpu.storage import Store
from degpu.tasks.image_classify_v1.decode import decode_labels

STATE_DIR = REPO_ROOT / ".degpu-state"
DEFAULT_MODEL = REPO_ROOT / "assets" / "mobilenetv2.onnx"
DEFAULT_IMAGES = REPO_ROOT / "assets" / "images"


def _hex(b: bytes) -> str:
    return "0x" + bytes(b).hex()


def _unhex(s: str) -> bytes:
    return bytes.fromhex(s.removeprefix("0x"))


def sample_size(sample_rate: float, num_items: int) -> int:
    """Number of sampled items for a rate in [0, 1]; at least 1 if the rate is positive."""
    if not 0 <= sample_rate <= 1:
        raise ValueError("sample_rate must be between 0 and 1")
    if sample_rate == 0:
        return 0
    return min(num_items, max(1, round(sample_rate * num_items)))


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
        # jobId -> JSON-able secrets and progress: k_job, sample_salt, indices, flags
        self.jobs: dict[int, dict] = {}
        if self.state_path and self.state_path.exists():
            data = json.loads(self.state_path.read_text())
            if data.get("chain") == chain.tag():  # ignore state from an earlier chain
                self.jobs = {int(k): v for k, v in data["jobs"].items()}

    def log(self, msg: str) -> None:
        self._log(f"[{self.name}] {msg}")

    def _nm(self, addr: str) -> str:
        return self.names.get(addr, addr[:10])

    # ------------------------------------------------------------------
    # Posting
    # ------------------------------------------------------------------

    def post(self, main: str, model_path, image_paths, sample_rate: float) -> int:
        """Encrypt and upload the inputs, then create the job. Returns the jobId."""
        model = Path(model_path).read_bytes()
        images = [Path(p).read_bytes() for p in image_paths]
        n = len(images)
        if n == 0:
            raise ValueError("no images")
        k = sample_size(sample_rate, n)

        # Keys: everything derives from one random k_job.
        k_job = secrets.token_bytes(32)

        # Encrypt and upload; the manifest lists ciphertext URIs and plaintext hashes.
        manifest = {
            "task": TASK_NAME,
            "model": {
                "uri": self.store.put(crypto.encrypt(crypto.model_key(k_job), model)),
                "hash": _hex(crypto.keccak(model)),
            },
            "items": [
                {
                    "uri": self.store.put(crypto.encrypt(crypto.item_key(k_job, i), img)),
                    "hash": _hex(crypto.keccak(img)),
                }
                for i, img in enumerate(images)
            ],
        }
        data_uri = self.store.put(json.dumps(manifest).encode("utf-8"))
        data_hash = crypto.data_hash(crypto.keccak(model), [crypto.keccak(img) for img in images])

        # Secret sample: k distinct indices, uniformly at random, sorted ascending.
        sample_salt = secrets.token_bytes(32)
        indices = sorted(secrets.SystemRandom().sample(range(n), k))
        sample_hash = crypto.sample_hash(sample_salt, indices) if k else ZERO32

        # Seal k_job to M's registered key and pay exactly price + fee.
        p = self.chain.provider(main)
        sealed = crypto.seal(bytes(p.encPubKey), {"k_job": _hex(k_job)})
        value = (n + k) * p.pricePerItem
        fn = self.chain.market.functions.createJob(
            main, TASK_TYPE_ID, n, data_hash, data_uri, k, sample_hash, sealed
        )
        receipt = self.chain.send(fn, self.account, value=value)
        job_id = self._job_id_from(receipt)

        self.jobs[job_id] = {
            "k_job": _hex(k_job),
            "num_items": n,
            "sample_salt": _hex(sample_salt),
            "indices": indices,
            "block": receipt["blockNumber"],
            "paid": value,
        }
        self._save_state()
        self.log(f"job {job_id}: posted {n} items to {self._nm(main)}, sample {k}, paid {value / 1e18:g} ETH")
        return job_id

    def _job_id_from(self, receipt) -> int:
        for log in receipt["logs"]:
            if log["address"] != self.chain.market.address:
                continue
            ev = self.chain.market.events.JobCreated().process_log(log)
            return ev["args"]["jobId"]
        raise RuntimeError("no JobCreated event in the receipt")

    # ------------------------------------------------------------------
    # Watching
    # ------------------------------------------------------------------

    def step(self) -> bool:
        """Share the sample with V and the tie items with T when it is time.
        Returns True if a transaction was sent."""
        did = False
        for job_id, st in sorted(self.jobs.items()):
            if "outcome" in st:
                continue
            job = self.chain.job(job_id)
            if job.status == Status.CLOSED:
                st["outcome"] = int(job.outcome)
                self.log(f"job {job_id}: closed, outcome {Outcome(job.outcome).name}")
                did = True
                continue
            if job.status == Status.COMMITTING and job.verifier != ZERO_ADDRESS and not job.sampleShared:
                self._share_sample(job_id, st, job)
                did = True
            elif job.status == Status.TIE_BREAK and not job.tieShared:
                self._share_tiebreak(job_id, st, job)
                did = True
        if did:
            self._save_state()
        return did

    def _keys_payload(self, k_job: bytes, indices: list[int]) -> dict:
        return {
            "job_salt": _hex(crypto.job_salt(k_job)),
            "model_key": _hex(crypto.model_key(k_job)),
            "indices": indices,
            "item_keys": {str(i): _hex(crypto.item_key(k_job, i)) for i in indices},
        }

    def _share_sample(self, job_id: int, st: dict, job) -> None:
        payload = self._keys_payload(_unhex(st["k_job"]), st["indices"])
        payload["sample_salt"] = st["sample_salt"]
        sealed = crypto.seal(bytes(self.chain.provider(job.verifier).encPubKey), payload)
        self.chain.send(self.chain.market.functions.shareSample(job_id, sealed), self.account)
        self.log(f"job {job_id}: shared the {len(st['indices'])}-item sample with verifier {self._nm(job.verifier)}")

    def _share_tiebreak(self, job_id: int, st: dict, job) -> None:
        mismatched = [int(i) for i in job.mismatched]
        payload = self._keys_payload(_unhex(st["k_job"]), mismatched)
        sealed = crypto.seal(bytes(self.chain.provider(job.tiebreaker).encPubKey), payload)
        self.chain.send(self.chain.market.functions.shareTiebreak(job_id, sealed), self.account)
        self.log(f"job {job_id}: shared {len(mismatched)} mismatched items with tie-breaker {self._nm(job.tiebreaker)}")

    # ------------------------------------------------------------------
    # Results and housekeeping
    # ------------------------------------------------------------------

    def results(self, job_id: int) -> list[int | None]:
        """Labels decoded from the job's ResultsPublished leaves (None = undecodable leaf).
        Raises LookupError if nothing was published."""
        st = self.jobs[job_id]
        for ev in self.chain.market_events(st.get("block", 0), job_id=job_id):
            if ev["event"] == "ResultsPublished":
                leaves = [bytes(x) for x in ev["args"]["leaves"]]
                return decode_labels(crypto.job_salt(_unhex(st["k_job"])), leaves)
        raise LookupError(f"job {job_id} has no published results")

    def expire(self, job_id: int) -> dict:
        """Call expire() on a job whose phase deadline has passed."""
        r = self.chain.send(self.chain.market.functions.expire(job_id), self.account)
        self.log(f"job {job_id}: called expire()")
        return r

    def cancel(self, job_id: int) -> dict:
        r = self.chain.send(self.chain.market.functions.cancel(job_id), self.account)
        self.log(f"job {job_id}: cancelled")
        return r

    def _save_state(self) -> None:
        if not self.state_path:
            return
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.state_path.with_suffix(".tmp")
        data = {"chain": self.chain.tag(), "jobs": {str(k): v for k, v in self.jobs.items()}}
        tmp.write_text(json.dumps(data, indent=1))
        os.replace(tmp, self.state_path)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _resolve_main(chain: Chain, main: str) -> str:
    """A provider letter A-F (anvil accounts 2-7) or an address."""
    if main.upper() in PROVIDER_INDICES:
        return chain.accounts[PROVIDER_INDICES[main.upper()]]
    return chain.w3.to_checksum_address(main)


def main() -> None:
    ap = argparse.ArgumentParser(description="DeGPU client")
    ap.add_argument("--index", type=int, default=CLIENT_INDEX, help="anvil account index (default 1)")
    ap.add_argument("--rpc", default="http://127.0.0.1:8545")
    ap.add_argument("--market", required=True, help="JobMarket address")
    ap.add_argument("--state-dir", default=str(STATE_DIR), help="where to keep the job secrets")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("post", help="post a job")
    p.add_argument("--main", required=True, help="provider letter A-F or address")
    p.add_argument("--model", default=str(DEFAULT_MODEL))
    p.add_argument("--images", default=str(DEFAULT_IMAGES), help="directory of .jpg files")
    p.add_argument("--limit", type=int, default=200, help="use the first N images")
    p.add_argument("--sample-rate", type=float, default=0.1)
    p.add_argument("--wait", action="store_true", help="keep watching until the job closes")

    sub.add_parser("watch", help="auto-share samples / tie items until interrupted")
    for name in ("results", "status", "expire", "cancel"):
        q = sub.add_parser(name)
        q.add_argument("job_id", type=int)
    args = ap.parse_args()

    chain = Chain(args.rpc, market_address=args.market)
    account = chain.accounts[args.index]
    client = Client(chain, account, state_path=Path(args.state_dir) / f"client-{account}.json")

    if args.cmd == "post":
        images = sorted(Path(args.images).glob("*.jpg"))[: args.limit]
        job_id = client.post(_resolve_main(chain, args.main), args.model, images, args.sample_rate)
        print(job_id)
        if args.wait:
            while "outcome" not in client.jobs[job_id]:
                client.step()
                time.sleep(1)
            try:
                print(client.results(job_id))
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
        print(json.dumps(client.results(args.job_id)))
    elif args.cmd == "status":
        job = chain.job(args.job_id)
        print(f"status {Status(job.status).name}, outcome {Outcome(job.outcome).name}, "
              f"main {job.main}, verifier {job.verifier}, tiebreaker {job.tiebreaker}")
    elif args.cmd == "expire":
        client.expire(args.job_id)
    elif args.cmd == "cancel":
        client.cancel(args.job_id)
    return 0


if __name__ == "__main__":
    sys.exit(main())
