"""Task type ``blender-render-v1``: render frames of a Blender scene with Cycles.

Mode: replicated, compared by **similarity** (a ``SimilarTask``). Path-traced frames from honest
providers differ slightly between machines and devices, so they are not compared by hash:

* shared blob = the client's ``.blend`` file (pack its resources: File > External Data > Pack
  Resources), items = frame numbers;
* each output is a PNG file of one frame, rendered with the settings ``render.py`` forces;
* two frames agree if every tile of an 8x8 grid is within the tolerance in ``similarity.py``.

Providers need Blender (the pinned major.minor, see ``render.BLENDER_VERSION``); an agent
without it doesn't offer the task.
"""

from __future__ import annotations

import io
import random
from pathlib import Path

import numpy as np
from PIL import Image

from degpu.tasks.base import ETHER, ReplicatedInputs, SimilarTask
from degpu.tasks.blender_render_v1 import render, similarity

REPO = Path(__file__).resolve().parents[3]
DEMO_SCENE = REPO / "assets" / "demo_scene.blend"


def parse_frames(spec: str) -> list[int]:
    """"1-12" or "1,4,7" or "1-3,10" -> frame numbers, in order."""
    frames: list[int] = []
    for part in spec.split(","):
        a, _, b = part.strip().partition("-")
        frames.extend(range(int(a), int(b) + 1) if b else [int(a)])
    return frames


class BlenderRender(SimilarTask):
    name = "blender-render-v1"
    description = "render frames of a .blend scene with Blender Cycles"
    default_price = ETHER // 1000  # 0.001 ETH per frame
    seconds_per_item = 30
    output_suffix = ".png"
    uploads = {"scene": "file"}

    def __init__(self):
        self._available: bool | None = None

    def add_cli_args(self, parser):
        parser.add_argument("--scene", default=str(DEMO_SCENE), help=".blend file (with packed resources)")
        parser.add_argument("--frames", default="1-12", help='frames to render, e.g. "1-12" or "1,5,9"')

    def prepare(self, args) -> ReplicatedInputs:
        return self.inputs(args.scene, parse_frames(args.frames))

    def inputs(self, scene_path, frames: list[int]) -> ReplicatedInputs:
        return ReplicatedInputs(shared=Path(scene_path).read_bytes(), items=[b"%d" % f for f in frames])

    def available(self) -> bool:
        if self._available is None:
            try:
                render.require_blender()
                self._available = True
            except render.BlenderError:
                self._available = False
        return self._available

    def example_inputs(self) -> ReplicatedInputs | None:
        if not self.available() or not DEMO_SCENE.exists():
            return None
        return self.inputs(DEMO_SCENE, [1, 6])

    # -- provider side -----------------------------------------------------------

    def load(self, shared: bytes | None) -> render.Scene:
        return render.Scene(shared)

    def run(self, scene: render.Scene, items: list[bytes]) -> list[bytes]:
        return scene.render([int(item) for item in items])

    # -- both sides ----------------------------------------------------------------

    def similar(self, a: bytes, b: bytes) -> bool:
        return similarity.similar(a, b)

    # -- client side -------------------------------------------------------------------

    def present(self, output: bytes | None) -> bytes | None:
        return output  # the PNG itself; `client results --out DIR` writes the files

    # -- demo behaviours -----------------------------------------------------------------

    def wrong_output(self, output: bytes, rng: random.Random) -> bytes:
        """A low-effort frame: rendered at a quarter of the resolution, upscaled, and noisy."""
        arr = similarity.decode(output)
        if arr is None:
            return b""
        h, w = arr.shape[:2]
        img = Image.fromarray(arr).resize((max(1, w // 4), max(1, h // 4))).resize((w, h))
        noisy = np.asarray(img, dtype=np.int64) + np.array(
            [rng.randint(-40, 40) for _ in range(h * w * 3)]).reshape(h, w, 3)
        buf = io.BytesIO()
        Image.fromarray(np.clip(noisy, 0, 255).astype(np.uint8), "RGB").save(buf, "PNG")
        return buf.getvalue()


TASK = BlenderRender()
