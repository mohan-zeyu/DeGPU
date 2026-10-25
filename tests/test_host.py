"""The network host: the RPC gateway, the faucet, the file store, and restarts."""

import hashlib
import shutil

import pytest
from eth_account import Account
from fastapi.testclient import TestClient

from degpu.chain import ETHER
from degpu.host import Host

pytestmark = pytest.mark.skipif(shutil.which("anvil") is None, reason="anvil (Foundry) not installed")


@pytest.fixture(scope="module")
def host(tmp_path_factory):
    h = Host(tmp_path_factory.mktemp("host"), faucet_wei=2 * ETHER).start()
    yield h
    h.stop()


@pytest.fixture(scope="module")
def web(host):
    return TestClient(host.app())


def rpc(web, method, params=()):
    return web.post("/rpc", json={"jsonrpc": "2.0", "id": 1, "method": method, "params": list(params)}).json()


def test_network_json(web, host):
    info = web.get("/network.json").json()
    assert info["registry"] == host.chain.registry.address
    assert info["chain_id"] == 31337
    assert (info["rpc"], info["store"], info["faucet"]) == ("rpc", "blobs", "faucet")
    assert info["faucet_wei"] == str(2 * ETHER)


def test_gateway_passes_reads(web):
    assert rpc(web, "eth_chainId")["result"] == hex(31337)
    assert rpc(web, "eth_accounts")["result"] == []  # the host's own accounts are hidden


@pytest.mark.parametrize("method,params", [
    ("evm_increaseTime", [3600]),  # skipping deadlines would let anyone get providers slashed
    ("evm_mine", []),
    ("anvil_setBalance", ["0x" + "11" * 20, "0xffff"]),  # free ETH
    ("eth_sendTransaction", [{"from": "0x" + "11" * 20}]),  # sending from the host's accounts
    ("anvil_impersonateAccount", ["0x" + "11" * 20]),
])
def test_gateway_blocks(web, method, params):
    reply = rpc(web, method, params)
    assert reply["error"]["code"] == -32601 and "not allowed" in reply["error"]["message"]


def test_gateway_batch(web):
    replies = web.post("/rpc", json=[{"jsonrpc": "2.0", "id": 1, "method": "eth_chainId", "params": []},
                                     {"jsonrpc": "2.0", "id": 2, "method": "evm_mine", "params": []}]).json()
    assert "result" in replies[0] and "error" in replies[1]


def test_faucet_pays_once(web, host):
    who = Account.create().address
    r = web.post("/faucet", json={"address": who})
    assert r.status_code == 200 and r.json()["amount_wei"] == str(2 * ETHER)
    assert host.chain.balance(who) == 2 * ETHER
    again = web.post("/faucet", json={"address": who.lower()})
    assert again.status_code == 409
    assert host.chain.balance(who) == 2 * ETHER
    assert web.post("/faucet", json={"address": "nope"}).status_code == 400


def test_blobs(web):
    data = b"ciphertext" * 100
    digest = hashlib.sha256(data).hexdigest()
    assert web.put(f"/blobs/{digest}", content=data).json() == {"uri": "store:" + digest}
    assert web.get(f"/blobs/{digest}").content == data
    assert web.put(f"/blobs/{'0' * 64}", content=data).status_code == 400  # content must match its name
    assert web.get(f"/blobs/{'1' * 64}").status_code == 404
    assert web.get("/blobs/..%2F..%2Fetc").status_code in (400, 404)


def test_artifacts(web):
    assert any(e.get("name") == "register" for e in web.get("/artifacts/ProviderRegistry").json()["abi"])
    assert web.get("/artifacts/Nope").status_code == 404


def test_restart_keeps_the_chain(tmp_path):
    folder = tmp_path / "host"
    h = Host(folder).start()
    registry = h.chain.registry.address
    who = Account.create().address
    h.faucet(who)
    uri = h.store.put(b"kept")
    h.stop()

    h = Host(folder).start()
    try:
        assert h.chain.registry.address == registry
        assert h.chain.balance(who) == 2 * ETHER
        assert h.store.get(uri) == b"kept"
        with pytest.raises(Exception, match="already got"):
            h.faucet(who)
    finally:
        h.stop()

    h = Host(folder).start(fresh=True)  # a new chain: new contracts, no claims, no files
    try:
        assert h.chain.balance(who) == 0
        h.faucet(who)
    finally:
        h.stop()
