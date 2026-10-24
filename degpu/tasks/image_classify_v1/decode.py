"""Recover labels from published result leaves (task ``image-classify-v1``).

A leaf is ``keccak256(abi.encode(bytes32 jobSalt, uint256 i, uint256 label))``
(see ``degpu.crypto.leaf``). Only someone who knows ``jobSalt`` can invert
it, and with at most 1000 classes that is cheap: try every label.

For speed this builds the 96-byte ``abi.encode`` preimage by hand instead of
calling ``eth_abi.encode`` 200 000 times. Static types in ``abi.encode`` are
just concatenated 32-byte words (a bytes32 as-is, a uint256 big-endian), so
the preimage is ``jobSalt || i (32 bytes) || label (32 bytes)``.
tests/test_decode.py checks that this equals ``eth_abi.encode``.
"""

from __future__ import annotations

from Crypto.Hash import keccak as _keccak


def leaf_preimage(job_salt: bytes, i: int, label: int) -> bytes:
    """``abi.encode(bytes32 job_salt, uint256 i, uint256 label)``, built by hand."""
    if len(job_salt) != 32:
        raise ValueError("job_salt must be 32 bytes")
    return bytes(job_salt) + i.to_bytes(32, "big") + label.to_bytes(32, "big")


def decode_labels(job_salt: bytes, leaves: list[bytes], num_classes: int = 1000) -> list[int | None]:
    """Return the label of each leaf, or ``None`` if no class in
    ``0..num_classes-1`` produces it (a wrong salt, index or forged leaf).
    """
    if len(job_salt) != 32:
        raise ValueError("job_salt must be 32 bytes")
    salt = bytes(job_salt)
    # The label words are the same for every item, so build them once.
    label_words = [label.to_bytes(32, "big") for label in range(num_classes)]

    labels: list[int | None] = []
    for i, target in enumerate(leaves):
        target = bytes(target)  # accept HexBytes and other bytes-likes
        prefix = salt + i.to_bytes(32, "big")
        found = None
        for label, word in enumerate(label_words):
            if _keccak.new(data=prefix + word, digest_bits=256).digest() == target:
                found = label
                break
        labels.append(found)
    return labels
