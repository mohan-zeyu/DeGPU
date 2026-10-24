"""Tests for crypto.decode_leaves (recovering result words from published leaves)."""

import random

from eth_abi import encode as abi_encode

from degpu import crypto

LABELS = [crypto.word(i) for i in range(1000)]


def test_word_encodes_like_uint256():
    assert crypto.word(207) == abi_encode(["uint256"], [207])
    assert crypto.word(b"\x07" * 32) == b"\x07" * 32
    # an int word gives the same leaf as abi.encode(jobSalt, i, uint256 label)
    salt = b"\x11" * 32
    assert crypto.leaf(salt, 3, 207) == crypto.keccak(abi_encode(["bytes32", "uint256", "uint256"], [salt, 3, 207]))
    assert crypto.leaf(salt, 3, 207) == crypto.leaf(salt, 3, crypto.word(207))


def test_round_trip_200_random_labels():
    rng = random.Random(42)
    salt = rng.randbytes(32)
    labels = [rng.randrange(1000) for _ in range(200)]
    labels[0], labels[1] = 0, 999  # include both ends of the range
    leaves = [crypto.leaf(salt, i, label) for i, label in enumerate(labels)]
    assert crypto.decode_leaves(salt, leaves, LABELS) == [crypto.word(x) for x in labels]


def test_unmatched_leaf_gives_none():
    salt = b"\x22" * 32
    leaves = [crypto.leaf(salt, 0, 5), crypto.leaf(b"\x33" * 32, 1, 5), crypto.leaf(salt, 7, 5), b"\x00" * 32]
    # wrong salt, leaf from another index, garbage
    assert crypto.decode_leaves(salt, leaves, LABELS) == [crypto.word(5), None, None, None]


def test_candidates_limit_the_search():
    salt = b"\x44" * 32
    leaves = [crypto.leaf(salt, 0, 3), crypto.leaf(salt, 1, 12)]
    assert crypto.decode_leaves(salt, leaves, LABELS[:10]) == [crypto.word(3), None]


def test_accepts_bytes_subclasses():
    class HexBytesLike(bytes):
        pass

    salt = b"\x55" * 32
    leaves = [HexBytesLike(crypto.leaf(salt, 0, 42))]
    assert crypto.decode_leaves(salt, leaves, LABELS) == [crypto.word(42)]


def test_empty():
    assert crypto.decode_leaves(b"\x00" * 32, [], LABELS) == []
