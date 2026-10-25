"""Wallet files: create, import, unlock, and the encryption key derived from the wallet key."""

import stat

import pytest
from eth_account import Account

from degpu import crypto, wallet


@pytest.fixture(autouse=True)
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("DEGPU_HOME", str(tmp_path))
    monkeypatch.setattr(wallet, "SCRYPT_N", 2**4)  # cheap keystores for tests
    return tmp_path


def test_create_list_unlock():
    address = wallet.create("alice", "pw")
    assert wallet.list_wallets() == [{"name": "alice", "address": address}]
    assert wallet.unlock("alice", "pw").address == address
    with pytest.raises(wallet.WalletError, match="wrong password"):
        wallet.unlock("alice", "nope")


def test_file_is_private(home):
    wallet.create("alice", "pw")
    mode = (home / "wallets" / "alice.json").stat().st_mode
    assert stat.S_IMODE(mode) == 0o600


def test_import_key():
    acct = Account.create()
    assert wallet.import_key("bob", acct.key.hex(), "pw") == acct.address
    assert wallet.unlock("bob", "pw").key == acct.key
    with pytest.raises(wallet.WalletError, match="not a valid private key"):
        wallet.import_key("carol", "0x1234", "pw")


@pytest.mark.parametrize("name", ["", "a b", "../x", "x" * 33])
def test_bad_names(name):
    with pytest.raises(wallet.WalletError, match="wallet name"):
        wallet.create(name, "pw")


def test_no_overwrite_no_empty_password():
    wallet.create("alice", "pw")
    with pytest.raises(wallet.WalletError, match="already exists"):
        wallet.create("alice", "pw")
    with pytest.raises(wallet.WalletError, match="must not be empty"):
        wallet.create("dave", "")


def test_unknown_wallet():
    with pytest.raises(wallet.WalletError, match="no wallet"):
        wallet.unlock("nobody", "pw")


def test_encryption_key_follows_the_wallet():
    a, b = Account.create(), Account.create()
    assert crypto.keypair_from_wallet(a.key) == crypto.keypair_from_wallet(a.key)
    assert crypto.keypair_from_wallet(a.key) != crypto.keypair_from_wallet(b.key)
    priv, pub = crypto.keypair_from_wallet(a.key)
    assert crypto.unseal(priv, crypto.seal(pub, {"x": 1})) == {"x": 1}
