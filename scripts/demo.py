"""DeGPU end-to-end demo: five scenarios on a fresh anvil chain.

    uv run scripts/demo.py

Setup (docs/INTERFACE.md v2, section 9): start anvil, deploy the contracts,
register providers A-F (1 ETH stake, 0.0001 ETH per item, each with its own
X25519 key) and use the 200 demo images in assets/images/ with the
MobileNetV2 model. Every job deposits 2 x price (0.040 ETH) and commits to a
secret verify yes/no that is revealed only after the main provider committed.

Scenarios:
  1. unverified job (secret "no"), main A, honest
  2. verified job (secret "yes"), main A, all honest: two verifiers re-run
     100 items each; also shows that jobs 1 and 2 looked identical on-chain
  3. cheater caught: main E fakes 20% of its labels; every faked item is caught
  4. lying verifiers: every provider except A answers random labels as verifier
  5. main F goes offline: time travel past the deadline, then expire()

Everything runs in-process with a deterministic step loop (client first,
then agents A-F, repeated until the job closes or nothing moves). For each
scenario the demo prints the agents' log, the job's on-chain event timeline
and a balance table, and asserts the expected results net of gas: wallet
changes plus the gas each account paid, cross-checked against the Payout and
ProviderSlashed events and the registry stakes. It also checks that the
labels decoded by the client equal a local Runner run. Exit code 1 if any
check fails.
"""

from __future__ import annotations

import sys
import tempfile
from dataclasses import dataclass, field
from decimal import Decimal
from pathlib import Path

from degpu.agent import ProviderAgent
from degpu.chain import (
    CLIENT_INDEX,
    ETHER,
    PROVIDER_INDICES,
    PROVIDER_NAMES,
    PROVIDER_STAKE,
    ZERO_ADDRESS,
    Chain,
    Drop,
    Outcome,
    Stat,
    Status,
    VState,
    start_local_chain,
)
from degpu.client import Client
from degpu.storage import Store
from degpu.tasks.image_classify_v1.runner import Runner

REPO = Path(__file__).resolve().parent.parent
MODEL_PATH = REPO / "assets" / "mobilenetv2.onnx"
IMAGE_DIR = REPO / "assets" / "images"
NUM_IMAGES = 200


def wei(eth_str: str) -> int:
    return int(Decimal(eth_str) * ETHER)


def fmt(w: int) -> str:
    return f"{w / ETHER:+.6f}"


# ---------------------------------------------------------------------------
# World: chain, client, agents
# ---------------------------------------------------------------------------

@dataclass
class World:
    chain: Chain
    client: Client
    agents: dict[str, ProviderAgent]
    images: list[Path]
    expected_labels: list[int]
    names: dict[str, str] = field(default_factory=dict)  # address -> short name
    failures: list[str] = field(default_factory=list)
    job_ids: dict[int, int] = field(default_factory=dict)  # scenario -> jobId

    def nm(self, addr: str) -> str:
        return self.names.get(addr, addr[:10])

    def addr(self, name: str) -> str:
        return self.client.account if name == "client" else self.agents[name].account

    def check(self, cond: bool, msg: str) -> bool:
        print(f"    [{'ok' if cond else 'FAIL'}] {msg}")
        if not cond:
            self.failures.append(msg)
        return cond


def indent(msg: str) -> None:
    print("    " + msg)


def setup(chain: Chain, store: Store) -> World:
    accounts = chain.accounts
    client = Client(chain, accounts[CLIENT_INDEX], store=store, log=indent)
    agents = {
        name: ProviderAgent(chain, accounts[PROVIDER_INDICES[name]], "honest", name=name, store=store, log=indent)
        for name in PROVIDER_NAMES
    }
    for ag in agents.values():
        ag.register()
    images = sorted(IMAGE_DIR.glob("*.jpg"))[:NUM_IMAGES]
    print(f"  running the model locally on {len(images)} images for reference labels ...")
    expected = Runner(MODEL_PATH.read_bytes()).classify([p.read_bytes() for p in images])
    world = World(chain, client, agents, images, expected)
    world.names = {client.account: "client", accounts[0]: "deployer"}
    world.names.update({ag.account: n for n, ag in agents.items()})
    client.names = world.names
    return world


