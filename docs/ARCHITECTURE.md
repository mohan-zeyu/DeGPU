# DeGPU code architecture

This document explains how the code fits together: which parts exist, what each part owns, and how they cooperate to run a job. It stays at the level of components and data flow.

- For the exact rules and byte encodings, see [INTERFACE.md](INTERFACE.md).
- For setup, outcomes and the demo, see the [README](../README.md).
- For what a single function does, read the code.

## 1. The big picture

DeGPU has four layers:

| Layer | Code | Owns |
|---|---|---|
| On-chain | `contracts/src/ProviderRegistry.sol`, `contracts/src/JobMarket.sol` | money, stakes, the job state machine, every judgement |
| Actors | `degpu/client.py`, `degpu/agent.py` | the secrets and the compute: one client, one agent per provider |
| Shared libraries | `degpu/crypto.py`, `degpu/storage.py`, `degpu/chain.py`, `degpu/tasks/image_classify_v1/` | encodings, encryption, file storage, talking to the chain, the ML runner |
| Drivers | `scripts/demo.py`, `tests/`, the `python -m degpu.*` CLIs, `video/capture.py` | starting a chain, creating actors and stepping them |

```
 ┌──────────────────────────────── on-chain (anvil) ────────────────────────────────┐
 │  ProviderRegistry                                    JobMarket                   │
 │  stake, encPubKey, price,   ◀── lock · slash · bump ── task types, jobs, escrow, │
 │  locks, reputation          ── slashed ETH ─────────▶  draws, comparison,        │
 │                                                        settlement                │
 └───────────────▲───────────────────────────────────────────────▲──────────────────┘
                 │   transactions · getJob reads · event logs    │
       ┌─────────┴──────────┐                       ┌────────────┴────────────┐
       │ Client             │                       │ ProviderAgent  (× 6)    │
       │ degpu/client.py    │                       │ degpu/agent.py          │
       │ post, step,        │                       │ main, verifier and      │
       │ results            │                       │ tie-breaker roles       │
       └──┬──────────────┬──┘                       └──┬───────────────────┬──┘
          │              └─────────────┐   ┌───────────┘                   │
          │                            ▼   ▼                               │
          │        crypto.py · chain.py · tasks/image_classify_v1/         │
          │        (shared libraries)                                      │
          │                                                                │
          └── put ──▶  Store (degpu/storage.py)  ◀── get ──────────────────┘
                       encrypted model and images, plaintext manifest
```

The key design rule is that **the actors never talk to each other directly**. Everything goes through three shared channels:

1. **Contract state** (`getJob`) is the single source of truth for where a job is. Every actor picks its next move by reading it.
2. **Contract events** are the mailbox. They tell a provider it has been picked for a job, and they carry the sealed (encrypted) secrets addressed to it.
3. **The store** holds the bulk data: the encrypted model and images, plus a plaintext manifest. Only the manifest's URI and a hash go on-chain.

That is why the same client and agents run unchanged inside one Python process (the demo) or as seven separate processes (the CLI).

## 2. Module dependencies

| Module | Uses (inside DeGPU) | Used by |
|---|---|---|
| `crypto.py` | nothing | everything that hashes, encrypts or seals |
| `storage.py` | nothing | client, agent, drivers |
| `tasks/image_classify_v1/runner.py` | `crypto` (to hash its own file) | agent; `chain.start_local_chain` (to register its hash); demo and tests (reference labels) |
| `tasks/image_classify_v1/decode.py` | nothing | client |
| `chain.py` | the ABI files in `contracts/out/` | client, agent, drivers |
| `client.py` | crypto, storage, chain, decode | drivers |
| `agent.py` | crypto, storage, chain, runner | drivers |

The dependencies point one way. The libraries know nothing about the actors, and the client and the agent don't import each other. They agree only through the contract and the spec.

Python and Solidity share no code either. Two things tie them together:

- **The ABI.** `forge build` writes it to `contracts/out/`, and `chain.py` loads it from there.
- **The encodings** in INTERFACE.md §2. `crypto.py` and `JobMarket.sol` each implement them, and both test suites check them against the same golden vectors.

