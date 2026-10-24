"""End-to-end tests on a real anvil chain: client + provider agents + contracts, for both
verification modes.

Uses 20 of the demo images (one in ten, so several classes are covered) to stay fast. The
image tests are skipped if the demo assets are missing; everything is skipped without anvil.
"""

import shutil
from pathlib import Path

import pytest

from degpu import crypto
from degpu.agent import ProviderAgent
from degpu.chain import (
    CLIENT_INDEX,
    ETHER,
    PROVIDER_INDICES,
    PROVIDER_NAMES,
    CheckedOutcome,
    CheckedStat,
    CheckedStatus,
    Drop,
    Outcome,
    Status,
    start_local_chain,
)
from degpu.client import Client
from degpu.storage import Store
from degpu.tasks import get

REPO = Path(__file__).resolve().parent.parent
MODEL = REPO / "assets" / "mobilenetv2.onnx"
IMAGES = sorted((REPO / "assets" / "images").glob("*.jpg"))[::10]
IMAGE_TASK = get("image-classify-v1")
NONCE_TASK = get("nonce-search-v1")

pytestmark = pytest.mark.skipif(shutil.which("anvil") is None, reason="anvil (Foundry) not installed")
needs_assets = pytest.mark.skipif(not MODEL.exists() or len(IMAGES) < 20,
                                  reason="demo assets missing; run scripts/fetch_demo_assets.py")


class World:
    def __init__(self, chain, client, agents):
        self.chain, self.client, self.agents = chain, client, agents

    def drive(self, ref, rounds=20):
        """Step the client and all agents until the job closes or nothing moves."""
        closed = Status.CLOSED if ref.mode == "replicated" else CheckedStatus.CLOSED
        idle = 0
        for _ in range(rounds):
            progressed = self.client.step()
            for ag in self.agents.values():
                progressed |= ag.step()
            if self.chain.job(ref.mode, ref.id).status == closed:
                self.client.step()  # let the client record the outcome
                break
            idle = 0 if progressed else idle + 1
            if idle >= 2:
                break
        return self.chain.job(ref.mode, ref.id)

    def snapshot(self):
        accts = [self.client.account] + [ag.account for ag in self.agents.values()]
        c = self.chain
        return {a: (c.balance(a), c.stake(a), c.gas_spent[a]) for a in accts}

    def deltas(self, before):
        """address -> (wallet change net of gas, stake change)."""
        after = self.snapshot()
        return {a: (after[a][0] - b[0] + after[a][2] - b[2], after[a][1] - b[1]) for a, b in before.items()}

    def markets_empty(self) -> bool:
        return all(self.chain.balance(m.address) == 0 for m in self.chain.markets.values())

    def honest(self, **overrides):
        for name, ag in self.agents.items():
            ag.behavior = overrides.get(name, "honest")


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


def post_images(world, main, images, **options):
    return world.client.post(IMAGE_TASK, main, IMAGE_TASK.inputs(MODEL, images), **options)


# ---------------------------------------------------------------------------
# Replicated mode
# ---------------------------------------------------------------------------

@needs_assets
def test_unverified_job(world, local_labels):
    world.honest()
    a = world.agents["A"]
    before = world.snapshot()
    ref = post_images(world, a.account, IMAGES, verify=False)
    job = world.drive(ref)

    assert job.outcome == Outcome.DELIVERED
    assert not job.verify and len(job.verifiers) == 0
    assert world.client.results(ref) == local_labels
    price = len(IMAGES) * IMAGE_TASK.default_price
    d = world.deltas(before)
    assert d[world.client.account] == (-price, 0)  # deposited 2 x price, half refunded
    assert d[a.account] == (price, 0)
    assert world.markets_empty()


@needs_assets
def test_verified_job_cheater_caught(world, local_labels):
    """E fakes 20% of its labels; two verifiers re-run every item, so every fake is caught."""
    world.honest(E="cheat")
    e = world.agents["E"]
    before = world.snapshot()
    ref = post_images(world, e.account, IMAGES, verify=True)
    job = world.drive(ref)

    assert job.outcome == Outcome.MAIN_OUTVOTED
    assert len(job.verifiers) == 2
    faked = e.jobs["replicated"][ref.id]["cheated"]
    assert len(faked) == 4
    assert [int(i) for i in job.mismatched] == faked  # every faked item was caught

    # The client can still decode M's (partly fake) labels; they differ exactly on the faked items.
    labels = world.client.results(ref)
    assert [i for i, (x, y) in enumerate(zip(labels, local_labels)) if x != y] == faked

    n = len(IMAGES)
    price = n * IMAGE_TASK.default_price  # 0.002 ETH
    half = price // 2  # each verifier covers 10 items
    slash = 3 * ETHER // 10  # 30% of E's 1 ETH stake
    tf = 2 * ETHER // 1000  # tie-breaker fee
    d = world.deltas(before)
    assert d[world.client.account] == (slash - 2 * half - tf, 0)  # +0.296 ETH
    assert d[e.account] == (0, -slash)
    for v in job.verifiers:
        assert d[v] == (half, 0)
    assert d[job.tiebreaker] == (tf, 0)
    assert world.markets_empty()
    assert not world.chain.registry.functions.isActive(e.account).call()
    world.honest()