# ---------------------------------------------------------------------------
# Running a job
# ---------------------------------------------------------------------------

def snapshot(world: World) -> dict[str, tuple[int, int, int]]:
    """address -> (wallet balance, registry stake, gas paid so far)."""
    c = world.chain
    out = {}
    for name in ["client", *PROVIDER_NAMES]:
        a = world.addr(name)
        stake = c.stake(a) if name != "client" else 0
        out[a] = (c.balance(a), stake, c.gas_spent[a])
    return out


def drive(world: World, job_id: int, max_rounds: int = 30):
    """Step the client and every agent until the job closes or two rounds pass with no progress."""
    idle = 0
    for _ in range(max_rounds):
        progressed = world.client.step()
        for ag in world.agents.values():
            progressed |= ag.step()
        job = world.chain.job(job_id)
        if job.status == Status.CLOSED:
            world.client.step()  # let the client record the outcome
            for ag in world.agents.values():
                ag.step()
            return job
        idle = 0 if progressed else idle + 1
        if idle >= 2:
            return job
    return world.chain.job(job_id)


def set_behaviors(world: World, default: str = "honest", **overrides: str) -> None:
    for name, ag in world.agents.items():
        ag.behavior = overrides.get(name, default)


def post(world: World, main: str, verify: bool) -> int:
    return world.client.post(world.addr(main), MODEL_PATH, world.images, verify)


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------

def describe(world: World, ev) -> str:
    n, a = ev["event"], ev["args"]
    nm = world.nm
    if n == "JobCreated":
        return f"client posts {a['numItems']} items to {nm(a['main'])} (decision hidden: {bytes(a['verifyCommit']).hex()[:10]}...)"
    if n == "JobAccepted":
        return "main accepts"
    if n == "ResultsCommitted":
        return "main commits to its results (it doesn't know yet whether it will be checked)"
    if n == "DecisionRevealed":
        return f"client reveals its decision: {'VERIFY' if a['verify'] else 'no verification'}"
    if n == "VerificationDropped":
        return f"verification dropped: {Drop(a['reason']).name}"
    if n == "VerifiersDrawn":
        return "verifiers drawn: " + ", ".join(nm(v) for v in a["verifiers"])
    if n == "RangeShared":
        return f"client seals range {a['slot']} to {nm(a['verifier'])}"
    if n == "CheckCommitted":
        return f"verifier {a['slot']} commits to its check"
    if n == "VerifierDropped":
        return f"verifier {a['slot']} dropped: {VState(a['reason']).name}"
    if n == "CheckRevealed":
        return f"verifier {a['slot']} reveals {len(a['leaves'])} leaves"
    if n == "ResultsPublished":
        return f"main publishes {len(a['leaves'])} leaves"
    if n == "TiebreakStarted":
        m = list(a["mismatched"])
        return f"{len(m)} items mismatch {m[:6]}{'...' if len(m) > 6 else ''}; tie-breaker drawn: {nm(a['tiebreaker'])}"
    if n == "TiebreakShared":
        return f"client seals the mismatched items to {nm(a['tiebreaker'])}"
    if n == "TiebreakSubmitted":
        return f"tie-breaker submits {len(a['leaves'])} leaves"
    if n == "ProviderSlashed":
        return f"{nm(a['provider'])} slashed {a['amount'] / ETHER:g} ETH"
    if n == "Payout":
        return f"payout {a['amount'] / ETHER:g} ETH -> {nm(a['to'])}"
    if n == "JobClosed":
        return f"job closed: {Outcome(a['outcome']).name}"
    return n


def print_timeline(world: World, job_id: int, events: list, notes: list[tuple[int, str]]) -> None:
    print("  timeline:")
    rows = [(ev["blockNumber"], 0, describe(world, ev)) for ev in events]
    rows += [(blk, 1, f"-- {text} --") for blk, text in notes]  # a note sits after its block's events
    for blk, _, text in sorted(rows, key=lambda r: (r[0], r[1])):
        print(f"    block {blk:>4}  {text}")


