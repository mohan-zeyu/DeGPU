"""Official runner for task type ``image-classify-v1`` (task type id 1).

The keccak256 of this file's bytes is registered on-chain as the task type's
``runnerHash``, and every provider agent refuses a job if its local copy
hashes differently. Any edit to this file, even whitespace, changes the hash,
so treat it as frozen.

What it does (docs/INTERFACE.md section 5):

* load the client's ONNX classifier into ONNX Runtime on the CPU, with one
  intra-op thread, one inter-op thread and sequential execution, so results
  are reproducible;
* preprocess each image: decode with PIL, convert to RGB, resize the shorter
  side to 256 (bilinear), centre-crop 224x224, scale to [0, 1], normalise
  with the ImageNet mean/std, lay out as NCHW;
* return the argmax of the logits (top-1 class index) for each image.

Each image runs as its own batch of one. That way an item's label depends
only on the model and that item, never on which other items share the batch.
Main providers run all N items, verifiers run only the sample and
tie-breakers only the mismatched items, so they must all get the same label.
"""

from __future__ import annotations

import io
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image

from degpu.crypto import keccak

NUM_CLASSES = 1000

RESIZE_SHORTER = 256
CROP = 224
MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)


def runner_hash() -> bytes:
    """keccak256 of this file's own bytes (the on-chain ``runnerHash``)."""
    return keccak(Path(__file__).read_bytes())


def preprocess(image_bytes: bytes) -> np.ndarray:
    """Turn one encoded image into a float32 array of shape (3, 224, 224)."""
    img = Image.open(io.BytesIO(image_bytes)).convert("RGB")

    # Resize so the shorter side is exactly 256, keeping the aspect ratio.
    # Integer arithmetic (rounded) keeps the target size platform-independent.
    w, h = img.size
    if w <= h:
        new_w, new_h = RESIZE_SHORTER, (h * RESIZE_SHORTER + w // 2) // w
    else:
        new_w, new_h = (w * RESIZE_SHORTER + h // 2) // h, RESIZE_SHORTER
    img = img.resize((new_w, new_h), Image.Resampling.BILINEAR)

    # Centre-crop 224x224.
    left = (new_w - CROP) // 2
    top = (new_h - CROP) // 2
    img = img.crop((left, top, left + CROP, top + CROP))

    arr = np.asarray(img, dtype=np.float32) / 255.0  # HWC in [0, 1]
    arr = (arr - MEAN) / STD
    return np.ascontiguousarray(arr.transpose(2, 0, 1), dtype=np.float32)  # CHW


class Runner:
    """Holds one ONNX Runtime session for the job's model."""

    def __init__(self, model_bytes: bytes):
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = 1
        opts.inter_op_num_threads = 1
        opts.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        self.session = ort.InferenceSession(
            model_bytes, sess_options=opts, providers=["CPUExecutionProvider"]
        )
        self.input_name = self.session.get_inputs()[0].name

    def classify(self, images: list[bytes]) -> list[int]:
        """Return the top-1 class index for each encoded image, in order."""
        labels = []
        for image_bytes in images:
            x = preprocess(image_bytes)[np.newaxis]  # batch of one: (1, 3, 224, 224)
            (logits,) = self.session.run(None, {self.input_name: x})
            labels.append(int(np.argmax(logits[0])))
        return labels
