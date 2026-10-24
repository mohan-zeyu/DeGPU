"""Golden vectors for key-search-v1, shared with contracts/test/KeySearchChecker.t.sol."""

from eth_abi import encode as abi_encode

from degpu import crypto
from degpu.tasks import get

TASK = get("key-search-v1")
KEY_HASH_42 = bytes.fromhex("beced09521047d05b8960b7e7bcc1d1292cf3e4b2a6b63f48335cbde5f7545d2")


def test_key_hash_golden():
    assert crypto.keccak(abi_encode(["uint256"], [42])) == KEY_HASH_42


def test_finds_42_in_0_to_100():
    item = TASK.item(KEY_HASH_42, 0, 100)
    assert item == abi_encode(["bytes32", "uint256", "uint256"], [KEY_HASH_42, 0, 100])
    assert TASK.solve(item) == (42).to_bytes(32, "big")
    assert TASK.check(item, (42).to_bytes(32, "big"))
    assert not TASK.check(item, (41).to_bytes(32, "big"))


def test_key_outside_the_range_is_not_found_and_not_accepted():
    item = TASK.item(KEY_HASH_42, 43, 100)
    assert TASK.solve(item) is None
    assert not TASK.check(item, (42).to_bytes(32, "big"))
