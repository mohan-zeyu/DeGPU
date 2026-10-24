"""End-to-end tests on a real anvil chain: client + provider agents + contracts.

Uses 20 of the demo images (one in ten, so several classes are covered) to
stay fast. Skipped if the demo assets or anvil are missing.
"""

import shutil
from pathlib import Path

import pytest

from degpu import crypto
from degpu.agent import ProviderAgent
from degpu.chain import (
    CLIENT_INDEX,
    ETHER,
    PRICE_PER_ITEM,
    PROVIDER_INDICES,
    PROVIDER_NAMES,
    Outcome,
    Status,
    start_local_chain,
)
from degpu.client import Client
from degpu.storage import Store

REPO = Path(__file__).resolve().parent.parent
MODEL = REPO / "assets" / "mobilenetv2.onnx"
IMAGES = sorted((REPO / "assets" / "images").glob("*.jpg"))[::10]

pytestmark = [
    pytest.mark.skipif(not MODEL.exists() or len(IMAGES) < 20,
                       reason="demo assets missing; run scripts/fetch_demo_assets.py"),
    pytest.mark.skipif(shutil.which("anvil") is None, reason="anvil (Foundry) not installed"),
]


class World:
    def __init__(self, chain, client, agents):
        self.chain, self.client, self.agents = chain, client, agents

    def drive(self, job_id, rounds=20):
        """Step the client and all agents until the job closes or nothing moves."""
        idle = 0
        for _ in range(rounds):
            progressed = self.client.step()
            for ag in self.agents.values():
                progressed |= ag.step()
            if self.chain.job(job_id).status == Status.CLOSED:
                break
            idle = 0 if progressed else idle + 1
            if idle >= 2:
                break
        return self.chain.job(job_id)

    def snapshot(self):
        accts = [self.client.account] + [ag.account for ag in self.agents.values()]
        c = self.chain
        return {a: (c.balance(a), c.stake(a), c.gas_spent[a]) for a in accts}

    def deltas(self, before):
        """address -> (wallet change net of gas, stake change)."""
        after = self.snapshot()
        return {a: (after[a][0] - b[0] + after[a][2] - b[2], after[a][1] - b[1]) for a, b in before.items()}


@pytest.fixture(scope="module")
def world(tmp_path_factory):
    anvil, chain = start_local_chain()
    try:
        store = Store(tmp_path_factory.mktemp("store"))
        accounts = chain.accounts
        quiet = lambda msg: None  # noqa: E731
        client = Client(chain, accounts[CLIENT_INDEX], store=store, log=quiet)
        agents = {
            n: ProviderAgent(chain, accounts[PROVIDER_INDICES[n]], name=n, store=store, log=quiet)
            for n in PROVIDER_NAMES
        }
        for ag in agents.values():
            ag.register()
        yield World(chain, client, agents)
    finally:
        anvil.stop()


@pytest.fixture(scope="module")
def local_labels():
    from degpu.tasks.image_classify_v1.runner import Runner

    return Runner(MODEL.read_bytes()).classify([p.read_bytes() for p in IMAGES])


def test_unverified_job(world, local_labels):
    for ag in world.agents.values():
        ag.behavior = "honest"
    a = world.agents["A"]
    before = world.snapshot()
    job_id = world.client.post(a.account, MODEL, IMAGES, 0)
    job = world.drive(job_id)

    assert job.outcome == Outcome.DELIVERED
    assert world.client.results(job_id) == local_labels
    price = len(IMAGES) * PRICE_PER_ITEM
    d = world.deltas(before)
    assert d[world.client.account] == (-price, 0)
    assert d[a.account] == (price, 0)
    assert world.chain.balance(world.chain.market.address) == 0


def test_verified_job_cheater_caught(world, local_labels):
    """E fakes 20% of its labels; a full sample (rate 1.0) makes detection certain."""
    for ag in world.agents.values():
        ag.behavior = "honest"
    e = world.agents["E"]
    e.behavior = "cheat"
    before = world.snapshot()
    job_id = world.client.post(e.account, MODEL, IMAGES, 1.0)
    job = world.drive(job_id)

    assert job.outcome == Outcome.MAIN_OUTVOTED
    faked = e.jobs[job_id]["cheated"]
    assert len(faked) == 4
    assert [int(i) for i in job.mismatched] == faked  # every faked item was sampled and caught

    # The client can still decode M's (partly fake) labels; they differ exactly on the faked items.
    labels = world.client.results(job_id)
    assert [i for i, (x, y) in enumerate(zip(labels, local_labels)) if x != y] == faked

    n = len(IMAGES)
    price = fee = n * PRICE_PER_ITEM  # 0.002 ETH each (full sample)
    slash = 3 * ETHER // 10  # 30% of E's 1 ETH stake
    tf = 2 * ETHER // 1000  # tie-breaker fee
    d = world.deltas(before)
    assert d[world.client.account] == (price + slash - tf - (price + fee), 0)  # +0.296 ETH
    assert d[e.account] == (0, -slash)
    assert d[job.verifier] == (fee, 0)
    assert d[job.tiebreaker] == (tf, 0)
    assert world.chain.balance(world.chain.market.address) == 0
    assert not world.chain.registry.functions.isActive(e.account).call()
    e.behavior = "honest"


def test_main_refuses_inputs_not_matching_data_hash(world, monkeypatch):
    """A client that commits a wrong dataHash: the main provider refuses, the client cancels."""
    for ag in world.agents.values():
        ag.behavior = "honest"
    b = world.agents["B"]
    before = world.snapshot()
    with monkeypatch.context() as m:
        m.setattr(crypto, "data_hash", lambda model_hash, item_hashes: b"\x01" * 32)
        job_id = world.client.post(b.account, MODEL, IMAGES[:3], 0)
    job = world.drive(job_id)
    assert job.status == Status.OPEN
    assert "dataHash" in b.jobs[job_id]["refused"]

    world.client.cancel(job_id)
    job = world.chain.job(job_id)
    assert job.outcome == Outcome.CANCELLED
    d = world.deltas(before)
    assert d[world.client.account] == (0, 0)  # full refund (net of gas)
    assert d[b.account] == (0, 0)
