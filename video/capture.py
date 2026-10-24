"""Run the real DeGPU demo and dump the data the video needs (labels, fakes, lies)."""
import contextlib
import io
import json
import sys
import tempfile
from pathlib import Path

REPO = Path("/Users/mohan/Downloads/DeGPU")
sys.path.insert(0, str(REPO / "scripts"))
sys.path.insert(0, str(REPO))

import demo  # noqa: E402
from degpu.chain import start_local_chain  # noqa: E402
from degpu.storage import Store  # noqa: E402

OUT = Path(__file__).resolve().parent / "capture"
buf = io.StringIO()


class Tee(io.TextIOBase):
    def write(self, s):
        buf.write(s)
        sys.__stdout__.write(s)
        return len(s)


with contextlib.redirect_stdout(Tee()):
    print("DeGPU demo: starting a fresh anvil chain and deploying the contracts ...")
    anvil, chain = start_local_chain()
    try:
        with tempfile.TemporaryDirectory(prefix="degpu-store-") as tmp:
            print(f"  anvil {anvil.rpc_url}, registry {chain.registry.address}, market {chain.market.address}")
            world = demo.setup(chain, Store(tmp))
            for sc in (demo.scenario_1, demo.scenario_2, demo.scenario_3, demo.scenario_4, demo.scenario_5):
                sc(world)
            demo.print_reputation(world)
            data = {
                "images": [p.name for p in world.images],
                "expected": world.expected_labels,
                "jobs": {},
            }
            for sc, jid in world.job_ids.items():
                job = chain.job(jid)
                entry = {
                    "id": jid,
                    "main": world.nm(job.main),
                    "verifiers": [world.nm(v) for v in job.verifiers],
                    "tiebreaker": world.nm(job.tiebreaker),
                    "mismatched": [int(i) for i in job.mismatched],
                    "agents": {},
                }
                for name, ag in world.agents.items():
                    st = ag.jobs.get(jid)
                    if st:
                        entry["agents"][name] = {
                            k: st[k] for k in ("role", "slot", "cheated", "labels", "indices") if k in st
                        }
                try:
                    entry["decoded"] = world.client.results(jid)
                except LookupError:
                    entry["decoded"] = None
                data["jobs"][sc] = entry
    finally:
        anvil.stop()
    print()
    print("DEMO FAILED" if world.failures else "DEMO PASSED: all scenarios settled as expected.")

(OUT / "demo_run.txt").write_text(buf.getvalue())
(OUT / "demo_data.json").write_text(json.dumps(data, indent=1, default=str))
