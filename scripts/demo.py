"""DeGPU end-to-end demo: seven scenarios on a fresh anvil chain, in both verification modes.

    uv run scripts/demo.py

Setup (docs/INTERFACE.md section 10): start anvil, deploy the registry and both markets with
every installed task, register providers A-F (1 ETH stake, each with its own X25519 key, each
offering every task at its default price: 0.0001 ETH per image or puzzle).

Replicated mode, task image-classify-v1 (200 demo images, MobileNetV2): every job deposits
2 x price (0.040 ETH) and commits to a secret verify yes/no that is revealed only after the
main provider committed.
  1. unverified job (secret "no"), main A, honest
  2. verified job (secret "yes"), main A, all honest: two verifiers re-run
     100 items each; also shows that jobs 1 and 2 looked identical on-chain
  3. cheater caught: main E fakes 20% of its labels; every faked item is caught
  4. lying verifiers: every provider except A answers random labels as verifier
  5. main F goes offline: time travel past the deadline, then expire()

Checked mode, task key-search-v1 (each key hidden among 2^16 values, posted as its hash):
every answer is verified on-chain by the KeySearchChecker contract; the deposit is N x price.
  6. honest key search, main A: 19 solvable puzzles + 1 whose key is outside its range; A is
     paid per solved puzzle
  7. cheating provider E: its made-up keys are rejected on-chain; it misses the deadline and
     expire() slashes it

Replicated mode compared by similarity, task blender-render-v1 (12 frames of a tiny Blender
scene; skipped with a note when Blender isn't installed): providers upload their frames, the
client compares M's frames with the verifiers' and disputes the ones that differ, and a
tie-breaker re-renders the disputed frames and judges.
  8. honest render job (secret "yes"), main A: the client accepts without a dispute
  9. cheating main E degrades 3 of the 12 frames: the client disputes exactly those, the
     tie-breaker confirms, and E is slashed

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
    CheckedOutcome,
    CheckedStat,
    CheckedStatus,
    Drop,
    JobRef,
    Outcome,
    Stat,
    Status,
    VState,
    start_local_chain,
)
from degpu.client import Client
from degpu.storage import Store
from degpu.tasks import get
from degpu.tasks.blender_render_v1.task import DEMO_SCENE
from degpu.tasks.image_classify_v1.runner import Runner

IMAGE_TASK = get("image-classify-v1")
KEY_TASK = get("key-search-v1")
BLENDER_TASK = get("blender-render-v1")

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
    job_ids: dict[int, JobRef] = field(default_factory=dict)  # scenario -> job

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


CLOSED = {"replicated": Status.CLOSED, "checked": CheckedStatus.CLOSED}
OUTCOMES = {"replicated": Outcome, "checked": CheckedOutcome}


def drive(world: World, ref: JobRef, max_rounds: int = 30):
    """Step the client and every agent until the job closes or two rounds pass with no progress."""
    idle = 0
    for _ in range(max_rounds):
        progressed = world.client.step()
        for ag in world.agents.values():
            progressed |= ag.step()
        job = world.chain.job(ref.mode, ref.id)
        if job.status == CLOSED[ref.mode]:
            world.client.step()  # let the client record the outcome
            for ag in world.agents.values():
                ag.step()
            return job
        idle = 0 if progressed else idle + 1
        if idle >= 2:
            return job
    return world.chain.job(ref.mode, ref.id)


def set_behaviors(world: World, default: str = "honest", **overrides: str) -> None:
    for name, ag in world.agents.items():
        ag.behavior = overrides.get(name, default)


def post(world: World, main: str, verify: bool) -> JobRef:
    """An image-classify-v1 job on the 200 demo images."""
    return world.client.post(IMAGE_TASK, world.addr(main), IMAGE_TASK.inputs(MODEL_PATH, world.images),
                             verify=verify)


def top_up(world: World, name: str) -> None:
    """Bring a provider slashed in an earlier scenario back to a 1 ETH stake."""
    c = world.chain
    ag = world.agents[name]
    stake = c.stake(ag.account)
    if stake < PROVIDER_STAKE:
        c.send(c.registry.functions.addStake(), ag.account, value=PROVIDER_STAKE - stake)
        print(f"  {name} tops its stake back up to 1 ETH (+{(PROVIDER_STAKE - stake) / ETHER:g} ETH) before the scenario")


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------

def describe(world: World, mode: str, ev) -> str:
    n, a = ev["event"], ev["args"]
    nm = world.nm
    if mode == "checked":
        if n == "JobCreated":
            return f"client posts {len(a['items'])} puzzles to {nm(a['main'])} (public, on-chain)"
        if n == "JobAccepted":
            return "main accepts"
        if n == "ResultsSubmitted":
            found = list(a["found"])
            return (f"main submits {sum(found)} answers ({len(found) - sum(found)} not found); "
                    f"the checker contract accepts every one")
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
        files = " and its result files" if a["resultsURI"] else ""
        return f"main publishes {len(a['leaves'])} leaves{files}"
    if n == "ResultsDisputed":
        items = list(a["items"])
        return f"client disputes {len(items)} items {items[:6]}{'...' if len(items) > 6 else ''} (bond posted)"
    if n == "JudgementSubmitted":
        v = list(a["verdicts"])
        return (f"tie-breaker re-ran them: main's result bad on {sum(1 for x in v if not x & 1)}, "
                f"verifier's bad on {sum(1 for x in v if not x & 2)} of {len(v)}")
    if n == "TiebreakStarted":
        m = list(a["mismatched"])
        return f"{len(m)} items go to tie-break {m[:6]}{'...' if len(m) > 6 else ''}; tie-breaker drawn: {nm(a['tiebreaker'])}"
    if n == "TiebreakShared":
        return f"client seals the mismatched items to {nm(a['tiebreaker'])}"
    if n == "TiebreakSubmitted":
        return f"tie-breaker submits {len(a['leaves'])} leaves"
    if n == "ProviderSlashed":
        return f"{nm(a['provider'])} slashed {a['amount'] / ETHER:g} ETH"
    if n == "Payout":
        return f"payout {a['amount'] / ETHER:g} ETH -> {nm(a['to'])}"
    if n == "JobClosed":
        return f"job closed: {OUTCOMES[mode](a['outcome']).name}"
    return n


def print_timeline(world: World, ref: JobRef, events: list, notes: list[tuple[int, str]]) -> None:
    print("  timeline:")
    rows = [(ev["blockNumber"], 0, describe(world, ref.mode, ev)) for ev in events]
    rows += [(blk, 1, f"-- {text} --") for blk, text in notes]  # a note sits after its block's events
    for blk, _, text in sorted(rows, key=lambda r: (r[0], r[1])):
        print(f"    block {blk:>4}  {text}")


def settle_report(world: World, ref: JobRef, before: dict, events: list) -> dict[str, tuple[int, int]]:
    """Print the balance table; return address -> (wallet change net of gas, stake change)."""
    c = world.chain
    after = snapshot(world)
    job = c.job(ref.mode, ref.id)
    roles = {job.client: "client", job.main: "main"}
    if ref.mode == "replicated":
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
    # a replicated job deposits 2 x price (plus a bond if the client disputed), a checked job N x price
    paid_in = 2 * job.price + job.disputeBond if ref.mode == "replicated" else job.numItems * job.pricePerItem
    mismatches = []
    for addr, (net, dstake) in deltas.items():
        from_events = payouts.get(addr, 0) - (paid_in if addr == job.client else 0)
        if net != from_events:
            mismatches.append(f"{world.nm(addr)} wallet {fmt(net)} vs events {fmt(from_events)}")
        if -dstake != slashes.get(addr, 0):
            mismatches.append(f"{world.nm(addr)} stake {fmt(dstake)} vs slashed {fmt(slashes.get(addr, 0))}")
    world.check(not mismatches, "balance changes (net of gas) match the Payout / ProviderSlashed events"
                + (": " + "; ".join(mismatches) if mismatches else ""))
    world.check(all(c.balance(m.address) == 0 for m in c.markets.values()), "the markets hold no ETH after the job closed")
    world.check(all(c.provider(world.addr(n)).locks == 0 for n in PROVIDER_NAMES), "no provider is still locked")
    return deltas


def expect(world: World, deltas: dict, job, expected: dict[str, tuple[str, str]]) -> None:
    """``expected``: role or name -> (wallet net ETH, stake change ETH). Everyone else: (0, 0)."""
    role_addr = {"client": job.client, "main": job.main}
    if hasattr(job, "verifiers"):
        role_addr["tiebreaker"] = job.tiebreaker
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


def finish(world: World, ref: JobRef, before: dict, start_block: int, notes=()) -> tuple:
    events = world.chain.events(ref.mode, start_block, job_id=ref.id)
    print_timeline(world, ref, events, list(notes))
    deltas = settle_report(world, ref, before, events)
    return world.chain.job(ref.mode, ref.id), deltas


def check_labels(world: World, ref: JobRef) -> None:
    labels = world.client.results(ref)
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
    ref = world.job_ids[1] = post(world, "A", False)
    drive(world, ref)
    job, deltas = finish(world, ref, before, blk)
    world.check(job.outcome == Outcome.DELIVERED, f"outcome {Outcome(job.outcome).name} (want DELIVERED)")
    expect(world, deltas, job, {"client": ("-0.020", "0"), "A": ("0.020", "0")})
    check_labels(world, ref)


def show_hidden_decision(world: World, refs: list[JobRef]) -> None:
    """What anyone (including the main provider) sees on-chain right after posting."""
    c = world.chain
    print("  what the chain shows right after posting (the main provider sees the same):")
    print(f"    {'job':<14}{'deposit (ETH)':>15}{'items':>7}  {'main':<6}{'verifyCommit':<16}")
    rows = []
    for ref in refs:
        ev = next(e for e in c.events(ref.mode, 0, job_id=ref.id) if e["event"] == "JobCreated")
        value = c.w3.eth.get_transaction(ev["transactionHash"])["value"]
        a = ev["args"]
        rows.append((value, a["numItems"], a["main"]))
        print(f"    {str(ref):<14}{value / ETHER:>15.3f}{a['numItems']:>7}  {world.nm(a['main']):<6}"
              f"0x{bytes(a['verifyCommit']).hex()[:10]}...")
    world.check(len(set(rows)) == 1,
                f"jobs {', '.join(map(str, refs))} locked the same deposit for the same main: "
                f"nothing shows which one is verified")


def scenario_2(world: World) -> None:
    header(2, "verified job, honest (main A, secret decision: yes)")
    set_behaviors(world)
    before, blk = snapshot(world), world.chain.block_number() + 1
    ref = world.job_ids[2] = post(world, "A", True)
    show_hidden_decision(world, [world.job_ids[1], ref])
    drive(world, ref)
    job, deltas = finish(world, ref, before, blk)
    world.check(job.outcome == Outcome.VERIFIED, f"outcome {Outcome(job.outcome).name} (want VERIFIED)")
    expect(world, deltas, job, {
        "client": ("-0.040", "0"),
        "A": ("0.020", "0"),
        "verifier0": ("0.010", "0"),
        "verifier1": ("0.010", "0"),
    })
    check_labels(world, ref)


def scenario_3(world: World) -> None:
    header(3, "cheater caught (main E fakes 20% of labels, secret decision: yes)")
    set_behaviors(world, E="cheat")
    before, blk = snapshot(world), world.chain.block_number() + 1
    ref = world.job_ids[3] = post(world, "E", True)
    drive(world, ref)
    job, deltas = finish(world, ref, before, blk)
    world.check(job.outcome == Outcome.MAIN_OUTVOTED, f"outcome {Outcome(job.outcome).name} (want MAIN_OUTVOTED)")
    expect(world, deltas, job, {
        "client": ("0.278", "0"),
        "E": ("0", "-0.3"),
        "verifier0": ("0.010", "0"),
        "verifier1": ("0.010", "0"),
        "tiebreaker": ("0.002", "0"),
    })
    # Every item was re-run, so every faked label was caught.
    faked = set(world.agents["E"].jobs[ref.mode][ref.id].get("cheated", []))
    world.check(set(int(i) for i in job.mismatched) == faked and len(faked) == 40,
                f"the contract flagged exactly E's {len(faked)} faked items (full coverage, no luck involved)")
    labels = world.client.results(ref)
    differ = {i for i, (a, b) in enumerate(zip(labels, world.expected_labels)) if a != b}
    world.check(differ == faked, "decoded labels differ from a local run exactly on the faked items")
    world.check(not world.chain.registry.functions.isActive(job.main).call(),
                "E's stake fell below minStake: E is suspended")


def scenario_4(world: World) -> None:
    header(4, "lying verifiers (main A, secret decision: yes, every other provider lies as verifier)")
    set_behaviors(world, default="liar", A="honest")
    before, blk = snapshot(world), world.chain.block_number() + 1
    ref = world.job_ids[4] = post(world, "A", True)
    drive(world, ref)
    job, deltas = finish(world, ref, before, blk)
    world.check(job.outcome == Outcome.VERIFIER_OUTVOTED,
                f"outcome {Outcome(job.outcome).name} (want VERIFIER_OUTVOTED)")
    expect(world, deltas, job, {
        "client": ("0.578", "0"),
        "A": ("0.020", "0"),
        "verifier0": ("0", "-0.3"),
        "verifier1": ("0", "-0.3"),
        "tiebreaker": ("0.002", "0"),
    })
    check_labels(world, ref)


def scenario_5(world: World) -> None:
    header(5, "main offline (main F, secret decision: no): time travel, then expire()")
    set_behaviors(world, F="offline")
    c = world.chain
    top_up(world, "F")  # F may have been one of the slashed liars in scenario 4
    before, blk = snapshot(world), c.block_number() + 1
    ref = world.job_ids[5] = post(world, "F", False)
    job = drive(world, ref)
    world.check(job.status == Status.COMMITTING, f"job stuck in {Status(job.status).name} (want COMMITTING)")

    jump = job.deadline - c.now() + 1
    c.increase_time(jump)
    c.mine()
    notes = [(c.block_number(), f"time travel +{jump} s, past the commit deadline")]
    world.client.expire(ref)
    drive(world, ref)
    job, deltas = finish(world, ref, before, blk, notes)
    world.check(job.outcome == Outcome.MAIN_MISSED, f"outcome {Outcome(job.outcome).name} (want MAIN_MISSED)")
    expect(world, deltas, job, {"client": ("0.100", "0"), "F": ("0", "-0.1")})


KEY_PUZZLES = 20
KEY_BITS = 16  # each key hides among 2^16 values: up to 65k hashes to find it


def scenario_6(world: World) -> None:
    header(6, f"key search, checked mode (main A, {KEY_PUZZLES - 1} keys at {KEY_BITS} bits + 1 not in its range)")
    set_behaviors(world)
    c = world.chain
    before, blk = snapshot(world), c.block_number() + 1
    items = KEY_TASK.items(KEY_PUZZLES - 1, KEY_BITS, impossible=1)
    ref = world.job_ids[6] = world.client.post(KEY_TASK, world.addr("A"), items)
    drive(world, ref)
    job, deltas = finish(world, ref, before, blk)
    world.check(job.outcome == CheckedOutcome.DELIVERED, f"outcome {CheckedOutcome(job.outcome).name} (want DELIVERED)")
    # paid per solved puzzle: 19 x 0.0001; the unsolvable puzzle's 0.0001 goes back to the client
    expect(world, deltas, job, {"client": ("-0.0019", "0"), "A": ("0.0019", "0")})
    keys = world.client.results(ref)
    valid = all(KEY_TASK.check(item, k.to_bytes(32, "big")) for item, k in zip(items, keys) if k is not None)
    world.check(valid and keys[-1] is None and sum(k is not None for k in keys) == KEY_PUZZLES - 1,
                f"the client got {KEY_PUZZLES - 1} valid keys and 'not found' for the unsolvable puzzle")


def scenario_7(world: World) -> None:
    header(7, "cheating provider, checked mode (main E submits made-up keys): rejected on-chain, then expire()")
    set_behaviors(world, E="cheat")
    c = world.chain
    top_up(world, "E")  # E was slashed in scenario 3
    before, blk = snapshot(world), c.block_number() + 1
    items = KEY_TASK.items(KEY_PUZZLES, KEY_BITS)
    ref = world.job_ids[7] = world.client.post(KEY_TASK, world.addr("E"), items)
    job = drive(world, ref)
    st = world.agents["E"].jobs[ref.mode][ref.id]
    world.check(job.status == CheckedStatus.WORKING and "invalid answer" in st.get("rejected", ""),
                "the KeySearchChecker rejected E's submission: no wrong answer is ever accepted")

    jump = job.deadline - c.now() + 1
    c.increase_time(jump)
    c.mine()
    notes = [(c.block_number(), f"time travel +{jump} s, past the work deadline")]
    world.client.expire(ref)
    drive(world, ref)
    job, deltas = finish(world, ref, before, blk, notes)
    world.check(job.outcome == CheckedOutcome.MAIN_MISSED,
                f"outcome {CheckedOutcome(job.outcome).name} (want MAIN_MISSED)")
    expect(world, deltas, job, {"client": ("0.100", "0"), "E": ("0", "-0.1")})


RENDER_FRAMES = list(range(1, 13))


def render_ready() -> bool:
    """Blender is installed (and the demo scene built); otherwise print why the scenario is skipped."""
    if not BLENDER_TASK.available():
        print("  skipped: Blender (the pinned version) is not installed; install it and re-run the demo")
        return False
    if not DEMO_SCENE.exists():
        import subprocess

        from degpu.tasks.blender_render_v1.render import find_blender

        print("  building the demo scene with Blender ...")
        subprocess.run([find_blender(), "-b", "--factory-startup", "--python", str(REPO / "scripts" / "make_demo_scene.py"),
                        "--", str(DEMO_SCENE)], check=True, capture_output=True)
    return True


def post_render(world: World, main: str, verify: bool) -> JobRef:
    return world.client.post(BLENDER_TASK, world.addr(main), BLENDER_TASK.inputs(DEMO_SCENE, RENDER_FRAMES),
                             verify=verify)


def scenario_8(world: World) -> None:
    header(8, f"render job compared by similarity (main A, {len(RENDER_FRAMES)} frames, secret decision: yes)")
    if not render_ready():
        return
    from degpu.tasks.blender_render_v1 import similarity

    set_behaviors(world)
    before, blk = snapshot(world), world.chain.block_number() + 1
    ref = world.job_ids[8] = post_render(world, "A", True)
    drive(world, ref, max_rounds=40)
    job, deltas = finish(world, ref, before, blk)
    world.check(job.outcome == Outcome.VERIFIED, f"outcome {Outcome(job.outcome).name} (want VERIFIED)")
    expect(world, deltas, job, {
        "client": ("-0.024", "0"),
        "A": ("0.012", "0"),
        "verifier0": ("0.006", "0"),
        "verifier1": ("0.006", "0"),
    })
    review = world.client.jobs[ref.mode][ref.id].get("review", {})
    world.check(review.get("compared") == len(RENDER_FRAMES) and review.get("disputed") == [],
                f"the client compared all {len(RENDER_FRAMES)} frames with the verifiers' and disputed none")
    frames = world.client.results(ref)
    local = BLENDER_TASK.run(BLENDER_TASK.load(DEMO_SCENE.read_bytes()), [b"%d" % f for f in RENDER_FRAMES])
    psnrs = [similarity.min_tile_psnr(a, b) for a, b in zip(frames, local)]
    shown = ", ".join("inf" if p == float("inf") else f"{p:.0f}" for p in psnrs)
    print(f"  worst-tile PSNR of A's frames vs a fresh local render (dB): {shown}")


def scenario_9(world: World) -> None:
    header(9, f"render job, cheating main (E degrades 3 of {len(RENDER_FRAMES)} frames, secret decision: yes)")
    if not render_ready():
        return
    set_behaviors(world, E="cheat")
    e = world.agents["E"]
    e.cheat_fraction = 0.25
    top_up(world, "E")  # E was slashed in scenario 7
    before, blk = snapshot(world), world.chain.block_number() + 1
    ref = world.job_ids[9] = post_render(world, "E", True)
    drive(world, ref, max_rounds=40)
    job, deltas = finish(world, ref, before, blk)
    e.cheat_fraction = 0.2
    world.check(job.outcome == Outcome.MAIN_OUTVOTED, f"outcome {Outcome(job.outcome).name} (want MAIN_OUTVOTED)")
    expect(world, deltas, job, {
        "client": ("0.286", "0"),
        "E": ("0", "-0.3"),
        "verifier0": ("0.006", "0"),
        "verifier1": ("0.006", "0"),
        "tiebreaker": ("0.002", "0"),
    })
    faked = e.jobs[ref.mode][ref.id].get("cheated", [])
    world.check([int(i) for i in job.mismatched] == faked and len(faked) == 3,
                f"the client disputed exactly E's {len(faked)} degraded frames, and the tie-breaker confirmed")


def print_reputation(world: World) -> None:
    print()
    print("Reputation counters (ProviderRegistry stats, per market) and stakes:")
    cols = [("replicated", "verified", Stat.VERIFIED_COMPLETED), ("replicated", "unverif", Stat.UNVERIFIED_COMPLETED),
            ("replicated", "missed", Stat.MISSED), ("replicated", "outvoted", Stat.OUTVOTED),
            ("replicated", "checks", Stat.CHECKS_COMPLETED), ("replicated", "chkMiss", Stat.CHECKS_MISSED),
            ("replicated", "chkOutv", Stat.CHECKS_OUTVOTED),
            ("checked", "solvJobs", CheckedStat.COMPLETED), ("checked", "solvMiss", CheckedStat.MISSED),
            ("checked", "solved", CheckedStat.ITEMS_SOLVED), ("checked", "notFound", CheckedStat.ITEMS_NOT_FOUND)]
    print("    " + f"{'':<4}{'stake':>8}" + "".join(f"{n:>9}" for _, n, _ in cols))
    for name in PROVIDER_NAMES:
        a = world.addr(name)
        stats = "".join(f"{world.chain.stat(a, mode, s):>9}" for mode, _, s in cols)
        print(f"    {name:<4}{world.chain.stake(a) / ETHER:>8.3f}{stats}")


SCENARIOS = (scenario_1, scenario_2, scenario_3, scenario_4, scenario_5, scenario_6, scenario_7,
             scenario_8, scenario_9)


def main() -> int:
    if not MODEL_PATH.exists() or len(list(IMAGE_DIR.glob("*.jpg"))) < NUM_IMAGES:
        print("demo assets missing: run `uv run scripts/fetch_demo_assets.py` first")
        return 2

    print("DeGPU demo: starting a fresh anvil chain and deploying the contracts ...")
    anvil, chain = start_local_chain()
    try:
        with tempfile.TemporaryDirectory(prefix="degpu-store-") as tmp:
            markets = ", ".join(f"{mode} market {m.address}" for mode, m in chain.markets.items())
            print(f"  anvil {anvil.rpc_url}, registry {chain.registry.address}, {markets}")
            world = setup(chain, Store(tmp))
            for scenario in SCENARIOS:
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