## 3. The on-chain layer

### 3.1 Two contracts, split by lifetime

- **ProviderRegistry** keeps what lasts as long as a provider:
  - its stake;
  - its X25519 public key (`encPubKey`);
  - its price per item;
  - a lock counter and the reputation counters.

  Providers call it directly to register, top up and withdraw.
- **JobMarket** keeps what lasts as long as a job:
  - the escrow;
  - the phase and its deadline;
  - the commitments;
  - the drawn verifiers and tie-breaker;
  - the compared leaves and the final settlement.

  It also holds the task-type table, which maps each task type to its pinned runner hash.

Only the market may change a provider's standing. The registry's `lock`, `unlock`, `slash` and `bump` all require `msg.sender == market`. The owner sets the market address once, right after deployment.

How the two contracts interact:

| Direction | Calls | Purpose |
|---|---|---|
| Market → Registry | `isActive`, `getProvider` | check that M can take jobs; read M's price to pin the job price |
| Market → Registry | `providerCount`, `providerAt`, `isActive` | random draws of verifiers and the tie-breaker |
| Market → Registry | `lock`, `unlock` | stake can't be withdrawn while its owner is in an open job |
| Market → Registry | `slash`, `bump` | punish and record reputation, during a phase or at close |
| Registry → Market | slashed ETH | `slash` sends the amount to the market, whose `receive()` accepts ETH only from the registry |

Off-chain, the client reads the registry for prices and for the public keys it seals secrets to. Agents use it to register.

### 3.2 Money flow

```
client wallet ──── 2 × price ──────▶ JobMarket escrow (per job)
provider wallet ── stake ──────────▶ ProviderRegistry
ProviderRegistry ─ slashed stake ──▶ JobMarket (held in the job's slashedPool, or added at close)
JobMarket at close ─ payouts ──────▶ main → verifiers → tie-breaker → client (the remainder)
```

- **Payouts:** when a job closes, its escrow plus its slashes is paid out in full. So the market holds no ETH once every job is closed. The Foundry tests and the demo assert this after every job.
- **Locks:**
  - A provider's lock count goes up when it accepts a job as main, or is drawn as a verifier or tie-breaker.
  - It goes down when the provider leaves the job: at close, or early on `BadInput` or `Missed`.
  - `withdrawStake` requires zero locks, so stake that might still be slashed can't leave.

### 3.3 The job state machine is the backbone

Everything in JobMarket hangs off one `status` field per job. Each arrow below is one external function, labelled with its caller.

```
                    createJob (client)
                            │
                            ▼
                          Open ── cancel · expire ─────────────────────▶ Closed: Cancelled
                            │ accept (M)
                            ▼
                       Committing ── expire ───────────────────────────▶ Closed: MainMissed
                            │ commitResults (M)
                            ▼
                        Deciding ── expire (client never revealed) ───────────┐
                            │ revealDecision (client)                         │
                ┌───────────┴───────────┐                                     │
                │ "yes": draw V0, V1    │ "no", or too few                    │
                ▼                       │ eligible providers                  │
            Checking                    │                                     │
                │ shareRange (client)   │                                     │
                │ commitCheck (V)       │                                     │
                │ reportBadInput (V)    │                                     │
                │ expire                │                                     │
                ▼                       │                                     │
           CheckReveal                  │                                     │
                │ revealCheck (V)       │                                     │
                │ expire                │                                     │
                ├───────────────────────┴─────────────────────────────────────┘
                ▼
           Publishing ── expire ───────────────────────────────────────▶ Closed: MainMissed
                │ publishResults (M), compared with the stored checks
                ├── mismatches ≤ maxMismatch ──────────────────────────▶ Closed: Verified (Delivered if unchecked)
                ├── mismatches, no tie-breaker left ───────────────────▶ Closed: NoMajority
                ▼ otherwise draw T
            TieBreak ── expire ────────────────────────────────────────▶ Closed: TiebreakerMissed / TieClientNoShare
                │ shareTiebreak (client)
                ├── reportBadInput (T) ────────────────────────────────▶ Closed: TieClientNoShare
                │ submitTiebreak (T): per-item majority
                ▼
            Closed: MainOutvoted · VerifierOutvoted · BothOutvoted · NoMajority
```

