"""The product path end to end: a network host, and five users whose local apps are driven only
through the HTTP API (as the CLI and the GUI do). Real time, no time travel: every user signs
with their own wallet and the files go through the host's store.

Four users are providers (one later cheats), one is a client.
"""

import os
import shutil
import threading
import time
from pathlib import Path

import pytest
import uvicorn
from fastapi.testclient import TestClient

from degpu import wallet
from degpu.api import App, create_app
from degpu.chain import ETHER, free_port
from degpu.host import Host

pytestmark = pytest.mark.skipif(shutil.which("anvil") is None, reason="anvil (Foundry) not installed")

REPO = Path(__file__).resolve().parent.parent
MODEL = REPO / "assets" / "mobilenetv2.onnx"
IMAGES = sorted((REPO / "assets" / "images").glob("*.jpg"))[::40][:5]
needs_assets = pytest.mark.skipif(not MODEL.exists() or len(IMAGES) < 5,
                                  reason="demo assets missing; run scripts/fetch_demo_assets.py")


class User:
    """One user's local app, reached through its API."""

    def __init__(self, network_url: str, home: Path, name: str):
        self.name = name
        wallet.create(name, "pw")
        self.app = App(network_url, home=home, poll=0.2, echo=None)
        self.web = TestClient(create_app(self.app), base_url="http://127.0.0.1", headers={"X-DeGPU": "1"})

    def get(self, path, **params):
        r = self.web.get(path, params=params)
        assert r.status_code == 200, r.text
        return r.json()

    def post(self, path, body=None, **kw):
        r = self.web.post(path, json=body, **kw)
        assert r.status_code == 200, r.text
        return r.json()

    @property
    def address(self) -> str:
        return self.app.node.address

    def balance(self) -> int:
        return int(self.get("/api/account")["balance_wei"])

    def wait_closed(self, ref: str, timeout: float = 120) -> dict:
        deadline = time.time() + timeout
        while time.time() < deadline:
            job = self.get(f"/api/jobs/{ref}")
            if job["closed"]:
                return job
            time.sleep(0.3)
        raise AssertionError(f"{ref} did not close: {job['status']}\n" +
                             "\n".join(e["message"] for e in self.get("/api/activity")))


