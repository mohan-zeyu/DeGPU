"""Tests for degpu/storage.py."""

import hashlib

import pytest

from degpu import storage
from degpu.storage import Store


def test_put_get_round_trip(tmp_path):
    store = Store(tmp_path)
    data = b"hello degpu" * 100
    uri = store.put(data)
    assert uri == "store:" + hashlib.sha256(data).hexdigest()
    assert store.get(uri) == data


def test_put_is_content_addressed(tmp_path):
    store = Store(tmp_path)
    assert store.put(b"same") == store.put(b"same")
    assert store.put(b"a") != store.put(b"b")
    assert store.get(store.put(b"")) == b""


def test_missing_key_raises_keyerror(tmp_path):
    store = Store(tmp_path)
    with pytest.raises(KeyError):
        store.get("store:" + "00" * 32)


@pytest.mark.parametrize("uri", ["", "store:", "store:xyz", "ipfs:" + "00" * 32, "store:../../etc/passwd"])
def test_malformed_uri_raises_keyerror(tmp_path, uri):
    with pytest.raises(KeyError):
        Store(tmp_path).get(uri)


def test_root_from_env(tmp_path, monkeypatch):
    root = tmp_path / "custom-store"
    monkeypatch.setenv("DEGPU_STORE", str(root))
    store = Store()
    assert store.root == root
    uri = store.put(b"x")
    assert (root / uri.removeprefix("store:")).read_bytes() == b"x"
    # a second Store on the same root sees the same blobs
    assert Store().get(uri) == b"x"


def test_default_root(monkeypatch):
    monkeypatch.delenv("DEGPU_STORE", raising=False)
    assert storage.DEFAULT_ROOT == storage.REPO_ROOT / ".degpu-store"
    assert (storage.REPO_ROOT / "degpu" / "storage.py").exists()
    assert Store().root == storage.DEFAULT_ROOT
