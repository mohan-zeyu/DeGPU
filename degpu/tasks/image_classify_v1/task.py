"""Task type ``image-classify-v1``: top-1 ImageNet classification with the client's ONNX model.

Mode: replicated. The shared blob is the ONNX model, each item is an encoded image, and each
item's word is its top-1 class index as a 32-byte big-endian integer (so a leaf is
``keccak256(abi.encode(jobSalt, i, uint256 label))``).
"""

from __future__ import annotations

from pathlib import Path

from degpu.tasks.base import ETHER, ReplicatedInputs, ReplicatedTask
from degpu.tasks.image_classify_v1.runner import NUM_CLASSES, Runner

REPO = Path(__file__).resolve().parents[3]
DEFAULT_MODEL = REPO / "assets" / "mobilenetv2.onnx"
DEFAULT_IMAGES = REPO / "assets" / "images"


def _word(label: int) -> bytes:
    return label.to_bytes(32, "big")


class ImageClassify(ReplicatedTask):
    name = "image-classify-v1"
    description = "top-1 ImageNet label per image, with your ONNX model"
    default_price = ETHER // 10_000  # 0.0001 ETH per image
    seconds_per_item = 1
    uploads = {"model": "file", "images": "files"}

    def add_cli_args(self, parser):
        parser.add_argument("--model", default=str(DEFAULT_MODEL), help="ONNX classifier")
        parser.add_argument("--images", default=str(DEFAULT_IMAGES), help="directory of .jpg files")
        parser.add_argument("--limit", type=int, default=200, help="use the first N images")

    def prepare(self, args) -> ReplicatedInputs:
        return self.inputs(args.model, sorted(Path(args.images).glob("*.jpg"))[: args.limit])

    def inputs(self, model_path, image_paths) -> ReplicatedInputs:
        """Inputs from a model file and image files."""
        return ReplicatedInputs(
            shared=Path(model_path).read_bytes(),
            items=[Path(p).read_bytes() for p in image_paths],
        )

    def example_inputs(self) -> ReplicatedInputs | None:
        images = sorted(DEFAULT_IMAGES.glob("*.jpg"))[::40]  # 5 images from different classes
        if not DEFAULT_MODEL.exists() or len(images) < 5:
            return None
        return self.inputs(DEFAULT_MODEL, images)

    def load(self, shared: bytes | None) -> Runner:
        return Runner(shared)

    def run(self, state: Runner, items: list[bytes]) -> list[bytes]:
        return [_word(label) for label in state.classify(items)]

    def candidates(self) -> list[bytes]:
        return [_word(label) for label in range(NUM_CLASSES)]

    def present(self, word: bytes | None) -> int | None:
        return None if word is None else int.from_bytes(word, "big")


TASK = ImageClassify()
