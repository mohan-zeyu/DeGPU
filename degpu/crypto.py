"""Cryptographic helpers shared by the DeGPU client and provider agents.

Everything here follows docs/INTERFACE.md sections 2 and 3:

* hashing is keccak256 (the Ethereum variant, not SHA3-256);
* commitments use Solidity ``abi.encode`` semantics via ``eth_abi.encode``,
  so the contract can recompute them byte for byte;
* per-job secrets are derived from one random ``k_job`` with HKDF-SHA256;
* files are encrypted with NaCl SecretBox, and small JSON payloads are
  sealed to a provider's X25519 public key with NaCl SealedBox.

All byte values are plain ``bytes``. Hex strings only appear inside the JSON
payloads handled by ``seal`` / ``unseal``.
"""

from __future__ import annotations

import hashlib
import hmac
import json

from Crypto.Hash import keccak as _keccak
from eth_abi import encode as abi_encode
from nacl.public import PrivateKey, PublicKey, SealedBox
from nacl.secret import SecretBox

__all__ = [
    "keccak",
    "hkdf32",
    "job_salt",
    "shared_key",
    "item_key",
    "word",
    "leaf",
    "decode_leaves",
    "results_commit",
    "verify_commit",
    "check_commit",
    "data_hash",
    "generate_keypair",
    "seal",
    "unseal",
    "encrypt",
    "decrypt",
]


# ---------------------------------------------------------------------------
# Hashing
# ---------------------------------------------------------------------------

def keccak(b: bytes) -> bytes:
    """keccak256 of ``b`` (same as Solidity's ``keccak256``)."""
    h = _keccak.new(digest_bits=256)
    h.update(b)
    return h.digest()


def hkdf32(ikm: bytes, info: bytes) -> bytes:
    """HKDF-SHA256 (RFC 5869) with an empty salt and a 32-byte output.

    An empty salt means HashLen (32) zero bytes, as the RFC specifies. A
    32-byte output is exactly one HMAC block, so the expand step is a single
    HMAC call: T(1) = HMAC(PRK, info || 0x01).
    """
    salt = b"\x00" * 32
    prk = hmac.new(salt, ikm, hashlib.sha256).digest()      # extract
    return hmac.new(prk, info + b"\x01", hashlib.sha256).digest()  # expand


# ---------------------------------------------------------------------------
# Key derivation from the job key k_job
# ---------------------------------------------------------------------------

def job_salt(k_job: bytes) -> bytes:
    """Secret salt mixed into every result leaf of the job."""
    return hkdf32(k_job, b"degpu/job-salt")


def shared_key(k_job: bytes) -> bytes:
    """SecretBox key for the job's shared blob (e.g. the model). The HKDF label "degpu/model"
    predates the rename and is kept so the golden vectors stay valid."""
    return hkdf32(k_job, b"degpu/model")


def item_key(k_job: bytes, i: int) -> bytes:
    """SecretBox key for encrypted image ``i``."""
    return hkdf32(k_job, b"degpu/item/%d" % i)


# ---------------------------------------------------------------------------
# Commitments (abi.encode + keccak256, must match the Solidity side)
# ---------------------------------------------------------------------------

def word(value: bytes | int) -> bytes:
    """A result word: 32 bytes as-is, or an int as a 32-byte big-endian uint256."""
    if isinstance(value, int):
        return value.to_bytes(32, "big")
    value = bytes(value)
    if len(value) != 32:
        raise ValueError("a result word is exactly 32 bytes")
    return value


def leaf(job_salt: bytes, i: int, value: bytes | int) -> bytes:
    """keccak256(abi.encode(bytes32 jobSalt, uint256 i, bytes32 word)). An int word encodes like
    a uint256, so for image-classify-v1 this is keccak256(abi.encode(jobSalt, i, uint256 label))."""
    return keccak(abi_encode(["bytes32", "uint256", "bytes32"], [job_salt, i, word(value)]))


