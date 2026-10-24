"""The similarity rule of blender-render-v1 (degpu/tasks/blender_render_v1/similarity.py), on
synthetic images: no Blender needed."""

import io
import math

import numpy as np
from PIL import Image

from degpu.tasks.blender_render_v1 import similarity
from degpu.tasks.blender_render_v1.task import parse_frames

H, W = 64, 96  # an 8x8 grid of 8x12-pixel tiles


def png(arr) -> bytes:
    buf = io.BytesIO()
    Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), "RGB").save(buf, "PNG")
    return buf.getvalue()


def base() -> np.ndarray:
    ys, xs = np.mgrid[0:H, 0:W]
    return np.stack([xs * 2, ys * 3, (xs + ys) % 256], -1).astype(np.int64)


def test_identical_frames_are_similar():
    a = png(base())
    assert similarity.similar(a, a)
    assert similarity.min_tile_psnr(a, a) == math.inf


def test_small_noise_everywhere_is_similar():
    rng = np.random.default_rng(1)
    a, b = png(base()), png(base() + rng.integers(-3, 4, (H, W, 3)))
    assert similarity.similar(a, b) and similarity.similar(b, a)
    assert similarity.min_tile_psnr(a, b) > 35


def test_a_wrong_patch_in_one_tile_is_caught():
    # 1 of 64 tiles is very wrong: the whole-frame error is small, but the tile check fails
    wrong = base()
    wrong[0:8, 0:12] = 255 - wrong[0:8, 0:12]
    a, b = png(base()), png(wrong)
    assert not similarity.similar(a, b)
    whole_mse = float(((base() - wrong) ** 2).mean())
    assert 10 * math.log10(255**2 / whole_mse) > 15  # only a few dB worse over the whole frame


def test_threshold_is_exact_integer_arithmetic():
    # every value off by d: per-tile MSE = d^2. 30 dB allows MSE 65.025: d = 8 passes, d = 9 fails.
    a = png(np.full((H, W, 3), 100))
    assert similarity.similar(a, png(np.full((H, W, 3), 108)))
    assert not similarity.similar(a, png(np.full((H, W, 3), 109)))


def test_different_sizes_and_garbage_are_not_similar():
    a = png(base())
    assert not similarity.similar(a, png(base()[:, :-1]))
    assert not similarity.similar(a, b"")
    assert not similarity.similar(b"\x89PNG not really", a)
    assert similarity.min_tile_psnr(a, b"") is None


def test_parse_frames():
    assert parse_frames("1-4") == [1, 2, 3, 4]
    assert parse_frames("1,5,9") == [1, 5, 9]
    assert parse_frames("1-3,10") == [1, 2, 3, 10]