If no verifier committed (every slot was dropped), Checking goes straight to Publishing and skips CheckReveal.

How the contract code is organised around this machine:

- **Every phase function has the same shape.** It checks the status, the caller and the deadline, does its work, then calls `_setPhase(next, window)`. That call also sets the next deadline, so each phase owns exactly one deadline.
- **`expire` is the single timeout handler.** Anyone may call it once a deadline has passed. It knows what a missed deadline means in each phase: cancel the job, slash M, drop the decision, slash a silent verifier, and so on. The MVP has no keeper, so in practice the demo or the person at the CLI calls it.
- **Two shared helpers:**
  - `_advanceChecking` leaves Checking once no verifier is still waiting. `commitCheck`, `reportBadInput` and `expire` all call it.
  - `_draw` picks a random active provider outside an exclusion list. It is used for both the verifiers and the tie-breaker.
- **`_close` is the only way into Closed, and the only place money leaves.**
  - The phase functions only *record facts*: slot states, the outvoted and unresolved bitmasks, `mainOutvoted`, `tieSubmitted` and `slashedPool`.
  - `_close` judges each party from those facts and the outcome. It works effects-first: mark the job Closed; then slash, bump and unlock; then push the payouts.
  - So every row of the README's outcome table comes out of this one function.

Per-job data, where it is written and where it is read:

| Data | Written in | Read in |
|---|---|---|
| `dataHash`, `dataURI` | `createJob` | off-chain, by every provider, to fetch and check its inputs |
| `verifyCommit` | `createJob` | `revealDecision` |
| `resultsCommit` | `commitResults` | `publishResults` |
| `verifiers`, `vstate`, `vcommit` | `revealDecision` (the draw), then every step of Checking and CheckReveal | `revealCheck`, `_advanceChecking`, `_close`; off-chain by the client and the agents |
| `checkLeaf[job][i]` | `revealCheck` | `publishResults`, `submitTiebreak` |
| `mismatched`, `mainMismatchLeaves` | `publishResults` | `submitTiebreak`; off-chain by the client (what to share) and T (what to run) |
| `outvotedMask`, `unresolvedMask`, `mainOutvoted` | `submitTiebreak`, `expire`, and `publishResults` when no T can be drawn | `_close` |

### 3.4 The order in which parties are bound

The protocol works because commitments land in a fixed order:

1. **`createJob`:** the client is bound to its inputs (`dataHash`) and its secret decision (`verifyCommit`).
2. **`commitResults`:** M is bound to all N leaves, before anyone knows whether the job will be checked.
3. **`revealDecision`:** only now does the decision become public; the verifiers are drawn and their ranges become known.
4. **`commitCheck`, then `revealCheck`:** every verifier's leaves are fixed before any is revealed, and they are then stored on-chain.
5. **`publishResults`:** M's leaves become public last. The contract checks them against step 2 and compares them with the checks stored in step 4.
6. **`submitTiebreak`:** T answers for the mismatched items only, in one step without a commit.

Two consequences of this order are worth knowing when reading the code. Both are within the course-level scope and are not handled by the code.

- **A caught M can skip publishing.** After step 4, M can tell whether the revealed checks match its own results before it publishes. If it is caught, it can let the deadline pass and take the missed-deadline slash (10%) instead of the wrong-result slash (30%). The client then gets no labels.
- **Nothing forces T to run the items.** At step 6 both sides' leaves are already public, so T could simply copy one side.

## 4. The off-chain actors

### 4.1 Both actors are polling state machines

`Client` and `ProviderAgent` are built the same way:

- **Local state:** a `jobs` dict that maps each job id to a JSON-able record. The record holds the secrets (`k_job`, salts, the decision) and progress flags such as `accepted`, `committed` and `published`.
- **`step()`:**
  - for each open job, read `getJob` and compare the on-chain status with the local flags;
  - do the next action;
  - report whether anything happened.

  There are no threads, callbacks or subscriptions.
