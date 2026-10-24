"""When two rendered frames count as the same render (task ``blender-render-v1``).

Path-traced frames from honest providers differ slightly (GPU vs CPU, other CPUs), so frames are
compared by similarity, not by hash. Two frames are similar when they have the same size and, on
a ``GRID`` x ``GRID`` grid of tiles, **every** tile is close: its mean squared error over 8-bit RGB
is at most ``MAX_TILE_MSE_X1000 / 1000``. Tiles, not the whole frame, so that a cheat confined to
one region (a skipped object, a pasted patch) still fails.

The test uses only integer arithmetic, so every machine reaches exactly the same answer. This
module is part of the task folder and therefore pinned by the runner hash: the client (deciding
what to dispute) and the tie-breaker (judging) apply the very same rule.
"""

from __future__ import annotations

import io
import math

import numpy as np
from PIL import Image

GRID = 8
#: tolerated mean squared error per tile, x1000. 65025 is 255^2 / 10^3, i.e. a PSNR of 30 dB.
#: Placeholder until scripts/calibrate_render.py has measured honest vs cheating renders.
MAX_TILE_MSE_X1000 = 65025


def decode(png: bytes) -> np.ndarray | None:
    """An image file as an (H, W, 3) uint8 array, or None if it can't be decoded."""
    try:
        with Image.open(io.BytesIO(png)) as img:
            return np.asarray(img.convert("RGB"), dtype=np.uint8)
    except Exception:
        return None


def tile_errors(a: np.ndarray, b: np.ndarray) -> list[tuple[int, int]]:
    """(sum of squared errors, number of values) for every tile of two same-size images."""
    h, w = a.shape[:2]
    rows = [h * k // GRID for k in range(GRID + 1)]
    cols = [w * k // GRID for k in range(GRID + 1)]
    diff = a.astype(np.int64) - b.astype(np.int64)
    sq = diff * diff
    out = []
    for r in range(GRID):
        for c in range(GRID):
            tile = sq[rows[r]:rows[r + 1], cols[c]:cols[c + 1]]
            if tile.size:
                out.append((int(tile.sum()), int(tile.size)))
    return out


def similar(png_a: bytes, png_b: bytes) -> bool:
    """True if the two frames decode, have the same size, and every tile is within the tolerance."""
    a, b = decode(png_a), decode(png_b)
    if a is None or b is None or a.shape != b.shape:
        return False
    return all(sse * 1000 <= MAX_TILE_MSE_X1000 * n for sse, n in tile_errors(a, b))


def min_tile_psnr(png_a: bytes, png_b: bytes) -> float | None:
    """The worst tile's PSNR in dB (inf if identical), for logs and calibration only; None if the
    frames can't be compared."""
    a, b = decode(png_a), decode(png_b)
    if a is None or b is None or a.shape != b.shape:
        return None
    worst = max(sse / n for sse, n in tile_errors(a, b))
    return math.inf if worst == 0 else 10 * math.log10(255**2 / worst)
