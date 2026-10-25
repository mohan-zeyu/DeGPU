"""Wallets: one Ethereum private key each, saved encrypted on this machine.

A wallet is ``<home>/wallets/<name>.json`` in the standard Ethereum keystore format (the one
geth and MetaMask import), encrypted with the owner's password. ``<home>`` is ``~/.degpu``
unless the ``DEGPU_HOME`` environment variable says otherwise.

The key never leaves this machine. The local DeGPU app (``degpu app``, ``degpu/api.py``)
unlocks it with the password and signs every transaction itself, so the automatic steps of a
job (accept, commit, reveal...) need no clicks. A provider's X25519 encryption key is derived
from the wallet key (``crypto.keypair_from_wallet``), so there is no second secret to keep.

    uv run degpu wallet new alice
    uv run degpu wallet import bob      # asks for the private key (hidden) and a password
    uv run degpu wallet list
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path

from eth_account import Account
from eth_account.signers.local import LocalAccount
from eth_utils import to_checksum_address

NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,32}$")

#: scrypt cost (n) of new keystores; None is eth_account's default (2**18). Tests lower it.
SCRYPT_N: int | None = None


class WalletError(Exception):
    """A wallet can't be created, found or unlocked; the message says why."""


def home() -> Path:
    """Where DeGPU keeps this machine's wallets and state (``DEGPU_HOME``, default ``~/.degpu``)."""
    return Path(os.environ.get("DEGPU_HOME") or Path.home() / ".degpu")


def wallet_dir() -> Path:
    return home() / "wallets"


def create(name: str, password: str) -> str:
    """Make a wallet with a new random key. Returns its address."""
    return _save(name, Account.create().key, password)


def import_key(name: str, private_key: str, password: str) -> str:
    """Make a wallet from an existing private key (64 hex digits, with or without 0x)."""
    try:
        key = Account.from_key(private_key.strip()).key
    except (ValueError, TypeError):
        raise WalletError("that is not a valid private key (64 hex digits)") from None
    return _save(name, key, password)


def unlock(name: str, password: str) -> LocalAccount:
    """The wallet's account, ready to sign. Raises WalletError on a wrong password."""
    try:
        return Account.from_key(Account.decrypt(_read(name), password))
    except ValueError:
        raise WalletError("wrong password") from None


def address_of(name: str) -> str:
    return to_checksum_address("0x" + _read(name)["address"].removeprefix("0x"))


def list_wallets() -> list[dict]:
    """Every wallet on this machine as {"name", "address"}, by name."""
    return [{"name": p.stem, "address": address_of(p.stem)}
            for p in sorted(wallet_dir().glob("*.json")) if NAME_RE.match(p.stem)]


def _path(name: str) -> Path:
    if not NAME_RE.match(name or ""):
        raise WalletError("a wallet name is 1-32 letters, digits, '-' or '_'")
    return wallet_dir() / f"{name}.json"


def _read(name: str) -> dict:
    path = _path(name)
    if not path.exists():
        raise WalletError(f"no wallet called {name!r}")
    return json.loads(path.read_text())


def _save(name: str, key: bytes, password: str) -> str:
    if not password:
        raise WalletError("the password must not be empty")
    path = _path(name)
    if path.exists():
        raise WalletError(f"a wallet called {name!r} already exists")
    keystore = Account.encrypt(key, password, iterations=SCRYPT_N)
    path.parent.mkdir(parents=True, exist_ok=True)
    # Readable by this user only; O_EXCL so two processes can't both write the same name.
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(keystore, f)
    return Account.from_key(key).address