- **Idempotent:** the local flags, plus the contract's own status checks, make it safe to call `step()` again or to restart.
- **Restartable:**
  - Given a state path, each actor saves its records to `.degpu-state/` after every change.
  - The file is tagged with `Chain.tag()` (genesis hash plus market address), so state from an older anvil run is discarded.
  - An agent keeps its keypair either way.

Who calls `step()` decides how the system runs:

- **The CLI daemons** loop `step(); sleep(poll)`.
- **The demo and `tests/test_e2e.py`** call `drive()`. It steps the client, then each agent, round after round, until the job closes or two rounds pass with no progress. That makes the demo deterministic apart from the random draws.

### 4.2 How an agent finds its work

The client knows its job ids because it created them. An agent doesn't, so each `step()` starts with `_scan_events`, which reads the market's events since the last block it processed:

| Event | Meaning for this agent |
|---|---|
| `JobCreated` with `main == me` | a new job as main; keep `sealedForMain` |
| `VerifiersDrawn` listing me | a new job as a verifier; remember my slot |
| `RangeShared` to me | my verifier secrets have arrived |
| `TiebreakStarted` naming me | a new job as the tie-breaker; remember the mismatched items |
| `TiebreakShared` to me | my tie-breaker secrets have arrived |

After the scan, the agent dispatches each open job by role, to `_act_main`, `_act_verifier` or `_act_tiebreaker`.

Events only answer "am I involved, and what is my secret?" The question "what phase is it?" is always answered by `getJob`, so the agent never depends on the order in which it sees events.

### 4.3 Who acts in which phase

| Phase | Client | Main M | Verifier | Tie-breaker T |
|---|---|---|---|---|
| Open | — | unseal `k_job`, check runner and inputs, `accept` | | |
| Committing | — | run all items, `commitResults` | | |
| Deciding | `revealDecision` | wait | | |
| Checking | `shareRange` for each slot still Assigned | wait | unseal, check its range and inputs, run its range, `commitCheck` (or `reportBadInput`) | |
| CheckReveal | — | wait | `revealCheck` | |
| Publishing | — | `publishResults` | | |
| TieBreak | `shareTiebreak` | — | — | unseal, check inputs, run the mismatched items, `submitTiebreak` (or `reportBadInput`) |
| Closed | record the outcome; `results()` decodes the labels | | | |

`expire` is missing from the table because no actor calls it on its own (see 3.3).

### 4.4 Demo behaviours

The `behavior` flag changes only the agent, never the contract. It hooks in at three places:

- **`cheat`:** in M's compute step, after the runner, a fraction of the labels are replaced with wrong ones.
- **`liar`:** in the verifier step, random labels replace the runner's output.
- **`offline`:** M accepts and then stops. An offline agent never acts as a verifier or tie-breaker either.

The demo switches behaviours between scenarios by setting `agent.behavior`.

## 5. The data path: keys, store and input checks

Every secret is derived from one random 32-byte `k_job`, which the client draws in `post()`:

```
k_job ─┬─ HKDF "degpu/model"    → model_key   → encrypt the model  → Store → manifest.model.uri
       ├─ HKDF "degpu/item/<i>" → item_key(i) → encrypt image i    → Store → manifest.items[i].uri
       └─ HKDF "degpu/job-salt" → job_salt    → mixed into every result leaf

manifest = {task, model: {uri, hash}, items: [{uri, hash}, ...]}   plaintext; hashes are of the plaintexts
manifest → Store → dataURI                                          on-chain
dataHash = keccak(abi.encode(modelHash, itemHashes))                on-chain
```

Each recipient gets a payload sealed to its `encPubKey`. The client reads that key from the registry at the moment it shares, and the payload travels inside an event:

| Recipient | Payload | Carried by | Can decrypt |
|---|---|---|---|
| M | `k_job` | `JobCreated.sealedForMain` | the model and every item |
| Verifier slot j | `job_salt`, `model_key`, the keys for its range, `start` and `end` | `RangeShared` | the model and its range |
| T | `job_salt`, `model_key`, the keys and indices of the mismatched items | `TiebreakShared` | the model and the mismatched items |

