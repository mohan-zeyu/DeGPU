"""Tests for degpu/crypto.py: golden vectors (INTERFACE.md sections 2 and 3),
sealing and encryption round trips, and the input-integrity check."""

import json
from pathlib import Path

import pytest
from eth_abi import encode as abi_encode
from nacl.exceptions import CryptoError
from nacl.public import PrivateKey

from degpu import crypto
from degpu.storage import Store


def b32(byte: int) -> bytes:
    """``0x11..`` in the spec: 32 copies of one byte."""
    return bytes([byte]) * 32


def h(hex_str: str) -> bytes:
    return bytes.fromhex(hex_str.removeprefix("0x"))


S11 = b32(0x11)
LEAF_0_1 = crypto.leaf(S11, 0, 1)
LEAF_1_2 = crypto.leaf(S11, 1, 2)


# --- golden vectors, INTERFACE.md section 2 ---------------------------------

def test_leaf_golden():
    assert crypto.leaf(S11, 3, 207) == h("0x9ffba109988ddb050a38d005f452309a2eabcf5a46a97621effdcf26c3e47508")
    assert LEAF_0_1 == h("0x7d7e572375c6eba8aac2779e4f5875bc01e37283fea38bb0535cb4cee76c8b8c")
    assert LEAF_1_2 == h("0xb17ae73b7d48db18adabbd31559bb80228399275ca5c82acdab14f1017480997")


def test_results_commit_golden():
    assert crypto.results_commit([LEAF_0_1, LEAF_1_2]) == h(
        "0x661107b6de8f058afd1c33983e60828b39a7b9bb77e45cd34feecff91a377be0"
    )


def test_verify_commit_golden():
    assert crypto.verify_commit(b32(0x88), True) == h(
        "0xa2f6db48e4217cc07583f9ea52bd1fc0e90a717552373e82eea50b3a6ff9c928"
    )
    assert crypto.verify_commit(b32(0x88), False) == h(
        "0x571c2a6cc17bceba7d421165d8f2117dc954cbf951b4ebbb0cf9b95697b23540"
    )


def test_check_commit_golden():
    assert crypto.check_commit(b32(0x33), [LEAF_0_1, LEAF_1_2]) == h(
        "0x50ea9093e9d3cc68aa0d194796a05d23b83e807ff05aabb344f341ff9b6159d3"
    )


def test_data_hash_golden():
    assert crypto.data_hash(b32(0x44), [b32(0x55), b32(0x66)]) == h(
        "0x04ca3cee6744183786df649e62c82e681a1cc158de1e3a465006d79d9b48bdd3"
    )


# --- golden vectors, INTERFACE.md section 3 ---------------------------------

K_JOB = b32(0x77)


def test_job_salt_golden():
    assert crypto.job_salt(K_JOB) == h("0xe498e837d1aa76f441e8e27856448c4991f2e73b5d94dcf8745c92e68656ce64")


def test_shared_key_golden():
    assert crypto.shared_key(K_JOB) == h("0x25e5692a3174ace83b0eefef011757a926e43a5b61a64bb883b2e073b6d7cbf9")


def test_item_key_golden():
    assert crypto.item_key(K_JOB, 0) == h("0xcec66a1d2630bc67481343ce2eafb0a2666b92197c4ceb08017943cc4e277279")


def test_derived_keys_are_distinct():
    keys = {crypto.job_salt(K_JOB), crypto.shared_key(K_JOB)}
    keys |= {crypto.item_key(K_JOB, i) for i in range(50)}
    assert len(keys) == 52
    assert all(len(k) == 32 for k in keys)


def test_hkdf_rfc5869_case3():
    # RFC 5869 test case 3: SHA-256, zero-length salt and info. We output only
    # the first 32 bytes of the 42-byte OKM.
    okm = h("8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8")
    assert crypto.hkdf32(b"\x0b" * 22, b"") == okm[:32]


def test_keccak_known_value():
    # keccak256("") (Ethereum's, not SHA3-256's)
    assert crypto.keccak(b"") == h("c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470")


def test_commitments_use_abi_encode():
    # Sanity check against eth_abi directly, with values beyond one byte.
    assert crypto.leaf(S11, 300, 999) == crypto.keccak(
        abi_encode(["bytes32", "uint256", "uint256"], [S11, 300, 999])
    )
    assert crypto.results_commit([]) == crypto.keccak(abi_encode(["bytes32[]"], [[]]))


# --- provider keys and sealed payloads --------------------------------------

def test_generate_keypair():
    priv, pub = crypto.generate_keypair()
    assert len(priv) == 32 and len(pub) == 32
    assert bytes(PrivateKey(priv).public_key) == pub
    assert crypto.generate_keypair()[0] != priv


def test_seal_unseal_round_trip():
    priv, pub = crypto.generate_keypair()
    payload = {
        "job_salt": "0x" + crypto.job_salt(K_JOB).hex(),
        "shared_key": "0x" + crypto.shared_key(K_JOB).hex(),
        "sample_salt": "0x" + b32(0x22).hex(),
        "indices": [0, 5, 9],
        "item_keys": {str(i): "0x" + crypto.item_key(K_JOB, i).hex() for i in (0, 5, 9)},
    }
    blob = crypto.seal(pub, payload)
    assert isinstance(blob, bytes)
    assert b"job_salt" not in blob  # it really is encrypted
    assert crypto.unseal(priv, blob) == payload