def settle_report(world: World, job_id: int, before: dict, events: list) -> dict[str, tuple[int, int]]:
    """Print the balance table; return address -> (wallet change net of gas, stake change)."""
    c = world.chain
    after = snapshot(world)
    job = c.job(job_id)
    roles = {job.client: "client", job.main: "main"}
    for slot, v in enumerate(job.verifiers):
        roles[v] = f"verifier{slot}"
    if job.tiebreaker != ZERO_ADDRESS:
        roles[job.tiebreaker] = "tiebreaker"

    payouts: dict[str, int] = {}
    slashes: dict[str, int] = {}
    for ev in events:
        if ev["event"] == "Payout":
            payouts[ev["args"]["to"]] = payouts.get(ev["args"]["to"], 0) + ev["args"]["amount"]
        elif ev["event"] == "ProviderSlashed":
            p = ev["args"]["provider"]
            slashes[p] = slashes.get(p, 0) + ev["args"]["amount"]

    print("  balances (ETH):")
    print(f"    {'who':<7}{'role':<11}{'wallet net of gas':>18}{'gas paid':>11}{'payouts(ev)':>13}"
          f"{'stake':>10}{'stake chg':>11}")
    deltas = {}
    for addr, (bal0, stake0, gas0) in before.items():
        bal1, stake1, gas1 = after[addr]
        gas = gas1 - gas0
        net = bal1 - bal0 + gas
        dstake = stake1 - stake0
        deltas[addr] = (net, dstake)
        stake_s = f"{stake1 / ETHER:.4f}" if addr != world.client.account else "-"
        print(f"    {world.nm(addr):<7}{roles.get(addr, ''):<11}{fmt(net):>18}{gas / ETHER:>11.6f}"
              f"{payouts.get(addr, 0) / ETHER:>13.6f}{stake_s:>10}{fmt(dstake):>11}")

    # Cross-checks that hold for every job: the events explain every balance change.
    # wallet change net of gas == Payout events (minus what the client paid in);
    # stake change == -(ProviderSlashed events)
    paid_in = 2 * job.price  # every job deposits 2 x price
    mismatches = []
    for addr, (net, dstake) in deltas.items():
        from_events = payouts.get(addr, 0) - (paid_in if addr == job.client else 0)
        if net != from_events:
            mismatches.append(f"{world.nm(addr)} wallet {fmt(net)} vs events {fmt(from_events)}")
        if -dstake != slashes.get(addr, 0):
            mismatches.append(f"{world.nm(addr)} stake {fmt(dstake)} vs slashed {fmt(slashes.get(addr, 0))}")
    world.check(not mismatches, "balance changes (net of gas) match the Payout / ProviderSlashed events"
                + (": " + "; ".join(mismatches) if mismatches else ""))
    world.check(c.balance(c.market.address) == 0, "JobMarket holds no ETH after the job closed")
    world.check(all(c.provider(world.addr(n)).locks == 0 for n in PROVIDER_NAMES), "no provider is still locked")
    return deltas


def expect(world: World, deltas: dict, job, expected: dict[str, tuple[str, str]]) -> None:
    """``expected``: role or name -> (wallet net ETH, stake change ETH). Everyone else: (0, 0)."""
    role_addr = {"client": job.client, "main": job.main, "tiebreaker": job.tiebreaker}
    role_addr.update({f"verifier{slot}": v for slot, v in enumerate(job.verifiers)})
    want = {}
    for who, (w, s) in expected.items():
        addr = role_addr.get(who) or world.addr(who)
        want[addr] = (wei(w), wei(s))
    for addr, (net, dstake) in deltas.items():
        w, s = want.get(addr, (0, 0))
        if addr in want or net or dstake:
            label = world.nm(addr)
            world.check(net == w and dstake == s,
                        f"{label}: wallet {fmt(net)} (want {fmt(w)}), stake {fmt(dstake)} (want {fmt(s)})")


def finish(world: World, job_id: int, before: dict, start_block: int, notes=()) -> tuple:
    events = world.chain.market_events(start_block, job_id=job_id)
    print_timeline(world, job_id, events, list(notes))
    deltas = settle_report(world, job_id, before, events)
    return world.chain.job(job_id), deltas


def check_labels(world: World, job_id: int) -> None:
    labels = world.client.results(job_id)
    same = sum(a == b for a, b in zip(labels, world.expected_labels))
    world.check(labels == world.expected_labels,
                f"decoded labels equal a local Runner run ({same}/{len(labels)} identical)")