def decode_leaves(job_salt: bytes, leaves: list[bytes], candidates: list[bytes]) -> list[bytes | None]:
    """Recover each leaf's word by trying every candidate word; None if none matches (a wrong
    salt, index or forged leaf).

    For speed this builds the 96-byte preimage by hand: static types in abi.encode are just
    32-byte words, so ``abi.encode(jobSalt, i, word)`` is ``jobSalt || i (32 bytes) || word``.
    tests/test_crypto.py checks that this equals ``leaf``.
    """
    if len(job_salt) != 32:
        raise ValueError("job_salt must be 32 bytes")
    salt = bytes(job_salt)
    words = [word(c) for c in candidates]
    out: list[bytes | None] = []
    for i, target in enumerate(leaves):
        target = bytes(target)  # accept HexBytes and other bytes-likes
        prefix = salt + i.to_bytes(32, "big")
        found = None
        for w in words:
            if _keccak.new(data=prefix + w, digest_bits=256).digest() == target:
                found = w
                break
        out.append(found)
    return out


def results_commit(leaves: list[bytes]) -> bytes:
    """keccak256(abi.encode(bytes32[] leaves)) over all N leaves in index order."""
    return keccak(abi_encode(["bytes32[]"], [list(leaves)]))


def verify_commit(verify_salt: bytes, verify: bool) -> bytes:
    """keccak256(abi.encode(bytes32 verifySalt, bool verify)): the client's hidden yes/no."""
    return keccak(abi_encode(["bytes32", "bool"], [verify_salt, bool(verify)]))


def check_commit(v_salt: bytes, leaves: list[bytes]) -> bytes:
    """keccak256(abi.encode(bytes32 vSalt, bytes32[] rangeLeaves)) over a verifier's range."""
    return keccak(abi_encode(["bytes32", "bytes32[]"], [v_salt, list(leaves)]))


def data_hash(shared_hash: bytes, item_hashes: list[bytes]) -> bytes:
    """keccak256(abi.encode(bytes32 sharedHash, bytes32[] itemHashes)); sharedHash is the keccak
    of the shared blob (e.g. the model), or 32 zero bytes if the job has none."""
    return keccak(abi_encode(["bytes32", "bytes32[]"], [shared_hash, list(item_hashes)]))


# ---------------------------------------------------------------------------
# Provider keys and sealed JSON payloads (X25519 + NaCl SealedBox)
# ---------------------------------------------------------------------------

def generate_keypair() -> tuple[bytes, bytes]:
    """Return a fresh X25519 keypair as (private 32 bytes, public 32 bytes)."""
    sk = PrivateKey.generate()
    return bytes(sk), bytes(sk.public_key)


def seal(pub32: bytes, payload: dict) -> bytes:
    """Encrypt a JSON-serialisable dict so only the holder of ``pub32``'s
    private key can read it. Byte values must already be ``0x``-hex strings.
    """
    data = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    return SealedBox(PublicKey(pub32)).encrypt(data)


def unseal(priv32: bytes, blob: bytes) -> dict:
    """Inverse of ``seal``. Raises ``nacl.exceptions.CryptoError`` on a wrong key."""
    data = SealedBox(PrivateKey(priv32)).decrypt(blob)
    return json.loads(data.decode("utf-8"))


# ---------------------------------------------------------------------------
# File encryption (NaCl SecretBox, random nonce prepended)
# ---------------------------------------------------------------------------

def encrypt(key32: bytes, plaintext: bytes) -> bytes:
    """Encrypt with a 32-byte key; the output is nonce || ciphertext."""
    return bytes(SecretBox(key32).encrypt(plaintext))


def decrypt(key32: bytes, blob: bytes) -> bytes:
    """Inverse of ``encrypt``. Raises ``nacl.exceptions.CryptoError`` on a wrong key."""
    return SecretBox(key32).decrypt(blob)