All three provider roles run the same input check (`_load_inputs`) before computing:

1. The task type's on-chain `runnerHash` equals the hash of the local `runner.py`.
2. The manifest from the store hashes to the on-chain `dataHash`.
3. The decrypted model, and each item the role needs, match their manifest hashes.

If any check fails, M refuses the job (it never accepts it), and a verifier or T calls `reportBadInput`. The on-chain `dataHash` is what lets parties who never talk to each other agree on exactly the same inputs.

## 6. The results path: labels → leaves → comparison → labels

```
runner.classify(images)            → labels (0..999)
crypto.leaf(job_salt, i, label)    → leaf_i (bytes32)

M:  results_commit(all leaves)          → commitResults  ...  publishResults(all leaves)
V:  check_commit(v_salt, range leaves)  → commitCheck    ...  revealCheck(range leaves)
T:                                        submitTiebreak(leaves of the mismatched items)

JobMarket compares bytes32 values only; it never sees a label or the salt.
client: decode_labels(job_salt, published leaves) tries all 1000 labels per item.
```

The leaf is the one result format every component shares. Three properties make it work:

- **Honest providers produce identical leaves.** The runner is deterministic (pinned preprocessing, one CPU thread, one image per batch), and its exact file is pinned on-chain.
- **Outsiders learn nothing from leaves.** Without `job_salt`, they can't try the 1000 labels.
- **Leaves can't be moved between items,** because the item index is inside the hash.

## 7. One verified job across the components

| # | Actor (code) | Action | Emits | Picked up by |
|---|---|---|---|---|
| 1 | client `post()` | encrypt and upload to the store; `createJob` with 2 × price | `JobCreated` | M's event scan |
| 2 | M `_act_main` (Open) | check inputs, `accept` | `JobAccepted` | (M continues in the same step) |
| 3 | M `_act_main` (Committing) | run all items, `commitResults` | `ResultsCommitted` | the client sees Deciding |
| 4 | client `step()` | `revealDecision(salt, true)`; the market draws 2 verifiers | `DecisionRevealed`, `VerifiersDrawn` | the verifiers' event scans; the client sees Checking |
| 5 | client `step()` | `shareRange`, once per slot | `RangeShared` × 2 | each verifier's event scan |
| 6 | each verifier | run its half, `commitCheck` | `CheckCommitted` | the last commit moves the job to CheckReveal |
| 7 | each verifier | `revealCheck` | `CheckRevealed` | the last reveal moves the job to Publishing; M sees it |
| 8 | M | `publishResults` | `ResultsPublished`, then either `Payout` … `JobClosed` (all match) or `TiebreakStarted` | the client, or T's event scan |
| 9 | client `step()` | `shareTiebreak` | `TiebreakShared` | T's event scan |
| 10 | T | run the mismatched items, `submitTiebreak`; the market settles | `TiebreakSubmitted`, `ProviderSlashed`, `Payout`, `JobClosed` | the client records the outcome |
| 11 | client `results()` | read `ResultsPublished` and decode | — | — |

An unverified job reveals `false` at step 4, goes straight to step 8 and closes as Delivered.

## 8. Ways to run it

| Mode | Used by | How the pieces share a chain and data |
|---|---|---|
| One process | `scripts/demo.py`, `tests/test_e2e.py`, `video/capture.py` | `start_local_chain()` starts anvil and deploys. There is one `Chain`, one `Store` (a temp directory), one `Client` and six `ProviderAgent`s, all stepped by `drive()`. Time travel goes through `Chain.increase_time`. `Chain.gas_spent` tallies gas per account, so balances can be checked net of gas. |
| Several processes | `python -m degpu.chain`, `python -m degpu.agent`, `python -m degpu.client` | Each process builds its own `Chain` and attaches to the market address, which is the same on every fresh anvil. They share the RPC URL, the `DEGPU_STORE` directory and `.degpu-state/`. |

