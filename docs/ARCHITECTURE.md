# DeGPU code architecture

This document explains how the code fits together: which parts exist, what each part owns, and how they cooperate to run a job. It stays at the level of components and data flow.

- For the exact rules and byte encodings, see [INTERFACE.md](INTERFACE.md).
- For adding a job type, see [ADDING_A_JOB_TYPE.md](ADDING_A_JOB_TYPE.md).
- For setup, outcomes and the demo, see the [README](../README.md).
- For what a single function does, read the code.

## 1. The big picture

DeGPU separates **what** a provider computes from **how** the platform knows the answer is right:

- **A job type (task)** is a plugin folder under `degpu/tasks/`, for example `image-classify-v1`, `blender-render-v1` or `key-search-v1`.
- **A verification mode** is one market contract plus an off-chain driver:
  - **replicated** (`ReplicatedMarket`): random verifiers re-run the work. The task picks how results are compared:
    - **exact:** the contract compares result hashes (`image-classify-v1`);
    - **similar:** the client compares result files with the task's pinned metric and disputes the ones that differ, then a tie-breaker judges (`blender-render-v1`).
  - **checked** (`CheckedMarket`): a checker contract verifies each answer on-chain.

The code has five layers:

| Layer | Code | Owns |
|---|---|---|
| On-chain | `contracts/src/`: `ProviderRegistry`, `MarketBase` with `ReplicatedMarket` and `CheckedMarket`, `IChecker` and `checkers/` | money, stakes, offers, each mode's job state machine, every judgement |
| Actor shells | `degpu/client.py`, `degpu/agent.py` | one account each: wallet, keys, store, saved state, the tasks an agent offers |
| Mode drivers | `degpu/modes/` | the off-chain half of each market: who does what in which phase |
| Tasks | `degpu/tasks/` | what runs: inputs, compute, result format, decoding |
| Shared libraries and drivers | `degpu/crypto.py`, `degpu/storage.py`, `degpu/chain.py`; `scripts/demo.py`, `tests/`, the CLIs | encodings, encryption, files, talking to the chain; starting a chain and stepping actors |

```
 ┌──────────────────────────────── on-chain (anvil) ────────────────────────────────┐
 │  ProviderRegistry ◀── lock · slash · bump ── MarketBase                          │
 │  stake, key, locks,  ── slashed ETH ──────▶   ├─ ReplicatedMarket  (re-run)      │
 │  price per (market,                           └─ CheckedMarket ──▶ IChecker      │
 │  task), stats per market                         (check on-chain)   KeySearch    │
 └───────────────▲───────────────────────────────────────────────▲──────────────────┘
                 │   transactions · getJob reads · event logs    │
       ┌─────────┴──────────┐                       ┌────────────┴────────────┐
       │ Client             │                       │ ProviderAgent  (× 6)    │
       │ degpu/client.py    │                       │ degpu/agent.py          │
       └─────────┬──────────┘                       └────────────┬────────────┘
                 │ one ClientDriver per mode                     │ one ProviderDriver per mode
       ┌─────────┴───────────────────────────────────────────────┴────────────┐
       │ degpu/modes/   replicated.py · checked.py   (base.py: the driver API) │
       └─────────┬───────────────────────────────────────────────┬────────────┘
                 │ task hooks: prepare, run / solve, present...  │
       ┌─────────┴───────────────────────────────────────────────┴────────────┐
       │ degpu/tasks/   image_classify_v1/ · key_search_v1/   (base.py)        │
       └──────────────────────────────────────────────────────────────────────┘
          shared: crypto.py · chain.py · storage.py (encrypted blobs; replicated mode only)
```

The key design rule is that **the actors never talk to each other directly**. Everything goes through three shared channels:

1. **Contract state** (`getJob`) is the single source of truth for where a job is. Every actor picks its next move by reading it.
2. **Contract events** are the mailbox. They tell a provider it has been picked for a job, and carry the sealed secrets addressed to it (replicated mode) or the public items (checked mode).
3. **The store** holds a replicated job's bulk data: its encrypted shared blob and items, plus a plaintext manifest. Only the manifest's URI and a hash go on-chain.

That is why the same client and agents run unchanged inside one Python process (the demo) or as seven separate processes (the CLI).

