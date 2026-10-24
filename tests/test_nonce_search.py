"""Golden vectors for nonce-search-v1, shared with contracts/test/CheckedMarket.t.sol."""

from eth_abi import encode as abi_encode

from degpu import crypto
from degpu.tasks import get

TASK = get("nonce-search-v1")
CHALLENGE = b"\x11" * 32


def test_hash_golden():
    nonce7 = (7).to_bytes(32, "big")
    assert crypto.keccak(abi_encode(["bytes32", "bytes32"], [CHALLENGE, nonce7])).hex() == (
        "ea2cda56caceff556aeeb2756e2c1a820445b6413765d79997510293af0f2e35"
    )


def test_first_nonce_under_2_248_is_218():
    item = TASK.item(CHALLENGE, 2**248)
    assert item == abi_encode(["bytes32", "uint256"], [CHALLENGE, 2**248])
    assert TASK.solve(item) == (218).to_bytes(32, "big")
    assert TASK.check(item, (218).to_bytes(32, "big"))
    assert not TASK.check(item, (217).to_bytes(32, "big"))


def test_target_zero_is_impossible():
    assert TASK.solve(TASK.item(CHALLENGE, 0)) is None


def test_difficulty_sets_the_target():
    (item,) = TASK.items(1, difficulty=12)
    _, target = TASK.decode_item(item)
    assert target == 2 ** (256 - 12)
