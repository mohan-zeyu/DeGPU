"""The local DeGPU app: an HTTP API on 127.0.0.1 over one unlocked wallet's ``Node``.

``degpu app`` runs this on each user's laptop. It holds the unlocked wallet key, so it only
listens on 127.0.0.1, and every POST must carry the header ``X-DeGPU: 1``, which a web page from
another site can't send without the browser asking first. The CLI (``degpu/cli.py``) and the
GUI are both clients of this API; docs/API.md describes every endpoint (docs/FRONTEND.md how the
GUI uses them), and the running app also serves interactive docs at ``/docs``. Once the GUI is
built into ``degpu/web/``, the app serves it at ``/`` too.

Conventions: JSON in and out; ETH amounts are wei, as decimal strings (they don't fit in a
JavaScript number); jobs are named ``<mode>:<id>`` (``replicated:3``); errors are
``{"detail": "..."}`` with 400 (the action was refused), 404 (no such thing), 423 (no wallet
unlocked yet) or 503 (the network host can't be reached).
"""

from __future__ import annotations

import json
import mimetypes
import os
import tempfile
import threading
from pathlib import Path
from typing import Any

import requests
import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.datastructures import UploadFile

from degpu import wallet
from degpu.chain import TxFailed
from degpu.node import Network, Node, NodeError, _plain
from degpu.storage import StoreUnavailable
from degpu.tasks import get
from degpu.wallet import WalletError

DEFAULT_PORT = 8700
#: the built GUI (``npm run build`` in frontend/ writes here); served at / when present
WEB_DIR = Path(__file__).resolve().parent / "web"
#: the GUI's development server (Vite), allowed to call the API from the browser
DEV_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"]


class Locked(Exception):
    """No wallet is unlocked yet."""


class App:
    """The app's state: the network to join, and the node of the unlocked wallet (if any)."""

    def __init__(self, network_url: str | None = None, *, home: str | os.PathLike | None = None,
                 poll: float = 1.0, echo=print):
        self.home = Path(home or wallet.home())
        self._config_path = self.home / "app.json"
        config = json.loads(self._config_path.read_text()) if self._config_path.exists() else {}
        self.network_url = network_url or config.get("network")
        self.wallet_name: str | None = None
        self.node: Node | None = None
        self.poll = poll
        self.echo = echo
        self._lock = threading.Lock()

    def unlock(self, name: str, password: str, network_url: str | None = None) -> None:
        """Unlock wallet ``name`` and start its node on the network (the last one used by default)."""
        url = network_url or self.network_url
        if not url:
            raise NodeError("no network yet: give the host's URL (degpu app --network http://HOST:8600)")
        account = wallet.unlock(name, password)
        try:
            node = Node(Network.join(url), account, home=self.home, poll=self.poll, echo=self.echo).start()
        except RuntimeError as e:  # e.g. the chain doesn't answer
            raise NodeError(str(e)) from None
        with self._lock:
            old, self.node, self.wallet_name, self.network_url = self.node, node, name, url
        if old:
            old.stop()
        self._config_path.parent.mkdir(parents=True, exist_ok=True)
        self._config_path.write_text(json.dumps({"network": url, "wallet": name}))

    def lock(self) -> None:
        with self._lock:
            old, self.node, self.wallet_name = self.node, None, None
        if old:
            old.stop()

    def need_node(self) -> Node:
        node = self.node
        if node is None:
            raise Locked()
        return node

    def status(self) -> dict:
        node = self.node
        return {
            "network": node.network.as_dict() if node else ({"url": self.network_url} if self.network_url else None),
            "wallet": {"name": self.wallet_name, "address": node.address} if node else None,
            "unlocked": node is not None,
            "serving": bool(node and node.serving),
        }


# -- request bodies -------------------------------------------------------------------------

class NewWallet(BaseModel):
    name: str
    password: str
    private_key: str | None = None  # import this key instead of making a new one


class Unlock(BaseModel):
    name: str
    password: str
    network: str | None = None


class Register(BaseModel):
    stake_wei: int
    prices_wei: dict[str, int] | None = None


class Amount(BaseModel):
    amount_wei: int


class Prices(BaseModel):
    prices_wei: dict[str, int]


class Serve(BaseModel):
    on: bool
    behavior: str | None = None