## 2. Module dependencies

| Module | Uses (inside DeGPU) | Used by |
|---|---|---|
| `crypto.py` | nothing | everything that hashes, encrypts or seals |
| `storage.py` | nothing | client, agent, drivers |
| `tasks/base.py`, `tasks/__init__.py` | crypto (for the runner hash) | every task; the mode drivers; agent, client, chain (deploy); tests |
| `tasks/<task>/` | `tasks/base.py` (plus the task's own libraries) | only through the task registry |
| `chain.py` | the ABI files in `contracts/out/`; the task registry (to deploy) | modes, client, agent, drivers |
| `modes/base.py`, `modes/<mode>.py` | crypto, chain, `tasks/base.py` (replicated mode: also storage) | agent, client |
| `client.py`, `agent.py` | chain, modes, storage, tasks | drivers |

The dependencies point one way:
- **Tasks** know nothing about chains, modes or actors. They only implement hooks.
- **Modes** know the task interface, but no particular task.
- **The agent and the client** know the modes only through the `PROVIDER_DRIVERS` and `CLIENT_DRIVERS` tables, and never import each other.

Python and Solidity share no code. Three things tie them together:
- **The ABI.** `forge build` writes it to `contracts/out/`, and `chain.py` loads it from there.
- **The encodings** in INTERFACE.md §2. Both sides implement them, and both test suites check the same golden vectors.
- **Each checked task's checker.** The conformance tests check that the task's Python `check` agrees with its deployed contract.

## 3. The on-chain layer

### 3.1 One registry, one market per mode

- **ProviderRegistry** keeps what lasts as long as a provider:
  - its stake;
  - its X25519 public key (`encPubKey`);
  - a lock counter shared across markets;
  - **its offers:** a price per (market, task type), where 0 means "not offered";
  - **reputation counters**, kept per market. Each market defines its own counter ids.

  The owner adds markets with `addMarket`. Only added markets may lock, unlock, slash or bump.
- **MarketBase** (abstract) holds what every market shares:
  - the registry link and the owner;
  - `mode()`, which off-chain code uses to pick a driver;
  - a task table `{name, secondsPerItem}`;
  - price pinning from the registry (`_pinPrice`), which reverts if the main provider doesn't offer the task;
  - `_slash` and `_pay`, with the `Payout` and `ProviderSlashed` events;
  - `receive()`, which accepts ETH only from the registry.
- **Each concrete market** adds its own per-task data and its own job state machine:
  - **ReplicatedMarket:** a runner hash and a `Compare` kind per task, the hidden verify decision, verifier and tie-breaker draws, the comparison (on-chain for exact tasks, by the client's dispute for similar ones), and settlement.
  - **CheckedMarket:** a checker contract per task, plus a short Open → Working → Closed flow.

How the contracts interact:

| Direction | Calls | Purpose |
|---|---|---|
| Market → Registry | `isActive`, `priceOf` | check that M can take jobs and offers the task; pin the job price |
| ReplicatedMarket → Registry | `providerCount`, `providerAt`, `isActive`, `priceOf` | random draws among the providers that offer the job's task |
| Market → Registry | `lock`, `unlock` | stake can't be withdrawn while its owner is in an open job, in any market |
| Market → Registry | `slash`, `bump` | punish, and record reputation under this market |
| Registry → Market | slashed ETH | `slash` sends the amount to the calling market |
| CheckedMarket → checker | `check(item, answer)` | one call per solved item inside `submitResults`; any `false` reverts the submission |

Off-chain, everything starts from the registry address:
- the client reads prices and public keys;
- agents register and set their offers;
- `Chain` finds every market through `marketCount` / `marketAt` and its `mode()`.

### 3.2 Money flow

```
client wallet ──── deposit ─────────▶ market escrow (per job): replicated 2 × price, checked N × price
provider wallet ── stake ───────────▶ ProviderRegistry (one stake, shared by all markets)
ProviderRegistry ─ slashed stake ───▶ the market that slashed
market at close ── payouts ─────────▶ replicated: main → verifiers → tie-breaker → client (remainder)
                                      checked:    main (per solved item) → client (remainder)
```

- **Payouts:** when a job closes, its escrow plus its slashes is paid out in full. So each market holds no ETH once its jobs are closed, and the tests and the demo assert this after every job.
- **Locks:** a provider is locked while it takes part in a job, and `withdrawStake` requires zero locks.

### 3.3 The two state machines

**ReplicatedMarket:**

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

If no verifier committed (every slot was dropped), Checking goes straight to Publishing. The compute, check and tie-break deadlines each add the task's `secondsPerItem` × the number of items that phase must run.

**ReplicatedMarket, similar tasks.** Everything up to Publishing is the same. Only the comparison is replaced:

```
           Publishing ── expire ───────────────────────────────────────▶ Closed: MainMissed
                │ publishResults (M): leaves + the URI of its result files
                ▼
           Disputing ── acceptResults (client) · expire ───────────────▶ Closed: Verified (Delivered if unchecked)
                │ dispute (client, with a bond): the items whose files differ or are missing
                ▼ draw T  (none left → Closed: NoMajority)
            TieBreak ── expire ────────────────────────────────────────▶ Closed: TiebreakerMissed / TieClientNoShare
                │ shareTiebreak (client), then submitJudgement (T): one verdict per item
                ▼
            Closed: MainOutvoted · VerifierOutvoted · BothOutvoted · NoMajority · DisputeRejected
```

Both comparisons meet in the same two internal functions:
- **`_startTiebreak`** draws T for the `mismatched` items. For exact tasks those items come from the contract's own comparison; for similar tasks, from the client's `dispute`.
- **`_verdict(i, mainOk, verifierOk)`** applies the majority rule. `submitTiebreak` (exact) derives the two flags from leaf equality, and `submitJudgement` (similar) takes them from T.

The settlement in `_close` is shared and unchanged; the dispute bond is simply part of the pool.

**CheckedMarket:**

```
  createJob (client, items on-chain) ─▶ Open ── cancel · expire ──▶ Closed: Cancelled
                                          │ accept (M)
                                          ▼
                                       Working ── expire ─────────▶ Closed: MainMissed (M slashed)
                                          │ submitResults (M): checker.check on every found answer;
                                          │ one wrong answer reverts the whole call
                                          ▼
                                       Closed: Delivered (M paid per solved item)
```

How the contract code is organised in both markets:

- **Every phase function has the same shape.** It checks the status, the caller and the deadline, does its work, then calls `_setPhase(next, window)`, which also sets the next deadline.
- **`expire` is the single timeout handler.** Anyone may call it once a deadline has passed. The MVP has no keeper, so in practice the demo or the person at the CLI calls it.
- **`_close` is the only way into Closed, and the only place money leaves.** The phase functions only *record facts*. In ReplicatedMarket those are slot states, bitmasks and `slashedPool`; in CheckedMarket, `solved`. `_close` then judges each party from those facts, effects first, payouts last.

Per-job data of the replicated market, where it is written and where it is read:

| Data | Written in | Read in |
|---|---|---|
| `dataHash`, `dataURI` | `createJob` | off-chain, by every provider, to fetch and check its inputs |
| `verifyCommit` | `createJob` | `revealDecision` |
| `resultsCommit` | `commitResults` | `publishResults` |
| `verifiers`, `vstate`, `vcommit` | `revealDecision` (the draw), then every step of Checking and CheckReveal | `revealCheck`, `_advanceChecking`, `_close`; off-chain by the client and the agents |
| `checkLeaf[job][i]` | `revealCheck` | `publishResults`, `submitTiebreak` |
| `mismatched` | `publishResults` (exact) or `dispute` (similar) | `submitTiebreak` / `submitJudgement`; off-chain by the client (what to share) and T (what to run) |
| `mainMismatchLeaves` | `publishResults` (exact) | `submitTiebreak` |
| `disputeBond` | `dispute` | `_close` (part of the pool) |
| `outvotedMask`, `unresolvedMask`, `mainOutvoted` | `_verdict` (from either submission), `expire`, and `_startTiebreak` when no T can be drawn | `_close` |

### 3.4 The order in which parties are bound (replicated mode)

The protocol works because commitments land in a fixed order:

1. **`createJob`:** the client is bound to its inputs (`dataHash`) and its secret decision (`verifyCommit`).
2. **`commitResults`:** M is bound to all N leaves, before anyone knows whether the job will be checked.
3. **`revealDecision`:** only now does the decision become public; the verifiers are drawn and their ranges become known.
4. **`commitCheck`, then `revealCheck`:** every verifier's leaves are fixed before any is revealed, and they are then stored on-chain.
5. **`publishResults`:** M's leaves become public last. The contract checks them against step 2 and compares them with the checks stored in step 4.
6. **`submitTiebreak`:** T answers for the mismatched items only, in one step without a commit.

Two consequences of this order are worth knowing. Both are within the course-level scope and are not handled by the code.

- **A caught M can skip publishing.** After step 4, M can tell whether the revealed checks match its own results before it publishes. If it is caught, it can let the deadline pass and take the missed-deadline slash (10%) instead of the wrong-result slash (30%). The client then gets no labels.
- **Nothing forces T to run the items.** At step 6 both sides' leaves are already public, so T could simply copy one side.

The checked mode needs no ordering at all: an answer is either accepted by the checker or rejected, whoever sees it first.

## 4. The off-chain actors

### 4.1 Thin shells, one driver per mode

`Client` and `ProviderAgent` are shells around one account:
- the client: its wallet, the store, display names and its saved job secrets;
- the agent: the same, plus its X25519 keypair, its demo behaviour and its offered tasks.

Each shell builds one driver per mode found on the chain (`degpu/modes/`) and delegates to it:

| | `ClientDriver` | `ProviderDriver` |
|---|---|---|
| holds | the client's jobs of that mode (`client.jobs[mode]`) | the agent's jobs of that mode (`agent.jobs[mode]`) |
| `step()` | for each open job: read `getJob`, record the outcome when closed, else `act` | `_scan` the market's new events, then for each open job read `getJob` and `act` (up to 5 actions in a row) |
| mode-specific | `post`, `act`, `results`, `add_cli_args` | `on_event`, `act` |

Shared properties:
- **Polling, no callbacks.** `step()` compares the on-chain status with local progress flags and does the next action. There are no threads or subscriptions.
- **Idempotent.** Local flags, plus the contract's own status checks, make it safe to call `step()` again or to restart.
- **Restartable.**
  - Given a state path, each shell saves its jobs to `.degpu-state/`, keyed by mode and then job id.
  - The file is tagged with `Chain.tag()` (genesis hash plus registry address), so state from an older anvil run is discarded.
  - Job ids are numbered per market, so a job is named by a `JobRef` such as `checked:1`.

Who calls `step()` decides how the system runs:
- **The CLI daemons** loop `step(); sleep(poll)`.
- **The demo and `tests/test_e2e.py`** call `drive()`. It steps the client, then each agent, round after round, until the job closes or two rounds pass with no progress.

### 4.2 How an agent finds its work

The client knows its job ids because it created them. Each provider driver instead scans its market's events since the last block it processed:

| Mode | Event | Meaning for this agent |
|---|---|---|
| replicated | `JobCreated` with `main == me` | a new job as main; keep `sealedForMain` |
| replicated | `VerifiersDrawn` listing me | a new job as a verifier; remember my slot |
| replicated | `RangeShared` to me | my verifier secrets have arrived |
| replicated | `TiebreakStarted` naming me | a new job as the tie-breaker |
| replicated | `TiebreakShared` to me | my tie-breaker secrets have arrived |
| checked | `JobCreated` with `main == me` | a new job; keep its (public) items |

Events only answer "am I involved, and what do I need?" The question "what phase is it?" always comes from `getJob`.

`agent.task_for(mode, taskType)` maps an on-chain task type to a local task, by its on-chain name. It returns nothing if the agent doesn't offer that task. In the replicated mode the driver also requires the on-chain `runnerHash` to match the local task folder.

### 4.3 Who acts in which phase

**Replicated mode:**

| Phase | Client | Main M | Verifier | Tie-breaker T |
|---|---|---|---|---|
| Open | — | unseal `k_job`, check runner and inputs, `accept` | | |
| Committing | — | `task.run` on all items, `commitResults` | | |
| Deciding | `revealDecision` | wait | | |
| Checking | `shareRange` for each slot still Assigned | wait | unseal, check its range and inputs, `task.run` on its range, `commitCheck` (or `reportBadInput`) | |
| CheckReveal | — | wait | `revealCheck` | |
| Publishing | — | `publishResults` (similar: plus its results URI) | | |
| Disputing (similar only) | load M's and each verifier's files, compare them with `task.similar`; `dispute` the differing or missing items (with a bond), else `acceptResults` | — | — | |
| TieBreak | `shareTiebreak` (similar: plus both sides' result keys) | — | — | unseal, check inputs, `task.run` on the mismatched items; exact: `submitTiebreak`; similar: compare with both sides' files and `submitJudgement` |
| Closed | record the outcome; `results()` decodes leaves with `task.candidates()` (exact) or returns M's verified files (similar) | | | |

For a similar task, M and each verifier also upload their outputs, encrypted, when they compute them.

**Checked mode:**

| Phase | Client | Main M |
|---|---|---|
| Open | — | check that it offers the task and that the items match `itemsHash`, `accept` |
| Working | — | `task.solve` each item (None = not found), `submitResults` |
| Closed | record the outcome; `results()` reads `ResultsSubmitted` and calls `task.present` | |

Neither table has `expire`, because no actor calls it on its own.

### 4.4 Demo behaviours

The `behavior` flag changes only the agent, never the contract:

| Behaviour | Replicated mode | Checked mode |
|---|---|---|
| `cheat` | M replaces 20% of its outputs with `task.wrong_output` (similar tasks: a degraded file) | M submits `task.wrong_answer` for every item; the checker reverts it |
| `liar` | a verifier submits `task.random_output` (similar tasks: garbage files) | — |
| `offline` | M accepts, then stops; never acts as verifier or T | M accepts, then stops |

## 5. The data path (replicated mode): keys, store and input checks

Every secret is derived from one random 32-byte `k_job`, which the client draws in `post()`:

```
k_job ─┬─ HKDF "degpu/model"    → shared_key  → encrypt the shared blob → Store → manifest.shared.uri
       ├─ HKDF "degpu/item/<i>" → item_key(i) → encrypt item i          → Store → manifest.items[i].uri
       └─ HKDF "degpu/job-salt" → job_salt    → mixed into every result leaf

manifest = {task, shared: {uri, hash} | null, items: [{uri, hash}, ...]}   plaintext; hashes are of the plaintexts
manifest → Store → dataURI                                                 on-chain
dataHash = keccak(abi.encode(sharedHash, itemHashes))                      on-chain
```

`pack_inputs` (client) and `load_inputs` (providers) in `degpu/modes/replicated.py` are the only code that knows this layout.

Each recipient gets a payload sealed to its `encPubKey`, read from the registry when the client shares:

| Recipient | Payload | Carried by | Can decrypt |
|---|---|---|---|
| M | `k_job` | `JobCreated.sealedForMain` | the shared blob and every item |
| Verifier slot j | `job_salt`, `shared_key`, the keys for its range, `start` and `end` | `RangeShared` | the shared blob and its range |
| T | `job_salt`, `shared_key`, the keys and indices of the mismatched items | `TiebreakShared` | the shared blob and the mismatched items |

All three roles run the same input check before computing:

1. The task type's on-chain `runnerHash` equals the hash of the local task folder.
2. The manifest from the store hashes to the on-chain `dataHash`.
3. The decrypted shared blob, and each item the role needs, match their manifest hashes.

If any check fails, M refuses the job, and a verifier or T calls `reportBadInput`.

**Similar tasks** also move results through the store:

| File | Encrypted with | Announced by | Read by |
|---|---|---|---|
| M's output for item i | `result_key(i)` (M derives it from `k_job`) | `publishResults(.., resultsURI)` | the client (review, results) and T (the disputed items) |
| verifier slot j's output for item i | `check_result_key(j, i)` (sent in its range payload) | `revealCheck(.., resultsURI)` | the client (review) and T |

`pack_results` and `load_results` in `degpu/modes/replicated.py` are the only code that knows this layout. A file counts only if its hash matches the leaf already committed on-chain, so nobody can swap a file after committing.

The checked mode has no data path: its items are public and travel in the `JobCreated` event.

## 6. The results path

**Replicated mode:** words → leaves → comparison → words.

```
task.run(state, items)            → one 32-byte word per item (image task: the label)
crypto.leaf(job_salt, i, word)    → leaf_i

M:  results_commit(all leaves)          → commitResults  ...  publishResults(all leaves)
V:  check_commit(v_salt, range leaves)  → commitCheck    ...  revealCheck(range leaves)
T:                                        submitTiebreak(leaves of the mismatched items)

ReplicatedMarket compares bytes32 values only; it never sees a word or the salt.
client: crypto.decode_leaves(job_salt, leaves, task.candidates()) → task.present(word)
```

Three properties make this work:
- **Honest providers produce identical leaves.** The task's `run` must be deterministic, and its folder is pinned on-chain.
- **Outsiders learn nothing from leaves:** without `job_salt` they can't try the candidates.
- **Leaves can't be moved between items,** because the item index is inside the hash.

**Replicated mode, similar tasks:** files → hashes in leaves → the client's comparison → files.

```
task.run(state, items)            → one output file per item (render task: a PNG frame)
crypto.leaf(job_salt, i, keccak(file)) → leaf_i; the file itself goes to the store, encrypted

M and V commit and reveal their leaves exactly as above; nobody compares leaves on-chain.
client: load both sides' files (each checked against its leaf), task.similar(m, v) per item
        → dispute the differing items, or acceptResults
T:      task.run on the disputed items, task.similar(ours, m) and task.similar(ours, v)
        → submitJudgement(verdicts)
client: results() → M's files, each checked against its leaf → task.present(file)
```

**Checked mode:** answers → checker → answers.

```
task.solve(item) → 32-byte answer or None
submitResults(items, answers, found) → checker.check(item, answer) for each found item, on-chain
client: ResultsSubmitted(answers, found) → task.present(item, answer)
```

## 7. One job across the components

**A verified replicated job:**

| # | Actor (code) | Action | Emits | Picked up by |
|---|---|---|---|---|
| 1 | client `post()` → `ReplicatedClient.post` | `task.prepare` / inputs; `pack_inputs`; `createJob` with 2 × price | `JobCreated` | M's event scan |
| 2 | M `ReplicatedProvider` (Open) | `load_inputs`, `accept` | `JobAccepted` | (M continues in the same step) |
| 3 | M (Committing) | `task.run` on all items, `commitResults` | `ResultsCommitted` | the client sees Deciding |
| 4 | client | `revealDecision(salt, true)`; the market draws 2 verifiers that offer the task | `DecisionRevealed`, `VerifiersDrawn` | the verifiers' scans |
| 5 | client | `shareRange`, once per slot | `RangeShared` × 2 | each verifier's scan |
| 6 | each verifier | `task.run` on its half, `commitCheck` | `CheckCommitted` | the last commit moves the job to CheckReveal |
| 7 | each verifier | `revealCheck` | `CheckRevealed` | the last reveal moves the job to Publishing |
| 8 | M | `publishResults` | `ResultsPublished`, then `Payout` … `JobClosed`, or `TiebreakStarted` | the client, or T's scan |
| 9 | client | `shareTiebreak` | `TiebreakShared` | T's scan |
| 10 | T | `task.run` on the mismatched items, `submitTiebreak`; the market settles | `TiebreakSubmitted`, `ProviderSlashed`, `Payout`, `JobClosed` | the client records the outcome |
| 11 | client `results()` | decode the leaves | — | — |

**A checked (key-search) job:**

| # | Actor (code) | Action | Emits | Picked up by |
|---|---|---|---|---|
| 1 | client `post()` → `CheckedClient.post` | `task.prepare` → items; `createJob` with N × price | `JobCreated` (with the items) | M's event scan |
| 2 | M `CheckedProvider` (Open) | check the offer and `itemsHash`, `accept` | `JobAccepted` | (M continues in the same step) |
| 3 | M (Working) | `task.solve` each item, `submitResults`; the market calls the checker and settles | `ResultsSubmitted`, `Payout` × 2, `JobClosed` | the client records the outcome |
| 4 | client `results()` | read `ResultsSubmitted` | — | — |

## 8. Ways to run it

| Mode | Used by | How the pieces share a chain and data |
|---|---|---|
| One process | `scripts/demo.py`, `tests/test_e2e.py` | `start_local_chain()` starts anvil and `Chain.deploy()` deploys the registry, both markets and every installed task. There is one `Chain`, one `Store`, one `Client` and six `ProviderAgent`s, all stepped by `drive()`. Time travel goes through `Chain.increase_time`, and `Chain.gas_spent` lets balances be checked net of gas. |
| Several processes | `python -m degpu.chain`, `python -m degpu.agent`, `python -m degpu.client` | Each process builds its own `Chain` from the registry address, which is the same on every fresh anvil, and finds the markets from it. They share the RPC URL, the `DEGPU_STORE` directory and `.degpu-state/`. |
| A network (the product) | `degpu host`, `degpu app`, the `degpu` CLI; `tests/test_app.py` | See below. Every user signs with their own wallet, files go through the host, and time runs for real. |

- **Demo keys.** The first two ways send from anvil's unlocked accounts, so no code handles keys.
- **Two deploy paths.**
  - `Chain.deploy` (Python) registers every installed task.
  - `contracts/script/Deploy.s.sol` (a forge script, checked by `Deploy.t.sol`) registers only the built-in ones.

### 8.1 The network setup

```
 CLI / GUI ──HTTP──▶ app (api.py) ──▶ Node (node.py) ──┬─ Client ──────┐  two threads, the same
  (each laptop)      127.0.0.1:8700    wallet (wallet.py)└─ ProviderAgent┘  step() calls as the demo
                                           │ Chain.add_signer: signs locally, sends raw
                                           ▼
                     host (host.py) on one laptop, port 8600:
                     /rpc gateway ─▶ anvil (127.0.0.1, secret mnemonic, state on disk)
                     /blobs (Store) · /faucet · /artifacts (ABIs) · /network.json
```

| Module | What it owns |
|---|---|
| `wallet.py` | Encrypted keystore files in `~/.degpu/wallets/`. The provider's X25519 key is derived from the wallet key (`crypto.keypair_from_wallet`). |
| `host.py` | anvil with a saved state, which deploys on its first run. The gateway lets through reads and `eth_sendRawTransaction` only, so there is no time travel, no `anvil_setBalance` and no sending from the host's accounts. It also owns the store, the faucet (once per address) and the ABIs, so users need no Foundry. |
| `storage.HttpStore` | The same `put`/`get` as `Store`, over HTTP. Downloads are hash-checked. An unreachable host raises `StoreUnavailable`, which the drivers retry instead of reporting a bad input. |
| `node.py` | One method per manual action (wallet, market, provider, client), plus the two background loops. Their locks are separate, so a long render never delays a reveal. Its state lives under `~/.degpu/networks/<registry>/`. |
| `api.py` | The HTTP API over the `Node` ([API.md](API.md)). It answers only on 127.0.0.1, and every POST needs the `X-DeGPU` header. Uploads become the same argparse namespace the CLI builds, so `task.prepare` is reused as is. |
| `cli.py` | The `degpu` command. `host` and `app` run things; `wallet` works on local files; everything else calls the app's API. |

The only change a task needs is its `uploads` hint, which says which flags name files.
## 9. Tests by layer

| Layer | Tests | Approach |
|---|---|---|
| Contracts | `contracts/test/*.t.sol` | `DeGPUBase` deploys the replicated market with the demo params and six providers; tests feed synthetic leaves and steer draws with `vm.prevrandao`. The suites are: Settlement, Reverts, Draw (including offer filtering), Encoding, Gas, Deploy, `TaskTypes` (per-task prices and deadlines, two markets on one registry), `Similarity` (disputes, judgements, the bond, every similar outcome) and `CheckedMarket` (its own fixture with `KeySearchChecker`). |
| Python libraries | `test_crypto.py`, `test_storage.py`, `test_runner.py`, `test_decode.py`, `test_key_search.py`, `test_similarity.py` | Golden vectors shared with the Solidity tests, runner determinism, leaf decoding, the replicated manifest helpers, and the render similarity rule on synthetic images. |
| Every task | `tests/test_tasks.py` | Conformance tests run once per installed task, so a new task is tested automatically. Exact tasks: determinism and batch independence, word format and decoding. Similar tasks: a sane `similar`. Both: runner-hash coverage. Checked tasks: solve/check consistency and agreement with the deployed checker. |
| Product path | `tests/test_wallet.py`, `tests/test_host.py`, `tests/test_app.py` | Keystores. The gateway blocks time travel and free ETH. The faucet pays once. Hash-checked blobs. The host keeps its chain across restarts. Then a host plus five users driven only through the API: a key search, a verified image job, and a cheater caught and slashed. |
| Integration | `tests/test_e2e.py` | A real anvil, all comparisons. Exact: image jobs on 20 images. Similar: the test-only fake render task (`tests/fake_render/`, injected by `conftest.py`) runs an honest job, a cheat, lying verifiers, missing files and an unfounded dispute; a real Blender job runs too if Blender is installed. Checked: key-search jobs. |
| Acceptance | `scripts/demo.py` | Nine scenarios with exact balance assertions (the two render scenarios skip without Blender); it exits with code 1 on any failure. |

## 10. Things that must stay in sync

| What | Lives in | Kept honest by |
|---|---|---|
| Hash and commitment encodings | `crypto.py` and `ReplicatedMarket.sol` | golden vectors in INTERFACE.md §2, `Encoding.t.sol` and `test_crypto.py` |
| A checked task's rule | its Python `check` and its checker contract | `test_tasks.py` (Python vs deployed contract) and the task's golden vector |
| A similar task's rule | its `similar` (in the task folder, so in the runner hash) | the runner hash: every provider and the client run the same code |
| Enums (`Status`, `Outcome`, `Drop`, `VState`, `Stat`, `Compare`, `Checked*`) | the contracts, and the `IntEnum`s in `chain.py`, matched by position | the e2e tests and the demo |
| `Params` field order and demo values, and the min stake | the contracts' `Params`; `DEMO_PARAMS` / `CHECKED_PARAMS` / `MIN_STAKE` in `chain.py`; `Deploy.s.sol`; `DeGPUBase.t.sol` | nothing automatic: change them together |
| Built-in task registration | `Chain.deploy` (from the task registry) and `Deploy.s.sol` (by hand) | `Deploy.t.sol` covers only the forge script |
| Sealed payload fields | written by `ReplicatedClient`, read by `ReplicatedProvider` | INTERFACE.md §3 and the e2e tests |
| A replicated task's code | its folder's hash, registered at deploy | any edit makes agents refuse jobs on a chain deployed with the old hash; redeploy |
| ABI | `contracts/out/`, written by `forge build` | `chain.py` builds only when an artifact is missing, so run `forge build` after editing a contract |

## 11. Where to extend

- **A new job type for an existing mode:** add one folder under `degpu/tasks/`, plus a checker contract for a checked task. See [ADDING_A_JOB_TYPE.md](ADDING_A_JOB_TYPE.md).
- **A new verification mode** (for example for unverifiable services such as bandwidth):
  - a market contract that inherits `MarketBase`;
  - a module in `degpu/modes/` with its two drivers;
  - one entry each in `PROVIDER_DRIVERS`, `CLIENT_DRIVERS` and `MARKET_CONTRACTS`;
  - a task base class for the mode.

  The guide's last section lists the steps.
- **IPFS instead of the local store:** anything with the same `put(bytes) → uri` and `get(uri) → bytes` interface works.
- **A real network:**
  - sign transactions in `Chain.send`;
  - replace the randomness in `_draw` with VRF;
  - run a keeper that calls `expire`.
- **Large replicated outputs:** a `SimilarTask` already returns files through the store. A strict task with large outputs could reuse the same file path with an exact `similar` (byte equality).

## 12. The `video/` folder

`video/` (on the `video-walkthrough` branch) consumes the core, and nothing depends on it.

1. `capture.py` imports `scripts/demo.py`, runs its scenarios and saves their output to `capture/`.
2. `build_data.py` turns that output into `data.js`.
3. The HTML engine renders the video from `data.js`.

If the demo's printed output or its list of scenarios changes, re-run the capture and check `build_data.py`.