def test_seal_for_main_payload():
    priv, pub = crypto.generate_keypair()
    payload = {"k_job": "0x" + K_JOB.hex()}
    assert crypto.unseal(priv, crypto.seal(pub, payload)) == payload


def test_unseal_wrong_key_fails():
    _, pub = crypto.generate_keypair()
    other_priv, _ = crypto.generate_keypair()
    blob = crypto.seal(pub, {"k_job": "0x" + K_JOB.hex()})
    with pytest.raises(CryptoError):
        crypto.unseal(other_priv, blob)


# --- file encryption ---------------------------------------------------------

def test_encrypt_decrypt_round_trip():
    key = crypto.shared_key(K_JOB)
    plaintext = b"some model bytes " * 1000
    blob = crypto.encrypt(key, plaintext)
    assert isinstance(blob, bytes)
    assert plaintext not in blob
    assert len(blob) == len(plaintext) + 24 + 16  # nonce + MAC
    assert crypto.decrypt(key, blob) == plaintext
    # a random nonce each time
    assert crypto.encrypt(key, plaintext) != blob


def test_decrypt_wrong_key_fails():
    blob = crypto.encrypt(crypto.item_key(K_JOB, 0), b"image 0")
    with pytest.raises(CryptoError):
        crypto.decrypt(crypto.item_key(K_JOB, 1), blob)


def test_decrypt_tampered_ciphertext_fails():
    key = crypto.item_key(K_JOB, 0)
    blob = bytearray(crypto.encrypt(key, b"image 0"))
    blob[-1] ^= 1
    with pytest.raises(CryptoError):
        crypto.decrypt(key, bytes(blob))


# --- input integrity: dataHash ------------------------------------------------

ASSET_IMAGES = Path(__file__).resolve().parent.parent / "assets" / "images"


def sample_inputs() -> tuple[bytes, list[bytes]]:
    """A fake model plus a few images (real demo images if they are present)."""
    images = [p.read_bytes() for p in sorted(ASSET_IMAGES.glob("*.jpg"))[:5]]
    if len(images) < 5:
        images = [b"\xff\xd8 fake jpeg %d" % i * 50 for i in range(5)]
    return b"fake onnx model", images


def test_tampered_image_changes_data_hash():
    model, images = sample_inputs()
    model_hash = crypto.keccak(model)
    good = crypto.data_hash(model_hash, [crypto.keccak(img) for img in images])

    tampered = list(images)
    flipped = bytearray(tampered[2])
    flipped[len(flipped) // 2] ^= 0x01  # flip one bit in one image
    tampered[2] = bytes(flipped)
    assert crypto.data_hash(model_hash, [crypto.keccak(img) for img in tampered]) != good

    # swapping two images, or changing the model, also changes it
    swapped = [images[1], images[0], *images[2:]]
    assert crypto.data_hash(model_hash, [crypto.keccak(img) for img in swapped]) != good
    assert crypto.data_hash(crypto.keccak(model + b"!"), [crypto.keccak(img) for img in images]) != good


def test_manifest_flow_detects_tampered_item(tmp_path):
    """End to end on the Python side, with the replicated mode's own helpers: the client
    encrypts and uploads (pack_inputs), a provider downloads, decrypts and checks every
    plaintext hash against dataHash (load_inputs)."""
    from types import SimpleNamespace

    from degpu.modes.replicated import InputError, load_inputs, pack_inputs
    from degpu.tasks import get
    from degpu.tasks.base import ReplicatedInputs

    store = Store(tmp_path)
    model, images = sample_inputs()
    task = get("image-classify-v1")
    k_job = b32(0x99)

    data_uri, on_chain = pack_inputs(store, k_job, task, ReplicatedInputs(model, images))
    assert on_chain == crypto.data_hash(crypto.keccak(model), [crypto.keccak(img) for img in images])
    job = SimpleNamespace(dataURI=data_uri, numItems=len(images), dataHash=on_chain)
    keys = {i: crypto.item_key(k_job, i) for i in range(len(images))}

    shared, got = load_inputs(store, job, task, crypto.shared_key(k_job), keys)
    assert shared == model and [got[i] for i in range(len(images))] == images

    # The client sends this provider a different image 3 (re-encrypted under the right key,
    # so decryption still succeeds): the hash check catches it.
    manifest = json.loads(store.get(data_uri))
    manifest["items"][3]["uri"] = store.put(crypto.encrypt(crypto.item_key(k_job, 3), b"another image"))
    cheat = SimpleNamespace(dataURI=store.put(json.dumps(manifest).encode()), numItems=len(images), dataHash=on_chain)
    with pytest.raises(InputError, match="item 3"):
        load_inputs(store, cheat, task, crypto.shared_key(k_job), keys)

    # A manifest that doesn't hash to the on-chain dataHash is refused before any download.
    other = SimpleNamespace(dataURI=data_uri, numItems=len(images), dataHash=b32(0x01))
    with pytest.raises(InputError, match="dataHash"):
        load_inputs(store, other, task, crypto.shared_key(k_job), keys)
