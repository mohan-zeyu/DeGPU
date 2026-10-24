"""Tests for degpu/tasks/image_classify_v1/runner.py.

The tests that need the demo model and images skip cleanly when they are
missing; run ``uv run python scripts/fetch_demo_assets.py`` to get them.
"""

import io
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from degpu import crypto
from degpu.tasks.image_classify_v1 import runner
from degpu.tasks.image_classify_v1.runner import NUM_CLASSES, Runner, preprocess, runner_hash

ASSETS = Path(__file__).resolve().parent.parent / "assets"
MODEL_PATH = ASSETS / "mobilenetv2.onnx"
IMAGE_PATHS = sorted((ASSETS / "images").glob("*.jpg"))

# ImageNet-1k index of each Imagenette class (wnid is the file name prefix).
IMAGENETTE_TO_IMAGENET = {
    "n01440764": 0, "n02102040": 217, "n02979186": 482, "n03000684": 491, "n03028079": 497,
    "n03394916": 566, "n03417042": 569, "n03425413": 571, "n03445777": 574, "n03888257": 701,
}

needs_assets = pytest.mark.skipif(
    not MODEL_PATH.exists() or len(IMAGE_PATHS) < 200,
    reason="demo assets missing; run scripts/fetch_demo_assets.py",
)


@pytest.fixture(scope="module")
def model_bytes():
    return MODEL_PATH.read_bytes()


@pytest.fixture(scope="module")
def sample_paths():
    # every 10th image: 20 images, 2 from each of the 10 classes
    return IMAGE_PATHS[::10]


@pytest.fixture(scope="module")
def sample_images(sample_paths):
    return [p.read_bytes() for p in sample_paths]


def test_num_classes():
    assert NUM_CLASSES == 1000


def test_runner_hash_is_keccak_of_file():
    expected = crypto.keccak(Path(runner.__file__).read_bytes())
    assert runner_hash() == expected
    assert len(runner_hash()) == 32


def jpeg_bytes(w: int, h: int, mode: str = "RGB") -> bytes:
    rng = np.random.default_rng(0)
    shape = (h, w, 3) if mode == "RGB" else (h, w)  # uint8 (h, w) is mode "L"
    arr = rng.integers(0, 256, size=shape, dtype=np.uint8)
    img = Image.fromarray(arr)
    assert img.mode == mode
    buf = io.BytesIO()
    img.save(buf, format="JPEG")
    return buf.getvalue()


@pytest.mark.parametrize("size", [(160, 213), (300, 160), (224, 224), (1000, 50)])
def test_preprocess_shape_and_type(size):
    x = preprocess(jpeg_bytes(*size))
    assert x.shape == (3, 224, 224)
    assert x.dtype == np.float32
    assert x.flags["C_CONTIGUOUS"]


def test_preprocess_grayscale_becomes_rgb():
    x = preprocess(jpeg_bytes(200, 180, mode="L"))
    assert x.shape == (3, 224, 224)


def test_preprocess_normalisation():
    # a uniform mid-grey image normalises to (0.5 - mean) / std per channel
    buf = io.BytesIO()
    Image.new("RGB", (300, 260), (128, 128, 128)).save(buf, format="PNG")
    x = preprocess(buf.getvalue())
    expected = (128 / 255 - runner.MEAN) / runner.STD
    assert np.allclose(x.mean(axis=(1, 2)), expected, atol=1e-5)


@needs_assets
def test_deterministic_same_runner(model_bytes, sample_images):
    r = Runner(model_bytes)
    first = r.classify(sample_images)
    second = r.classify(sample_images)
    assert first == second
    assert len(first) == 20
    assert all(isinstance(label, int) and 0 <= label < NUM_CLASSES for label in first)


@needs_assets
def test_deterministic_separate_runners(model_bytes, sample_images):
    assert Runner(model_bytes).classify(sample_images) == Runner(model_bytes).classify(sample_images)


@needs_assets
def test_label_does_not_depend_on_batch(model_bytes, sample_images):
    # A verifier runs only a sample and a tie-breaker only the mismatched items,
    # so a subset (in any order) must get the same labels as the full run.
    r = Runner(model_bytes)
    full = r.classify(sample_images)
    subset = [7, 2, 13]
    assert r.classify([sample_images[i] for i in subset]) == [full[i] for i in subset]
    assert [r.classify([img])[0] for img in sample_images[:5]] == full[:5]


@needs_assets
def test_reasonable_accuracy(model_bytes):
    # Not a benchmark: it catches broken preprocessing. On the 200 demo images
    # (160px Imagenette, upscaled to 256) the runner gets about 64% top-1, the
    # same pipeline with BGR channel order about 50%, and garbage input ~0%.
    labels = Runner(model_bytes).classify([p.read_bytes() for p in IMAGE_PATHS])
    truth = [IMAGENETTE_TO_IMAGENET[p.name.split("_")[0]] for p in IMAGE_PATHS]
    correct = sum(a == b for a, b in zip(labels, truth))
    assert correct >= 0.55 * len(IMAGE_PATHS), f"only {correct}/{len(IMAGE_PATHS)} correct"


@needs_assets
def test_classify_empty(model_bytes):
    assert Runner(model_bytes).classify([]) == []


@needs_assets
def test_bad_image_raises(model_bytes):
    with pytest.raises(Exception):
        Runner(model_bytes).classify([b"not an image"])