@pytest.fixture(scope="module")
def network(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("net")
    old_home, old_n = os.environ.get("DEGPU_HOME"), wallet.SCRYPT_N
    os.environ["DEGPU_HOME"] = str(tmp / "home")
    wallet.SCRYPT_N = 2**4
    host = Host(tmp / "host").start()
    port = free_port()
    server = uvicorn.Server(uvicorn.Config(host.app(), host="127.0.0.1", port=port, log_level="warning"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    while not server.started:
        time.sleep(0.05)
    users = {}
    try:
        url = f"http://127.0.0.1:{port}"
        for name in ("alice", "p1", "p2", "p3", "p4"):
            users[name] = u = User(url, tmp / "home", name)
            u.post("/api/unlock", {"name": name, "password": "pw"})
            u.post("/api/faucet")
        for name in ("p1", "p2", "p3", "p4"):
            users[name].post("/api/provider/register", {"stake_wei": str(ETHER)})
            users[name].post("/api/provider/serve", {"on": True})
        yield users
    finally:
        for u in users.values():
            u.app.lock()
        server.should_exit = True
        thread.join(timeout=10)
        host.stop()
        wallet.SCRYPT_N = old_n
        if old_home is None:
            os.environ.pop("DEGPU_HOME", None)
        else:
            os.environ["DEGPU_HOME"] = old_home


def test_serves_the_gui(tmp_path):
    (tmp_path / "index.html").write_text("<h1>DeGPU</h1>")
    web = TestClient(create_app(App(None, home=tmp_path), web_dir=tmp_path), base_url="http://127.0.0.1")
    assert web.get("/").text == "<h1>DeGPU</h1>"
    assert web.get("/api/status").json()["unlocked"] is False  # the API still comes first


def test_guard(network):
    web = network["alice"].web
    assert web.post("/api/faucet", headers={"X-DeGPU": ""}).status_code == 403  # no custom header
    assert web.get("/api/status", headers={"Host": "evil.example"}).status_code == 403
    locked = TestClient(create_app(App(None, home=network["alice"].app.home)), base_url="http://127.0.0.1")
    assert locked.get("/api/account").status_code == 423


def test_wallet_and_market(network):
    alice = network["alice"]
    status = alice.get("/api/status")
    assert status["unlocked"] and status["wallet"]["name"] == "alice"
    assert alice.balance() == 2 * ETHER
    assert alice.web.post("/api/faucet").status_code == 400  # once per wallet

    providers = {p["address"]: p for p in alice.get("/api/providers")}
    assert len(providers) == 4 and all(p["active"] for p in providers.values())
    tasks = {t["name"]: t for t in alice.get("/api/tasks")}
    assert {"key-search-v1", "image-classify-v1"} <= set(tasks)
    fields = {f["name"]: f["type"] for f in tasks["image-classify-v1"]["fields"]}
    assert fields == {"model": "file", "images": "files", "limit": "int"}


def test_provider_actions(network):
    p4 = network["p4"]
    me = p4.post("/api/provider/stake", {"amount_wei": str(ETHER // 10)})
    assert int(me["stake_wei"]) == ETHER + ETHER // 10
    me = p4.post("/api/provider/withdraw", {"amount_wei": str(ETHER // 10)})
    assert int(me["stake_wei"]) == ETHER
    me = p4.post("/api/provider/prices", {"prices_wei": {"key-search-v1": "0"}})
    assert me["prices_wei"]["key-search-v1"] == "0"
    me = p4.post("/api/provider/prices", {"prices_wei": {"key-search-v1": str(ETHER // 10_000)}})
    assert me["prices_wei"]["key-search-v1"] == str(ETHER // 10_000)
    r = p4.web.post("/api/provider/register", json={"stake_wei": str(ETHER)})
    assert r.status_code == 400 and "already a provider" in r.json()["detail"]


def test_key_search_job(network):
    alice, p1 = network["alice"], network["p1"]
    job = alice.post("/api/jobs", data={"task": "key-search-v1", "main": p1.address,
                                        "keys": "3", "bits": "8", "impossible": "1"})
    assert job["ref"].startswith("checked:") and job["num_items"] == 4 and job["role"] == "client"
    job = alice.wait_closed(job["ref"])
    assert job["outcome"] == "delivered"
    values = [i["value"] for i in alice.get(f"/api/jobs/{job['ref']}/results")["items"]]
    assert all(isinstance(v, str) for v in values[:3]) and values[3] is None  # 128-bit keys come as strings
    assert any(j["ref"] == job["ref"] and j["role"] == "main" for j in p1.get("/api/jobs"))
    assert [e["event"] for e in job["timeline"]][0] == "JobCreated"


def test_bad_posts(network):
    alice, p1 = network["alice"], network["p1"]
    r = alice.web.post("/api/jobs", data={"task": "key-search-v1", "main": alice.address, "keys": "1"})
    assert r.status_code == 400 and "your own job" in r.json()["detail"]
    r = alice.web.post("/api/jobs", data={"task": "key-search-v1", "main": p1.address, "nope": "1"})
    assert r.status_code == 400 and "no field" in r.json()["detail"]
    r = alice.web.post("/api/jobs", data={"task": "key-search-v1", "main": p1.address, "keys": "lots"})
    assert r.status_code == 400
    r = network["p2"].web.get("/api/jobs/checked:1/results")
    assert r.status_code == 400 and "only the job's client" in r.json()["detail"]


def _post_images(user, main, verify):
    files = [("model", (MODEL.name, MODEL.read_bytes()))]
    files += [("images", (p.name, p.read_bytes())) for p in IMAGES]
    return user.post("/api/jobs", data={"task": "image-classify-v1", "main": main,
                                        "verify": "true" if verify else "false"}, files=files)


@needs_assets
def test_verified_image_job(network):
    alice, p2 = network["alice"], network["p2"]
    job = _post_images(alice, p2.address, verify=True)
    assert job["num_items"] == len(IMAGES)
    job = alice.wait_closed(job["ref"])
    assert job["outcome"] == "verified" and job["verified"]
    assert [v["state"] for v in job["verifiers"]] == ["revealed", "revealed"]
    labels = [i["value"] for i in alice.get(f"/api/jobs/{job['ref']}/results")["items"]]
    assert len(labels) == len(IMAGES) and all(isinstance(v, int) for v in labels)


@needs_assets
def test_cheater_caught(network):
    alice, p3 = network["alice"], network["p3"]
    p3.post("/api/provider/serve", {"on": True, "behavior": "cheat"})  # fakes 1 of the 5 labels
    try:
        stake = int(p3.get("/api/provider")["stake_wei"])
        job = alice.wait_closed(_post_images(alice, p3.address, verify=True)["ref"])
        assert job["outcome"] == "main_outvoted"
        assert job["tiebreaker"] is not None and len(job["mismatched"]) == 1
        assert int(p3.get("/api/provider")["stake_wei"]) < stake  # slashed
        items = alice.get(f"/api/jobs/{job['ref']}/results")["items"]
        assert [i["index"] for i in items if i["mismatched"]] == job["mismatched"]  # the faked label is flagged
    finally:
        p3.post("/api/provider/serve", {"on": True, "behavior": "honest"})
