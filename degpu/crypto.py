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
    "model_key",
    "item_key",
    "leaf",
    "results_commit",
    "sample_hash",
    "sample_commit",
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


def model_key(k_job: bytes) -> bytes:
    """SecretBox key for the encrypted model file."""
    return hkdf32(k_job, b"degpu/model")


def item_key(k_job: bytes, i: int) -> bytes:
    """SecretBox key for encrypted image ``i``."""
    return hkdf32(k_job, b"degpu/item/%d" % i)


# ---------------------------------------------------------------------------
# Commitments (abi.encode + keccak256, must match the Solidity side)
# ---------------------------------------------------------------------------

def leaf(job_salt: bytes, i: int, label: int) -> bytes:
    """keccak256(abi.encode(bytes32 jobSalt, uint256 i, uint256 label))."""
    return keccak(abi_encode(["bytes32", "uint256", "uint256"], [job_salt, i, label]))


def results_commit(leaves: list[bytes]) -> bytes:
    """keccak256(abi.encode(bytes32[] leaves)) over all N leaves in index order."""
    return keccak(abi_encode(["bytes32[]"], [list(leaves)]))


def sample_hash(sample_salt: bytes, indices: list[int]) -> bytes:
    """keccak256(abi.encode(bytes32 sampleSalt, uint256[] indices))."""
    return keccak(abi_encode(["bytes32", "uint256[]"], [sample_salt, list(indices)]))


def sample_commit(v_salt: bytes, leaves: list[bytes]) -> bytes:
    """keccak256(abi.encode(bytes32 vSalt, bytes32[] sampleLeaves))."""
    return keccak(abi_encode(["bytes32", "bytes32[]"], [v_salt, list(leaves)]))


def data_hash(model_hash: bytes, item_hashes: list[bytes]) -> bytes:
    """keccak256(abi.encode(bytes32 modelHash, bytes32[] itemHashes))."""
    return keccak(abi_encode(["bytes32", "bytes32[]"], [model_hash, list(item_hashes)]))


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
