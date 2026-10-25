"""A tiny content-addressed store, standing in for IPFS.

Blobs are addressed by the URI ``"store:<sha256hex>"``. Two stores with the same
``put`` / ``get``:

* ``Store``: a local folder, ``<root>/<sha256hex>``. The root comes from the
  ``DEGPU_STORE`` environment variable and defaults to ``.degpu-store/`` in the
  repo root. Used by the demo and the tests, and by the network host.
* ``HttpStore``: the network host's store, reached over HTTP (``/blobs`` in
  ``degpu/host.py``), so nodes on different laptops share files. Every download
  is checked against its hash, so the host can't alter a file, only withhold it.

In DeGPU everything stored here is ciphertext except the job manifest.
"""

from __future__ import annotations

import hashlib
import os
import threading
import time
from pathlib import Path

import requests

PREFIX = "store:"

# degpu/storage.py -> repo root is one directory up from the package.
REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_ROOT = REPO_ROOT / ".degpu-store"


class Store:
    """Content-addressed blob store on the local filesystem."""

    def __init__(self, root: str | os.PathLike | None = None):
        if root is None:
            root = os.environ.get("DEGPU_STORE") or DEFAULT_ROOT
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def put(self, data: bytes) -> str:
        """Store ``data`` and return its URI ``"store:" + sha256hex(data)``."""
        digest = hashlib.sha256(data).hexdigest()
        path = self.root / digest
        if not path.exists():
            # Write to a temp file then rename, so a reader never sees half a blob.
            tmp = path.with_suffix(f".tmp{os.getpid()}")
            tmp.write_bytes(data)
            os.replace(tmp, path)
        return PREFIX + digest

    def get(self, uri: str) -> bytes:
        """Return the blob for ``uri``; raise ``KeyError`` if it is not stored."""
        path = self.root / digest_of(uri)
        try:
            return path.read_bytes()
        except FileNotFoundError:
            raise KeyError(uri) from None


def digest_of(uri: str) -> str:
    """The sha256 hex digest a ``store:`` URI names; ``KeyError`` if it isn't one."""
    if not uri.startswith(PREFIX):
        raise KeyError(uri)
    digest = uri[len(PREFIX):]
    # A digest is 64 lowercase hex chars; anything else can't be in the store
    # (this also keeps odd URIs from escaping the root directory).
    if len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
        raise KeyError(uri)
    return digest


class StoreUnavailable(RuntimeError):
    """The network store could not be reached (not the same as a missing blob)."""


class HttpStore:
    """The network host's store over HTTP: ``PUT``/``GET <url>/<sha256hex>``.

    ``get`` raises ``KeyError`` only when the host has no such blob or sends one that doesn't
    match its hash, as ``Store`` does, so the drivers treat both stores alike. A host that can't
    be reached raises ``StoreUnavailable`` instead (after a few retries): a provider must not
    report a job's input as bad because the Wi-Fi dropped."""

    def __init__(self, url: str, *, retries: int = 3, timeout: float = 120.0):
        self.url = url.rstrip("/")
        self.retries = retries
        self.timeout = timeout
        self._local = threading.local()  # one HTTP session per thread (a node uses several)

    def put(self, data: bytes) -> str:
        """Upload ``data`` and return its URI ``"store:" + sha256hex(data)``."""
        digest = hashlib.sha256(data).hexdigest()
        r = self._request("PUT", digest, data=data)
        if r.status_code != 200:
            raise StoreUnavailable(f"the store refused the upload: HTTP {r.status_code} {r.text[:200]}")
        return PREFIX + digest

    def get(self, uri: str) -> bytes:
        digest = digest_of(uri)
        r = self._request("GET", digest)
        if r.status_code == 404:
            raise KeyError(uri)
        if r.status_code != 200:
            raise StoreUnavailable(f"the store answered HTTP {r.status_code}")
        if hashlib.sha256(r.content).hexdigest() != digest:
            raise KeyError(uri)  # altered on the way or by the host: as good as missing
        return r.content

    def _request(self, method: str, digest: str, **kw) -> requests.Response:
        for attempt in range(self.retries):
            try:
                if not hasattr(self._local, "http"):
                    self._local.http = requests.Session()
                return self._local.http.request(method, f"{self.url}/{digest}", timeout=self.timeout, **kw)
            except requests.RequestException as e:
                if attempt == self.retries - 1:
                    raise StoreUnavailable(f"cannot reach the store at {self.url}: {e}") from None
                time.sleep(1 + attempt)
        raise AssertionError("unreachable")
