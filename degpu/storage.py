"""A tiny local content-addressed store, standing in for IPFS.

Blobs are written to ``<root>/<sha256hex>`` and addressed by the URI
``"store:<sha256hex>"``. The root directory comes from the ``DEGPU_STORE``
environment variable and defaults to ``.degpu-store/`` in the repo root.
In DeGPU everything stored here is ciphertext except the job manifest.
"""

from __future__ import annotations

import hashlib
import os
from pathlib import Path

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
        if not uri.startswith(PREFIX):
            raise KeyError(uri)
        digest = uri[len(PREFIX):]
        # A digest is 64 lowercase hex chars; anything else can't be in the store
        # (this also keeps odd URIs from escaping the root directory).
        if len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
            raise KeyError(uri)
        path = self.root / digest
        try:
            return path.read_bytes()
        except FileNotFoundError:
            raise KeyError(uri) from None
