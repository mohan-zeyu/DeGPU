"""Test-only similar task ``fake-render-v1``: a stand-in for a renderer that needs no Blender.

Each item is a frame number. ``run`` draws a procedural gradient for the frame and adds a little
random jitter, so two honest runs are similar but not bit-identical, like path-traced frames from
different machines. It uses the real render task's similarity rule. The tests inject it into the
task registry (it is not installed under degpu/tasks/).
"""

from __future__ import annotations

import io
import random

import numpy as np
from PIL import Image

from degpu.tasks.base import ETHER, ReplicatedInputs, SimilarTask
from degpu.tasks.blender_render_v1 import similarity

W, H = 48, 32
JITTER = 3  # honest noise per pixel value; a degraded frame gets far more


def _png(arr: np.ndarray) -> bytes:
    buf = io.BytesIO()
    Image.fromarray(arr.astype(np.uint8), "RGB").save(buf, "PNG")
    return buf.getvalue()


class FakeRender(SimilarTask):
    name = "fake-render-v1"
    description = "test-only procedural 'renderer' with per-run jitter"
    default_price = ETHER // 1000
    seconds_per_item = 1
    output_suffix = ".png"

    def prepare(self, args) -> ReplicatedInputs:
        return self.inputs(8)

    def inputs(self, frames: int, scene: bytes = b"scene-7") -> ReplicatedInputs:
        return ReplicatedInputs(shared=scene, items=[b"%d" % f for f in range(frames)])

    def example_inputs(self) -> ReplicatedInputs:
        return self.inputs(4)

    def load(self, shared: bytes | None):
        return int.from_bytes((shared or b"\x00")[:4].ljust(4, b"\x00"), "big")

    def run(self, seed: int, items: list[bytes]) -> list[bytes]:
        rng = random.Random()  # fresh noise on every run, like another machine
        ys, xs = np.mgrid[0:H, 0:W]
        out = []
        for item in items:
            f = int(item)
            base = np.stack([(xs * 5 + f * 9 + seed) % 256, (ys * 7 + f * 3) % 256, (xs + ys + f * 11) % 256], -1)
            noise = np.array([rng.randint(-JITTER, JITTER) for _ in range(H * W * 3)]).reshape(H, W, 3)
            out.append(_png(np.clip(base + noise, 0, 255)))
        return out

    def similar(self, a: bytes, b: bytes) -> bool:
        return similarity.similar(a, b)

    def present(self, output: bytes | None):
        return output

    def wrong_output(self, output: bytes, rng: random.Random) -> bytes:
        arr = similarity.decode(output).astype(np.int64)
        arr[: H // 2] = 255 - arr[: H // 2]  # a visibly wrong top half
        return _png(np.clip(arr, 0, 255))


TASK = FakeRender()