def create_app(app_state: App, web_dir: Path | None = WEB_DIR) -> FastAPI:
    api = FastAPI(title="DeGPU local app", version="1",
                  description="One user's DeGPU node: wallet, market, provider and client actions. "
                              "See docs/API.md.")
    api.add_middleware(CORSMiddleware, allow_origins=DEV_ORIGINS, allow_methods=["*"], allow_headers=["*"])
    st = app_state

    @api.middleware("http")
    async def guard(request: Request, call_next):
        # Only this machine, by name too (a web page can't rebind another name to 127.0.0.1), and
        # no state change without the custom header (a page from another site can't add it).
        host = request.headers.get("host", "").rsplit(":", 1)[0]
        if host not in ("127.0.0.1", "localhost"):
            return JSONResponse({"detail": "the DeGPU app only answers requests to 127.0.0.1"}, 403)
        if request.method not in ("GET", "HEAD", "OPTIONS") and request.headers.get("x-degpu") != "1":
            return JSONResponse({"detail": "send the header X-DeGPU: 1 with every POST"}, 403)
        return await call_next(request)

    @api.exception_handler(NodeError)
    @api.exception_handler(WalletError)
    async def refused(request, e):
        return JSONResponse({"detail": str(e)}, 400)

    @api.exception_handler(TxFailed)
    async def tx_failed(request, e):
        return JSONResponse({"detail": f"the transaction was rejected: {e}"}, 400)

    @api.exception_handler(Locked)
    async def locked(request, e):
        return JSONResponse({"detail": "unlock a wallet first (POST /api/unlock)"}, 423)

    @api.exception_handler(StoreUnavailable)
    @api.exception_handler(requests.ConnectionError)
    async def unreachable(request, e):
        return JSONResponse({"detail": f"cannot reach the network host: {e}"}, 503)

    # -- app and wallets ------------------------------------------------------------------

    @api.get("/api/status")
    def status() -> dict:
        return st.status()

    @api.get("/api/wallets")
    def wallets() -> list[dict]:
        return wallet.list_wallets()

    @api.post("/api/wallets")
    def new_wallet(body: NewWallet) -> dict:
        if body.private_key:
            address = wallet.import_key(body.name, body.private_key, body.password)
        else:
            address = wallet.create(body.name, body.password)
        return {"name": body.name, "address": address}

    @api.post("/api/unlock")
    def unlock(body: Unlock) -> dict:
        st.unlock(body.name, body.password, body.network)
        return st.status()

    @api.post("/api/lock")
    def lock() -> dict:
        st.lock()
        return st.status()

    @api.get("/api/account")
    def account() -> dict:
        node = st.need_node()
        return {"address": node.address, "balance_wei": str(node.balance())}

    @api.post("/api/faucet")
    def faucet() -> dict:
        return st.need_node().claim_faucet()

    @api.get("/api/activity")
    def activity(after: int = 0) -> list[dict]:
        return st.need_node().activity(after)

    # -- market -------------------------------------------------------------------------------

    @api.get("/api/tasks")
    def tasks() -> list[dict]:
        return st.need_node().tasks()

    @api.get("/api/providers")
    def providers() -> list[dict]:
        return st.need_node().providers()

    @api.get("/api/providers/{address}")
    def provider(address: str) -> dict:
        return st.need_node().provider(address)

    # -- me as a provider ---------------------------------------------------------------------

    @api.get("/api/provider")
    def me_as_provider() -> dict:
        return st.need_node().me_as_provider()

    @api.post("/api/provider/register")
    def register(body: Register) -> dict:
        return st.need_node().register(body.stake_wei, body.prices_wei)

    @api.post("/api/provider/stake")
    def add_stake(body: Amount) -> dict:
        return st.need_node().add_stake(body.amount_wei)

    @api.post("/api/provider/withdraw")
    def withdraw(body: Amount) -> dict:
        return st.need_node().withdraw_stake(body.amount_wei)

    @api.post("/api/provider/prices")
    def prices(body: Prices) -> dict:
        return st.need_node().set_prices(body.prices_wei)

    @api.post("/api/provider/serve")
    def serve(body: Serve) -> dict:
        return st.need_node().serve(body.on, body.behavior)

    # -- me as a client -------------------------------------------------------------------------

    @api.get("/api/jobs")
    def jobs() -> list[dict]:
        return st.need_node().jobs()

    @api.post("/api/jobs")
    async def post_job(request: Request) -> dict:
        node = st.need_node()
        form = await request.form(max_files=10_000, max_fields=1_000)
        try:
            fields: dict[str, Any] = {}
            files: dict[str, list[UploadFile]] = {}
            for key, value in form.multi_items():
                if isinstance(value, UploadFile):
                    files.setdefault(key, []).append(value)
                else:
                    fields[key] = value
            task_name = fields.pop("task", None)
            main = fields.pop("main", None)
            verify = fields.pop("verify", "false") in ("true", "True", "1", "yes", "on")
            if not task_name or not main:
                raise NodeError("say which task and which main provider: form fields 'task' and 'main'")
            try:
                task = get(task_name)
            except KeyError as e:
                raise NodeError(str(e.args[0])) from None
            with tempfile.TemporaryDirectory(prefix="degpu-upload-") as tmp:
                for name, uploads in files.items():
                    kind = task.uploads.get(name)
                    if kind is None:
                        raise NodeError(f"{task_name} takes no file for {name!r}; "
                                        f"its uploads: {', '.join(task.uploads) or 'none'}")
                    if kind == "file" and len(uploads) != 1:
                        raise NodeError(f"{name!r} takes exactly one file")
                    folder = Path(tmp) / name
                    folder.mkdir()
                    paths = [await _save_upload(u, folder, i) for i, u in enumerate(uploads)]
                    fields[name] = str(folder if kind == "files" else paths[0])
                return await run_in_threadpool(node.post_job, task_name, main, fields, verify)
        finally:
            await form.close()

    @api.get("/api/jobs/{ref}")
    def job(ref: str) -> dict:
        return st.need_node().job(ref)

    @api.get("/api/jobs/{ref}/results")
    def results(ref: str) -> dict:
        node = st.need_node()
        values = node.results(ref)
        mismatched = node.mismatched(ref)
        if any(isinstance(v, bytes) for v in values):
            items = [{"index": i, "file": f"/api/jobs/{ref}/results/{i}" if isinstance(v, bytes) else None,
                      "size": len(v) if isinstance(v, bytes) else None, "mismatched": i in mismatched}
                     for i, v in enumerate(values)]
            return {"ref": ref, "kind": "file", "suffix": getattr(node.task_of(ref), "output_suffix", ".bin"),
                    "items": items}
        items = [{"index": i, "value": _plain(v), "mismatched": i in mismatched} for i, v in enumerate(values)]
        return {"ref": ref, "kind": "value", "items": items}

    @api.get("/api/jobs/{ref}/results/{index}")
    def result_file(ref: str, index: int) -> Response:
        node = st.need_node()
        values = node.results(ref)
        if not 0 <= index < len(values) or not isinstance(values[index], bytes):
            raise HTTPException(404, f"item {index} has no result file")
        suffix = getattr(node.task_of(ref), "output_suffix", ".bin")
        media = mimetypes.guess_type("x" + suffix)[0] or "application/octet-stream"
        return Response(values[index], media_type=media,
                        headers={"Content-Disposition": f'inline; filename="item-{index:04d}{suffix}"'})

    @api.post("/api/jobs/{ref}/cancel")
    def cancel(ref: str) -> dict:
        return st.need_node().cancel(ref)

    @api.post("/api/jobs/{ref}/expire")
    def expire(ref: str) -> dict:
        return st.need_node().expire(ref)

    if web_dir and (web_dir / "index.html").exists():  # last, so /api/* and /docs match first
        api.mount("/", StaticFiles(directory=web_dir, html=True), name="gui")
    return api


async def _save_upload(upload: UploadFile, folder: Path, i: int) -> Path:
    """Save one uploaded file under its own name (tasks may sort by name), made safe."""
    name = Path(upload.filename or "").name or f"file-{i:05d}"
    path = folder / name
    if path.exists():
        path = folder / f"{path.stem}-{i}{path.suffix}"
    with open(path, "wb") as f:
        while chunk := await upload.read(1 << 20):
            f.write(chunk)
    return path


def run(app_state: App, port: int = DEFAULT_PORT) -> None:
    """``degpu app``: serve the API on 127.0.0.1 until Ctrl-C."""
    gui = f"open http://127.0.0.1:{port} in your browser" if (WEB_DIR / "index.html").exists() else "no GUI built yet"
    print(f"DeGPU app on http://127.0.0.1:{port}: {gui}; API docs at /docs", flush=True)
    try:
        uvicorn.run(create_app(app_state), host="127.0.0.1", port=port, log_level="warning")
    finally:
        app_state.lock()
