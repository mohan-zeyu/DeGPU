"""Task type ``key-search-v1``: brute-force a key hidden in a range.

Mode: checked. Checker contract: ``contracts/src/checkers/KeySearchChecker.sol``.

* item   = ``abi.encode(bytes32 keyHash, uint256 lo, uint256 hi)``
* answer = the key ``k`` as a uint256, valid if ``lo <= k < hi`` and
  ``keccak256(abi.encode(k)) == keyHash``

The client hides a random key in a range of ``2**bits`` values and posts only its hash, so a
puzzle takes up to ``2**bits`` hashes to solve and one to check. The solver tries the range in
order, up to ``max_tries`` keys.
"""

from __future__ import annotations

import os
import secrets

from Crypto.Hash import keccak as _keccak
from eth_abi import decode as abi_decode
from eth_abi import encode as abi_encode

from degpu.tasks.base import ETHER, CheckedTask


def _key_hash(key: int) -> bytes:
    # abi.encode(uint256 k) is the 32-byte big-endian word
    return _keccak.new(data=key.to_bytes(32, "big"), digest_bits=256).digest()


class KeySearch(CheckedTask):
    name = "key-search-v1"
    description = "find the key in a range that hashes to a given value"
    checker_contract = "KeySearchChecker"
    default_price = ETHER // 10_000  # 0.0001 ETH per key
    seconds_per_item = 2
    #: solver budget per puzzle: the first max_tries keys of the range
    max_tries = 2**20

    def add_cli_args(self, parser):
        parser.add_argument("--keys", type=int, default=10, help="number of hidden keys")
        parser.add_argument("--bits", type=int, default=16, help="each key hides among 2^bits values (default 16)")

    def prepare(self, args) -> list[bytes]:
        return self.items(args.keys, args.bits)

    def example_inputs(self) -> list[bytes]:
        # three solvable puzzles, and one whose key lies outside its range
        lo = 1000
        return self.items(3, bits=8) + [self.item(_key_hash(lo - 1), lo, lo + 256)]

    def items(self, n: int, bits: int = 16) -> list[bytes]:
        """``n`` puzzles, each hiding a random key in a random range of ``2**bits`` values."""
        out = []
        for _ in range(n):
            lo = int.from_bytes(os.urandom(16), "big")
            key = lo + secrets.randbelow(2**bits)
            out.append(self.item(_key_hash(key), lo, lo + 2**bits))
        return out

    @staticmethod
    def item(key_hash: bytes, lo: int, hi: int) -> bytes:
        return abi_encode(["bytes32", "uint256", "uint256"], [key_hash, lo, hi])

    @staticmethod
    def decode_item(item: bytes) -> tuple[bytes, int, int]:
        key_hash, lo, hi = abi_decode(["bytes32", "uint256", "uint256"], item)
        return bytes(key_hash), int(lo), int(hi)

    def solve(self, item: bytes) -> bytes | None:
        key_hash, lo, hi = self.decode_item(item)
        for key in range(lo, min(hi, lo + self.max_tries)):
            if _key_hash(key) == key_hash:
                return key.to_bytes(32, "big")
        return None

    def check(self, item: bytes, answer: bytes) -> bool:
        key_hash, lo, hi = self.decode_item(item)
        if len(answer) != 32:
            return False
        key = int.from_bytes(answer, "big")
        return lo <= key < hi and _key_hash(key) == key_hash

    def present(self, item: bytes, answer: bytes | None) -> int | None:
        """The key found, or None."""
        return None if answer is None else int.from_bytes(answer, "big")


TASK = KeySearch()