# ---------------------------------------------------------------------------
# Scenarios
# ---------------------------------------------------------------------------

def header(n: int, title: str) -> None:
    print()
    print("=" * 78)
    print(f"Scenario {n}: {title}")
    print("=" * 78)


def scenario_1(world: World) -> None:
    header(1, "unverified job (main A, secret decision: no, all honest)")
    set_behaviors(world)
    before, blk = snapshot(world), world.chain.block_number() + 1
    job_id = world.job_ids[1] = post(world, "A", False)
    drive(world, job_id)
    job, deltas = finish(world, job_id, before, blk)
    world.check(job.outcome == Outcome.DELIVERED, f"outcome {Outcome(job.outcome).name} (want DELIVERED)")
    expect(world, deltas, job, {"client": ("-0.020", "0"), "A": ("0.020", "0")})
    check_labels(world, job_id)


def show_hidden_decision(world: World, job_ids: list[int]) -> None:
    """What anyone (including the main provider) sees on-chain right after posting."""
    c = world.chain
    print("  what the chain shows right after posting (the main provider sees the same):")
    print(f"    {'job':<5}{'deposit (ETH)':>15}{'items':>7}  {'main':<6}{'verifyCommit':<16}")
    rows = []
    for jid in job_ids:
        ev = next(e for e in c.market_events(0, job_id=jid) if e["event"] == "JobCreated")
        value = c.w3.eth.get_transaction(ev["transactionHash"])["value"]
        a = ev["args"]
        rows.append((value, a["numItems"], a["main"]))
        print(f"    {jid:<5}{value / ETHER:>15.3f}{a['numItems']:>7}  {world.nm(a['main']):<6}"
              f"0x{bytes(a['verifyCommit']).hex()[:10]}...")
    world.check(len(set(rows)) == 1,
                f"jobs {job_ids} locked the same deposit for the same main: nothing shows which one is verified")


def scenario_2(world: World) -> None:
    header(2, "verified job, honest (main A, secret decision: yes)")
    set_behaviors(world)
    before, blk = snapshot(world), world.chain.block_number() + 1
    job_id = world.job_ids[2] = post(world, "A", True)
    show_hidden_decision(world, [world.job_ids[1], job_id])
    drive(world, job_id)
    job, deltas = finish(world, job_id, before, blk)
    world.check(job.outcome == Outcome.VERIFIED, f"outcome {Outcome(job.outcome).name} (want VERIFIED)")
    expect(world, deltas, job, {
        "client": ("-0.040", "0"),
        "A": ("0.020", "0"),
        "verifier0": ("0.010", "0"),
        "verifier1": ("0.010", "0"),
    })
    check_labels(world, job_id)


def scenario_3(world: World) -> None:
    header(3, "cheater caught (main E fakes 20% of labels, secret decision: yes)")
    set_behaviors(world, E="cheat")
    before, blk = snapshot(world), world.chain.block_number() + 1
    job_id = world.job_ids[3] = post(world, "E", True)
    drive(world, job_id)
    job, deltas = finish(world, job_id, before, blk)
    world.check(job.outcome == Outcome.MAIN_OUTVOTED, f"outcome {Outcome(job.outcome).name} (want MAIN_OUTVOTED)")
    expect(world, deltas, job, {
        "client": ("0.278", "0"),
        "E": ("0", "-0.3"),
        "verifier0": ("0.010", "0"),
        "verifier1": ("0.010", "0"),
        "tiebreaker": ("0.002", "0"),
    })
    # Every item was re-run, so every faked label was caught.
    faked = set(world.agents["E"].jobs[job_id].get("cheated", []))
    world.check(set(int(i) for i in job.mismatched) == faked and len(faked) == 40,
                f"the contract flagged exactly E's {len(faked)} faked items (full coverage, no luck involved)")
    labels = world.client.results(job_id)
    differ = {i for i, (a, b) in enumerate(zip(labels, world.expected_labels)) if a != b}
    world.check(differ == faked, "decoded labels differ from a local run exactly on the faked items")
    world.check(not world.chain.registry.functions.isActive(job.main).call(),
                "E's stake fell below minStake: E is suspended")


