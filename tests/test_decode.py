"""Tests for degpu/tasks/image_classify_v1/decode.py."""

import os
import random

from eth_abi import encode as abi_encode

from degpu import crypto
from degpu.tasks.image_classify_v1.decode import decode_labels, leaf_preimage


def test_manual_preimage_equals_abi_encode():
    rng = random.Random(1)
    for _ in range(200):
        salt = rng.randbytes(32)
        i = rng.randrange(2**40)
        label = rng.randrange(2**40)
        assert leaf_preimage(salt, i, label) == abi_encode(
            ["bytes32", "uint256", "uint256"], [salt, i, label]
        )
    assert crypto.keccak(leaf_preimage(b"\x11" * 32, 3, 207)) == crypto.leaf(b"\x11" * 32, 3, 207)


def test_round_trip_200_random_labels():
    rng = random.Random(42)
    salt = rng.randbytes(32)
    labels = [rng.randrange(1000) for _ in range(200)]
    labels[0], labels[1] = 0, 999  # include both ends of the range
    leaves = [crypto.leaf(salt, i, label) for i, label in enumerate(labels)]
    assert decode_labels(salt, leaves) == labels


def test_unmatched_leaf_gives_none():
    salt = os.urandom(32)
    labels = [5, 17, 300, 999]
    leaves = [crypto.leaf(salt, i, label) for i, label in enumerate(labels)]
    leaves[1] = os.urandom(32)                       # random garbage
    leaves[2] = crypto.leaf(salt, 7, 300)            # right label, wrong index
    leaves[3] = crypto.leaf(os.urandom(32), 3, 999)  # wrong salt
    assert decode_labels(salt, leaves) == [5, None, None, None]


def test_num_classes_limits_search():
    salt = os.urandom(32)
    leaves = [crypto.leaf(salt, 0, 3), crypto.leaf(salt, 1, 12)]
    assert decode_labels(salt, leaves, num_classes=10) == [3, None]
    assert decode_labels(salt, leaves, num_classes=13) == [3, 12]


def test_accepts_bytes_subclasses():
    # web3 hands back HexBytes, a bytes subclass
    class FakeHexBytes(bytes):
        pass

    salt = os.urandom(32)
    leaves = [FakeHexBytes(crypto.leaf(salt, 0, 42))]
    assert decode_labels(FakeHexBytes(salt), leaves) == [42]


def test_empty():
    assert decode_labels(os.urandom(32), []) == []