@needs_assets
def test_main_refuses_inputs_not_matching_data_hash(world, monkeypatch):
    """A client that commits a wrong dataHash: the main provider refuses, the client cancels."""
    world.honest()
    b = world.agents["B"]
    before = world.snapshot()
    with monkeypatch.context() as m:
        m.setattr(crypto, "data_hash", lambda shared_hash, item_hashes: b"\x01" * 32)
        ref = post_images(world, b.account, IMAGES[:3])
    job = world.drive(ref)
    assert job.status == Status.OPEN
    assert "dataHash" in b.jobs["replicated"][ref.id]["refused"]

    world.client.cancel(ref)
    job = world.chain.job(ref.mode, ref.id)
    assert job.outcome == Outcome.CANCELLED
    d = world.deltas(before)
    assert d[world.client.account] == (0, 0)  # full refund (net of gas)
    assert d[b.account] == (0, 0)


@needs_assets
def test_client_never_reveals_counts_as_unverified(world, local_labels):
    """The client sits on its decision: after the decide deadline anyone can expire() the job,
    which then finishes unverified."""
    world.honest()
    c = world.agents["C"]
    before = world.snapshot()
    ref = post_images(world, c.account, IMAGES, verify=True, reveal=False)
    job = world.drive(ref)
    assert job.status == Status.DECIDING  # M committed; the decision stays hidden

    world.chain.increase_time(job.deadline - world.chain.now() + 1)
    world.chain.mine()
    world.client.expire(ref)
    job = world.drive(ref)
    assert job.outcome == Outcome.DELIVERED
    assert job.drop == Drop.CLIENT_NO_REVEAL
    assert world.client.results(ref) == local_labels
    price = len(IMAGES) * IMAGE_TASK.default_price
    d = world.deltas(before)
    assert d[world.client.account] == (-price, 0)
    assert d[c.account] == (price, 0)


# ---------------------------------------------------------------------------
# Checked mode
# ---------------------------------------------------------------------------

def test_mining_paid_per_solved_puzzle(world):
    """5 solvable puzzles and 1 impossible one: D is paid for 5, the client gets 1 refunded."""
    world.honest()
    d_agent = world.agents["D"]
    before = world.snapshot()
    items = NONCE_TASK.items(5, difficulty=10, impossible=1)
    ref = world.client.post(NONCE_TASK, d_agent.account, items)
    job = world.drive(ref)

    assert job.outcome == CheckedOutcome.DELIVERED
    assert job.solved == 5
    nonces = world.client.results(ref)
    assert nonces[-1] is None
    for item, nonce in zip(items[:5], nonces[:5]):
        assert NONCE_TASK.check(item, nonce.to_bytes(32, "big"))
    ppi = NONCE_TASK.default_price
    d = world.deltas(before)
    assert d[world.client.account] == (-5 * ppi, 0)
    assert d[d_agent.account] == (5 * ppi, 0)
    assert world.chain.stat(d_agent.account, "checked", CheckedStat.ITEMS_NOT_FOUND) == 1
    assert world.markets_empty()


def test_mining_wrong_answers_rejected_then_slashed(world):
    """F submits made-up nonces: the checker rejects the submission on-chain, F misses its
    deadline and expire() slashes it; the client is refunded in full plus the slash."""
    world.honest(F="cheat")
    f = world.agents["F"]
    before = world.snapshot()
    ref = world.client.post(NONCE_TASK, f.account, NONCE_TASK.items(3, difficulty=8))
    job = world.drive(ref)
    assert job.status == CheckedStatus.WORKING
    assert "invalid answer" in f.jobs["checked"][ref.id]["rejected"]

    world.chain.increase_time(job.deadline - world.chain.now() + 1)
    world.chain.mine()
    world.client.expire(ref)
    job = world.drive(ref)
    assert job.outcome == CheckedOutcome.MAIN_MISSED
    slash = 1 * ETHER // 10  # 10% of F's 1 ETH stake
    d = world.deltas(before)
    assert d[world.client.account] == (slash, 0)
    assert d[f.account] == (0, -slash)
    assert world.markets_empty()
    world.honest()


def test_agent_only_takes_offered_tasks(world):
    """An agent started with --tasks image-classify-v1 never offers the mining task, so a
    client can't post one to it."""
    from degpu.chain import TxFailed

    a = world.agents["A"]
    picky = ProviderAgent(world.chain, a.account, name="A2", store=a.store, keypair=(a.priv, a.pub),
                          log=lambda m: None, tasks=["image-classify-v1"])
    assert list(picky.tasks) == ["image-classify-v1"]
    tid = world.chain.task_id(NONCE_TASK.name)
    reg = world.chain.registry.functions
    world.chain.send(reg.setPrice(world.chain.markets["checked"].address, tid, 0), a.account)
    try:
        with pytest.raises(TxFailed, match="main does not offer task"):
            world.client.post(NONCE_TASK, a.account, NONCE_TASK.items(1, difficulty=4))
    finally:
        a.register()  # offers every task again