def scenario_4(world: World) -> None:
    header(4, "lying verifiers (main A, secret decision: yes, every other provider lies as verifier)")
    set_behaviors(world, default="liar", A="honest")
    before, blk = snapshot(world), world.chain.block_number() + 1
    job_id = world.job_ids[4] = post(world, "A", True)
    drive(world, job_id)
    job, deltas = finish(world, job_id, before, blk)
    world.check(job.outcome == Outcome.VERIFIER_OUTVOTED,
                f"outcome {Outcome(job.outcome).name} (want VERIFIER_OUTVOTED)")
    expect(world, deltas, job, {
        "client": ("0.578", "0"),
        "A": ("0.020", "0"),
        "verifier0": ("0", "-0.3"),
        "verifier1": ("0", "-0.3"),
        "tiebreaker": ("0.002", "0"),
    })
    check_labels(world, job_id)


def scenario_5(world: World) -> None:
    header(5, "main offline (main F, secret decision: no): time travel, then expire()")
    set_behaviors(world, F="offline")
    c = world.chain
    f = world.agents["F"]
    stake = c.stake(f.account)
    if stake < PROVIDER_STAKE:  # F may have been one of the slashed liars in scenario 4
        top_up = PROVIDER_STAKE - stake
        c.send(c.registry.functions.addStake(), f.account, value=top_up)
        print(f"  F tops its stake back up to 1 ETH (+{top_up / ETHER:g} ETH) before the scenario")
    before, blk = snapshot(world), c.block_number() + 1
    job_id = world.job_ids[5] = post(world, "F", False)
    job = drive(world, job_id)
    world.check(job.status == Status.COMMITTING, f"job stuck in {Status(job.status).name} (want COMMITTING)")

    jump = job.deadline - c.now() + 1
    c.increase_time(jump)
    c.mine()
    notes = [(c.block_number(), f"time travel +{jump} s, past the commit deadline")]
    world.client.expire(job_id)
    drive(world, job_id)
    job, deltas = finish(world, job_id, before, blk, notes)
    world.check(job.outcome == Outcome.MAIN_MISSED, f"outcome {Outcome(job.outcome).name} (want MAIN_MISSED)")
    expect(world, deltas, job, {"client": ("0.100", "0"), "F": ("0", "-0.1")})


def print_reputation(world: World) -> None:
    print()
    print("Reputation counters (ProviderRegistry stats) and stakes:")
    cols = [("verified", Stat.VERIFIED_COMPLETED), ("unverif", Stat.UNVERIFIED_COMPLETED),
            ("missed", Stat.MISSED), ("outvoted", Stat.OUTVOTED), ("checks", Stat.CHECKS_COMPLETED),
            ("chkMiss", Stat.CHECKS_MISSED), ("chkOutv", Stat.CHECKS_OUTVOTED)]
    print("    " + f"{'':<4}{'stake':>8}" + "".join(f"{n:>10}" for n, _ in cols))
    for name in PROVIDER_NAMES:
        a = world.addr(name)
        stats = "".join(f"{world.chain.stat(a, s):>10}" for _, s in cols)
        print(f"    {name:<4}{world.chain.stake(a) / ETHER:>8.3f}{stats}")


def main() -> int:
    if not MODEL_PATH.exists() or len(list(IMAGE_DIR.glob("*.jpg"))) < NUM_IMAGES:
        print("demo assets missing: run `uv run scripts/fetch_demo_assets.py` first")
        return 2

    print("DeGPU demo: starting a fresh anvil chain and deploying the contracts ...")
    anvil, chain = start_local_chain()
    try:
        with tempfile.TemporaryDirectory(prefix="degpu-store-") as tmp:
            print(f"  anvil {anvil.rpc_url}, registry {chain.registry.address}, market {chain.market.address}")
            world = setup(chain, Store(tmp))
            for scenario in (scenario_1, scenario_2, scenario_3, scenario_4, scenario_5):
                scenario(world)
            print_reputation(world)
    finally:
        anvil.stop()

    print()
    if world.failures:
        print(f"DEMO FAILED: {len(world.failures)} check(s) failed:")
        for f in world.failures:
            print("  - " + f)
        return 1
    print("DEMO PASSED: all scenarios settled as expected.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