- **No private keys.** Transactions are sent from anvil's unlocked accounts (`transact({"from": ...})`), so no code handles keys. This is the main thing to change for a public testnet.
- **Two deploy paths.** Both do the same four steps: deploy the registry; deploy the market with the params; call `setMarket`; call `addTaskType` with the runner hash.
  - `Chain.deploy` in Python, which everything above uses.
  - `contracts/script/Deploy.s.sol`, a forge script checked by `Deploy.t.sol`.

## 9. Tests by layer

| Layer | Tests | Approach |
|---|---|---|
| Contracts | `contracts/test/*.t.sol` | `DeGPUBase` deploys with the demo params and six providers. Tests feed synthetic leaves (no ML) and set `vm.prevrandao` to steer the draws. They are split by concern: Settlement (one test per outcome), Reverts, Draw, Encoding, Gas and Deploy. Most settlement tests end with a shared check (`_assertClosed`): value is conserved, the market holds no ETH, and nobody stays locked. |
| Python libraries | `tests/test_crypto.py`, `test_storage.py`, `test_runner.py`, `test_decode.py` | Golden vectors (the same ones `Encoding.t.sol` uses), runner determinism and batch independence, and decode round trips. |
| Integration | `tests/test_e2e.py` | A real anvil and the real runner on 20 images, with the client and the agents stepped together. |
| Acceptance | `scripts/demo.py` | Five scenarios with exact balance assertions; it exits with code 1 on any failure. |

## 10. Things that must stay in sync

| What | Lives in | Kept honest by |
|---|---|---|
| Hash and commitment encodings | `crypto.py` and `JobMarket.sol` | golden vectors in INTERFACE.md §2, `Encoding.t.sol` and `test_crypto.py` |
| Enums (`Status`, `Outcome`, `Drop`, `VState`, `Stat`) | the contracts, and the `IntEnum`s in `chain.py`, matched by position | the e2e tests and the demo |
| `Params` field order | `JobMarket.Params`, and the `DEMO_PARAMS` tuple in `chain.py` | the e2e tests and the demo |
| Demo parameter values and the min stake | three copies: `chain.py`, `Deploy.s.sol`, `DeGPUBase.t.sol` | nothing automatic: change all three together |
| Sealed payload fields | written by `client.py`, read by `agent.py` | INTERFACE.md §3 and the e2e tests |
| The bytes of `runner.py` | its keccak, registered at deploy | any edit, even whitespace, makes agents refuse jobs on a chain deployed with the old hash; redeploy |
| ABI | `contracts/out/`, written by `forge build` | `chain.py` builds only when `out/` is missing, so run `forge build` after editing a contract |

## 11. Where to extend

- **A second task type.**
  - The contract side is already generic: `addTaskType(runnerHash, name)`.
  - The Python side isn't. `agent.py` imports the image-classify runner and checks the manifest's task name, and `client.py` imports its decoder.
  - A second type needs a small table that maps each task-type id to a runner and a decoder, plus a definition of what its leaf means.
- **More verifiers.**
  - `numVerifiers` is a constructor parameter. Ranges, fees and the per-slot bitmasks are all computed from it.
  - The Python side reads `rangeOf` and `vstate` without assuming two.
  - Each extra verifier needs one more active provider.
- **IPFS instead of the local store.** Anything with the same `put(bytes) → uri` and `get(uri) → bytes` interface works. URIs are opaque strings to the rest of the code.
- **A real network.**
  - Sign transactions in `Chain.send` instead of using unlocked accounts.
  - Replace the randomness in `_draw` with VRF.
  - Run a keeper that calls `expire`.
- **Large batches.** Posting every leaf and storing every check leaf are the gas bottleneck. A Merkle root with per-item proofs would replace the leaf arrays in `commitResults`, `publishResults` and `revealCheck`.

## 12. The `video/` folder

`video/` consumes the core, and nothing depends on it.

1. `capture.py` imports `scripts/demo.py`, runs the five scenarios and saves their output to `capture/`.
2. `build_data.py` turns that output into `data.js`.
3. The HTML engine renders the video from `data.js`.

If the demo's printed output or its list of scenarios changes, re-run the capture and check `build_data.py`.
