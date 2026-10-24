"""Task type ``nonce-search-v1``: mining-style proof of work.

Mode: checked. Checker contract: ``contracts/src/checkers/NonceChecker.sol``.

* item   = ``abi.encode(bytes32 challenge, uint256 target)``
* answer = a 32-byte nonce such that ``uint256(keccak256(abi.encode(challenge, nonce))) < target``

With ``target = 2**(256 - d)`` a random nonce qualifies with probability ``2**-d``, so a puzzle
takes about ``2**d`` hashes to solve and one hash to check. The solver tries nonces
0, 1, 2, ... up to ``max_tries`` and reports "not found" after that (target 0 has no solution).
"""

from __future__ import annotations

import os

from Crypto.Hash import keccak as _keccak
from eth_abi import decode as abi_decode
from eth_abi import encode as abi_encode

from degpu.tasks.base import ETHER, CheckedTask


def _hash_int(challenge: bytes, nonce: bytes) -> int:
    # abi.encode(bytes32, bytes32) is the two words concatenated
    return int.from_bytes(_keccak.new(data=challenge + nonce, digest_bits=256).digest(), "big")


class NonceSearch(CheckedTask):
    name = "nonce-search-v1"
    description = "find a nonce whose hash is below a target (mining)"
    checker_contract = "NonceChecker"
    default_price = ETHER // 10_000  # 0.0001 ETH per puzzle
    seconds_per_item = 2
    #: solver budget per puzzle: nonces 0 .. max_tries - 1
    max_tries = 2**20

    def add_cli_args(self, parser):
        parser.add_argument("--puzzles", type=int, default=20, help="number of puzzles")
        parser.add_argument("--difficulty", type=int, default=16,
                            help="bits of work per puzzle: about 2^d hashes to solve (default 16)")
        parser.add_argument("--impossible", type=int, default=0,
                            help="also add N puzzles with target 0 (no solution, to see the refund)")

    def prepare(self, args) -> list[bytes]:
        return self.items(args.puzzles, args.difficulty, args.impossible)

    def example_inputs(self) -> list[bytes]:
        return self.items(4, difficulty=8, impossible=1)

    def items(self, n: int, difficulty: int = 16, impossible: int = 0) -> list[bytes]:
        """``n`` puzzles with random challenges at ``difficulty`` bits, then ``impossible`` unsolvable ones."""
        target = 2 ** (256 - difficulty)
        return [self.item(os.urandom(32), target) for _ in range(n)] + [
            self.item(os.urandom(32), 0) for _ in range(impossible)
        ]

    @staticmethod
    def item(challenge: bytes, target: int) -> bytes:
        return abi_encode(["bytes32", "uint256"], [challenge, target])

    @staticmethod
    def decode_item(item: bytes) -> tuple[bytes, int]:
        challenge, target = abi_decode(["bytes32", "uint256"], item)
        return bytes(challenge), int(target)

    def solve(self, item: bytes) -> bytes | None:
        challenge, target = self.decode_item(item)
        if target == 0:
            return None
        for n in range(self.max_tries):
            nonce = n.to_bytes(32, "big")
            if _hash_int(challenge, nonce) < target:
                return nonce
        return None

    def check(self, item: bytes, answer: bytes) -> bool:
        challenge, target = self.decode_item(item)
        return len(answer) == 32 and _hash_int(challenge, bytes(answer)) < target

    def present(self, item: bytes, answer: bytes | None) -> int | None:
        """The nonce found for the puzzle, or None."""
        return None if answer is None else int.from_bytes(answer, "big")


TASK = NonceSearch()
