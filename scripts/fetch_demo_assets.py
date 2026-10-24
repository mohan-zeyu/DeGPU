"""Download the demo assets for the image-classify-v1 task.

    uv run python scripts/fetch_demo_assets.py

It fetches two things, and skips each one if it is already present:

1. MobileNetV2 (ImageNet, 1000 classes, ONNX opset 12) from the ONNX model zoo
   -> assets/mobilenetv2.onnx (about 14 MB).
2. The Imagenette 160px archive from fast.ai (about 94 MB). From its ``val``
   split it extracts exactly 200 JPEGs, the first 20 per class in sorted
   order, into assets/images/ as ``<wnid>_<NN>.jpg``. The archive is deleted
   afterwards.

At the end it prints the size and sha256 of every file. It uses only the
standard library, so it doesn't depend on the rest of the project.
"""

from __future__ import annotations

import hashlib
import shutil
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
ASSETS = REPO_ROOT / "assets"
MODEL_PATH = ASSETS / "mobilenetv2.onnx"
IMAGES_DIR = ASSETS / "images"

MODEL_URL = (
    "https://github.com/onnx/models/raw/main/validated/vision/classification/"
    "mobilenet/model/mobilenetv2-12.onnx"
)
# sha256 of the file served at MODEL_URL when this script was written. The
# runner's results depend on the exact model, so a different file is an error.
MODEL_SHA256 = "c0c3f76d93fa3fd6580652a45618618a220fced18babf65774ed169de0432ad5"

IMAGENETTE_URL = "https://s3.amazonaws.com/fast-ai-imageclas/imagenette2-160.tgz"
PER_CLASS = 20

# The 10 Imagenette classes, with their ImageNet-1k class index (handy for
# sanity-checking the classifier; MobileNetV2 outputs these indices).
IMAGENETTE_CLASSES = {
    "n01440764": (0, "tench"),
    "n02102040": (217, "English springer"),
    "n02979186": (482, "cassette player"),
    "n03000684": (491, "chain saw"),
    "n03028079": (497, "church"),
    "n03394916": (566, "French horn"),
    "n03417042": (569, "garbage truck"),
    "n03425413": (571, "gas pump"),
    "n03445777": (574, "golf ball"),
    "n03888257": (701, "parachute"),
}
NUM_IMAGES = PER_CLASS * len(IMAGENETTE_CLASSES)  # 200


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def download(url: str, dest: Path) -> None:
    """Stream ``url`` to ``dest`` with a simple progress indicator."""
    print(f"downloading {url}")
    tmp = dest.with_name(dest.name + ".part")
    with urllib.request.urlopen(url) as resp, open(tmp, "wb") as out:
        total = int(resp.headers.get("Content-Length") or 0)
        done = 0
        while chunk := resp.read(1 << 20):
            out.write(chunk)
            done += len(chunk)
            if total:
                print(f"\r  {done / 1e6:6.1f} / {total / 1e6:.1f} MB", end="", flush=True)
    print()
    tmp.replace(dest)


def fetch_model() -> None:
    if MODEL_PATH.exists() and MODEL_PATH.stat().st_size > 0:
        print(f"model already present: {MODEL_PATH}")
    else:
        download(MODEL_URL, MODEL_PATH)
    digest = sha256_file(MODEL_PATH)
    if digest != MODEL_SHA256:
        sys.exit(
            f"error: {MODEL_PATH} has sha256 {digest}, expected {MODEL_SHA256}. "
            "Delete it and re-run, or update MODEL_SHA256 if the zoo file changed."
        )


def existing_images() -> list[Path]:
    return sorted(IMAGES_DIR.glob("*.jpg")) if IMAGES_DIR.exists() else []


def fetch_images() -> None:
    if len(existing_images()) == NUM_IMAGES:
        print(f"images already present: {IMAGES_DIR} ({NUM_IMAGES} files)")
        return

    # Start from a clean folder so a half-finished earlier run can't leave extras.
    if IMAGES_DIR.exists():
        shutil.rmtree(IMAGES_DIR)
    IMAGES_DIR.mkdir(parents=True)

    # The archive goes in its own fresh temp dir, which is removed at the end.
    with tempfile.TemporaryDirectory(dir=ASSETS, prefix=".download-") as tmpdir:
        archive = Path(tmpdir) / "imagenette2-160.tgz"
        download(IMAGENETTE_URL, archive)

        # Pass 1: list the val JPEGs per class and pick the first 20 of each
        # in sorted order, so every run selects the same files.
        by_class: dict[str, list[str]] = {wnid: [] for wnid in IMAGENETTE_CLASSES}
        with tarfile.open(archive, "r:gz") as tar:
            for m in tar.getmembers():
                parts = m.name.split("/")
                # expected: imagenette2-160/val/<wnid>/<file>.JPEG
                if (
                    m.isfile()
                    and len(parts) == 4
                    and parts[1] == "val"
                    and parts[2] in by_class
                    and parts[3].lower().endswith(".jpeg")
                ):
                    by_class[parts[2]].append(m.name)

        chosen: dict[str, str] = {}  # member name -> output file name
        for wnid, names in by_class.items():
            names.sort()
            if len(names) < PER_CLASS:
                sys.exit(f"error: only {len(names)} val images for {wnid}")
            for j, name in enumerate(names[:PER_CLASS]):
                chosen[name] = f"{wnid}_{j:02d}.jpg"

        # Pass 2: stream through the archive once more and copy just the chosen
        # members. We read their bytes and write our own file names, so nothing
        # else in the archive ever touches the disk.
        with tarfile.open(archive, "r:gz") as tar:
            for m in tar:
                out_name = chosen.get(m.name)
                if out_name is None:
                    continue
                f = tar.extractfile(m)
                data = f.read() if f else b""
                if not data.startswith(b"\xff\xd8"):
                    sys.exit(f"error: {m.name} is not a JPEG")
                (IMAGES_DIR / out_name).write_bytes(data)
        # leaving the with-block deletes the archive

    n = len(existing_images())
    if n != NUM_IMAGES:
        sys.exit(f"error: extracted {n} images, expected {NUM_IMAGES}")


def report() -> None:
    size = MODEL_PATH.stat().st_size
    print(f"\n{MODEL_PATH.relative_to(REPO_ROOT)}  {size:>10,d} bytes  sha256 {sha256_file(MODEL_PATH)}")

    combined = hashlib.sha256()
    total = 0
    for p in existing_images():
        digest = sha256_file(p)
        size = p.stat().st_size
        total += size
        combined.update(bytes.fromhex(digest))
        print(f"{p.relative_to(REPO_ROOT)}  {size:>8,d} bytes  sha256 {digest}")
    print(
        f"\n{len(existing_images())} images, {total:,d} bytes in total; "
        f"sha256 over the sorted per-file sha256s: {combined.hexdigest()}"
    )


def main() -> None:
    ASSETS.mkdir(exist_ok=True)
    fetch_model()
    fetch_images()
    report()


if __name__ == "__main__":
    main()
