"""Calibrate the similarity tolerance of task blender-render-v1 (needs Blender).

    uv run scripts/calibrate_render.py

It renders a few frames of the demo scene in several ways and prints, for each against the
reference (CPU, seed 0), the worst tile's PSNR and whether ``similarity.similar`` accepts it:

* honest re-runs, which must be accepted: the same CPU render again, a CPU render with another
  seed (a pessimistic stand-in for another machine), and a GPU render (Metal on Apple Silicon);
* cheats, which must be rejected: 1/8 and 1/4 of the samples, and ``wrong_output``.

It then suggests a threshold in the middle of the gap, as the value for
``MAX_TILE_MSE_X1000`` in degpu/tasks/blender_render_v1/similarity.py.
"""

from __future__ import annotations

import math
import random
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

from degpu.tasks.blender_render_v1 import render, similarity  # noqa: E402
from degpu.tasks.blender_render_v1.task import DEMO_SCENE, TASK  # noqa: E402

FRAMES = [1, 6, 12]


def ensure_scene(binary: str) -> None:
    if DEMO_SCENE.exists():
        return
    DEMO_SCENE.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run([binary, "-b", "--factory-startup", "--python", str(REPO / "scripts" / "make_demo_scene.py"),
                    "--", str(DEMO_SCENE)], check=True, capture_output=True)


def main() -> int:
    try:
        binary = render.require_blender()
    except render.BlenderError as e:
        print(e)
        return 2
    ensure_scene(binary)
    scene = render.Scene(DEMO_SCENE.read_bytes())
    print(f"Blender {render.blender_version(binary)} at {binary}; frames {FRAMES} of {DEMO_SCENE.name}")
    reference = scene.render(FRAMES)

    cases = [
        ("honest", "CPU again", {}),
        ("honest", "CPU, another seed", {"DEGPU_BLENDER_SEED": "1"}),
        ("honest", "GPU", {"DEGPU_BLENDER_DEVICE": "GPU"}),
        ("cheat", "1/4 of the samples", {"DEGPU_BLENDER_SAMPLE_SCALE": "0.25"}),
        ("cheat", "1/8 of the samples", {"DEGPU_BLENDER_SAMPLE_SCALE": "0.125"}),
    ]
    rows = []
    for kind, label, env in cases:
        try:
            frames = scene.render(FRAMES, env)
        except render.BlenderError as e:
            print(f"  {label}: skipped ({e})")
            continue
        rows.append((kind, label, frames))
    rng = random.Random(1)
    rows.append(("cheat", "wrong_output (degraded)", [TASK.wrong_output(f, rng) for f in reference]))

    print(f"\n  {'case':<28}{'kind':<8}{'worst tile PSNR (dB), per frame':<36}accepted")
    honest_worst, cheat_best = math.inf, 0.0
    for kind, label, frames in rows:
        psnrs = [similarity.min_tile_psnr(r, f) for r, f in zip(reference, frames)]
        accepted = [similarity.similar(r, f) for r, f in zip(reference, frames)]
        shown = ", ".join("inf" if p == math.inf else f"{p:5.1f}" for p in psnrs)
        print(f"  {label:<28}{kind:<8}{shown:<36}{accepted}")
        worst = min(psnrs)
        if kind == "honest":
            honest_worst = min(honest_worst, worst)
        else:
            cheat_best = max(cheat_best, max(psnrs))

    current = 10 * math.log10(255**2 * 1000 / similarity.MAX_TILE_MSE_X1000)
    print(f"\n  current threshold: {current:.1f} dB (MAX_TILE_MSE_X1000 = {similarity.MAX_TILE_MSE_X1000})")
    print(f"  worst honest tile: {honest_worst:.1f} dB, best cheating tile: {cheat_best:.1f} dB")
    if honest_worst <= cheat_best:
        print("  no gap: the honest and cheating renders overlap; tile PSNR can't separate them here")
        return 1
    mid = (honest_worst + cheat_best) / 2 if honest_worst != math.inf else cheat_best + 10
    print(f"  suggested threshold: {mid:.1f} dB -> MAX_TILE_MSE_X1000 = {round(255**2 * 1000 / 10 ** (mid / 10))}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
