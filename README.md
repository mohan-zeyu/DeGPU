# DeGPU

DeGPU is a small decentralized compute marketplace, built as a university blockchain course project. Small teams rent idle GPUs (here, CPUs) from staked providers. Payment, stakes and verification live on-chain; the compute runs off-chain.

Each **job type** says what a provider computes. Each **verification mode** is a different market contract that says how the platform knows the answer is right:

| Mode | How work is checked | Built-in job type |
|---|---|---|
| **replicated**, exact | Random providers re-run the work and the contract compares result hashes; a tie-breaker settles mismatches | `image-classify-v1`: top-1 ImageNet label with a client-supplied ONNX model (MobileNetV2 in the demo) |
| **replicated**, similar | Random providers re-run the work. The client compares the result files with the task's pinned metric and disputes the ones that differ; a tie-breaker re-runs those and judges | `blender-render-v1`: render frames of a `.blend` scene with Blender Cycles (needs Blender 5.2) |
| **checked** | A checker contract verifies every answer on-chain | `key-search-v1`: find the key hidden in a range, given its hash |

**Replicated jobs** keep the client's decision about verification secret:
- **Same deposit either way.** Every job locks 2 × price. The chain shows only a hash of the decision, so the main provider can't tell which jobs will be checked and has to run every job honestly.
- **Revealed after the provider commits.** The client reveals the decision only after the main provider has committed to its results.
  - **"No":** the main provider is paid and the client gets the unused half of the deposit back.
  - **"Yes":** the contract draws **2 random verifiers**. Each re-runs half of the items, so every item is checked. On any mismatch, a random **tie-breaker** re-runs only the mismatched items, the majority decides each item, and the outvoted provider is slashed.

  Faking earns at most the job price (0.020 ETH in the demo) but risks a 0.3 ETH slash, so cheating stops paying once about 1 in 15 jobs is verified.
- **Rendered frames are never bit-identical** across machines, so render jobs are compared by **similarity**:
  - the client's software compares the main provider's frames with the verifiers', tile by tile, using an integer rule pinned with the task;
  - it disputes the frames that differ, posting a bond;
  - a random tie-breaker re-renders those frames and decides who was wrong.

  If the dispute was unfounded, the bond pays the tie-breaker.

**Checked jobs** are simpler:
- A wrong answer is rejected by the checker contract, so it can never be paid.
- The main provider is paid per solved puzzle, and the client gets the rest back.
- A provider that misses its deadline is slashed.

Further reading:
- How the code fits together: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
- **Adding a job type:** [`docs/ADDING_A_JOB_TYPE.md`](docs/ADDING_A_JOB_TYPE.md). It is one folder under `degpu/tasks/`, plus a small checker contract for checked jobs.
- Interface spec (names, encodings, rules): [`docs/INTERFACE.md`](docs/INTERFACE.md).
- Run everything: `uv run scripts/demo.py`.

---

## Architecture

```
            ┌──────────────────────────── Ethereum (anvil) ─────────────────────────────┐
            │  ProviderRegistry            MarketBase                                   │
            │  stake, X25519 key,  ◀────▶  ├─ ReplicatedMarket  hidden decision, draws, │
            │  price per (market, task),   │                     compare, tie-break     │
            │  stats per market            └─ CheckedMarket ──▶ IChecker (KeySearch)    │
            └──────────────▲───────────────────────────────────────▲────────────────────┘
                           │                                       │
                    ┌──────┴──────┐                       ┌────────┴──────────┐
                    │   Client    │                       │ Provider agents   │
                    └──────┬──────┘                       └────────┬──────────┘
                           └─── degpu/modes/  (one driver per mode) ───┘
                           └─── degpu/tasks/  (one folder per job type) ───┘
                           └─── degpu/storage.py  (encrypted blobs; stands in for IPFS)
```

| Part | Files | What it does |
|---|---|---|
| Contracts | `contracts/src/` | The registry holds each provider's stake, X25519 key, price per (market, task type) and reputation; only the markets the owner added may lock, slash or bump. `MarketBase` holds what every market shares: task table, price pinning and payouts. `ReplicatedMarket` and `CheckedMarket` each implement one verification mode. |
| Tasks | `degpu/tasks/` | `base.py` is the interface a job type implements; `__init__.py` finds every installed task. `image_classify_v1/` holds the ONNX runner (its folder hash is pinned on-chain). `key_search_v1/` holds the key-search solver. |
| Mode drivers | `degpu/modes/` | The off-chain half of each market: what the client and each provider role do in each phase. |
| Client / agent | `degpu/client.py`, `degpu/agent.py` | Thin shells around one account: keys, store, saved state, offered tasks. Each job goes to its mode's driver. Agent behaviours: `honest`, `cheat`, `liar`, `offline`. |
| Chain glue | `degpu/chain.py` | Starts anvil, loads the ABIs from `contracts/out/`, deploys the registry, both markets and every installed task, sends txs, decodes events, and time-travels. |
| Crypto, storage | `degpu/crypto.py`, `degpu/storage.py` | keccak and `abi.encode` commitments, HKDF keys, NaCl encryption, and the local content-addressed store. |

**Privacy (replicated mode):**
- Every file is encrypted with a key derived from a random per-job key `k_job`.
- The main provider gets `k_job` and sees every item.
- Each verifier gets only its half of the items, and the tie-breaker only the mismatched ones.
- The chain stores only hashes, salted result leaves and sealed blobs.

Checked-mode puzzles are public.

## Job flows

**Replicated:**

```
client  createJob(M, task, N, dataHash, verifyCommit, sealed k_job) + 2·N·price      → Open
M       checks runner hash + inputs against dataHash, accept()                        → Committing
M       commitResults(keccak(all N leaves))   (doesn't know yet if it will be checked) → Deciding
client  revealDecision(verifySalt, verify)    (checked against verifyCommit)
          "no"  → Publishing
          "yes" → draw 2 verifiers (among providers offering the task)              → Checking
client  shareRange(slot, item keys sealed to that verifier)   (for each verifier)
V0, V1  commitCheck(keccak(vSalt, range leaves))                                      → CheckReveal
V0, V1  revealCheck(range leaves, vSalt)                                              → Publishing
M       publishResults(all N leaves)  (checked vs resultsCommit) → compare every checked item
          all match → Verified         mismatches on X → draw T → TieBreak
client  shareTiebreak(keys of X sealed to T)
T       submitTiebreak(leaves for X) → per item, majority of {M, owning verifier, T} → slash the outvoted, settle
```

**Replicated, similar (render jobs):** the same up to `publishResults`; only the comparison changes.

```
M, V0, V1  also upload their output files, encrypted; each leaf pins keccak(file)
M       publishResults(all N leaves, resultsURI)                                       → Disputing
client  compares M's files with each verifier's (task.similar):
          all similar → acceptResults → Verified (or Delivered if unverified)
          some differ or missing → dispute(items) + bond → draw T                      → TieBreak
client  shareTiebreak(keys for those items and both sides' files, sealed to T)
T       re-renders them, compares with both sides' files → submitJudgement(verdicts)
          per item: T agrees only with M → verifier outvoted; only with V → M outvoted;
          with both → dispute rejected (the bond pays T); with neither → unresolved
```

**Checked:**

```
client  createJob(M, task, items) + N·price        (items are public)                → Open
M       accept()                                                                       → Working
M       submitResults(items, answers, found)  → the checker verifies every found answer;
          any wrong answer reverts the call   → M paid per solved item, client gets the rest
M misses the deadline → anyone calls expire() → M slashed 10%, client fully refunded
```

**Why cheating does not pay:**
- **Replicated mode:**
  - M commits before it knows whether the job is verified.
  - On a verified job every item is re-run, so any faked item is caught.
  - Nobody can copy, because M and both verifiers commit before anyone reveals.
  - `dataHash` and `verifyCommit` pin the client's inputs and decision.
- **Checked mode:** the contract checks every answer itself.

## Outcomes

Demo settings:
- stake 1 ETH (suspended below 0.8 ETH);
- 0.0001 ETH per image or per puzzle;
- tie-breaker fee 0.002 ETH;
- slashes: wrong result 30%, a main provider misses a deadline 10%, a verifier or tie-breaker misses one 5%.

**Settlement rule:** each party is paid or slashed on its own result, and the client gets everything left over: unused deposit plus all slashed stake.

**Replicated** (200 images, so price 0.020 and deposit 0.040):

| Outcome | Client (net) | Main M | Verifiers | Tie-breaker T |
|---|---|---|---|---|
| Cancelled (not accepted) | 0 | — | — | — |
| Delivered (unverified) | −0.020 | +0.020 | — | — |
| Verified | −0.040 | +0.020 | +0.010 each | — |
| MainOutvoted | +0.278 (gets M's 0.3 slash) | −0.3 stake | +0.010 each | +0.002 |
| VerifierOutvoted (both lied) | +0.578 | +0.020 | −0.3 stake each | +0.002 |
| BothOutvoted | refund + slashes − honest pay | −0.3 | the right one +0.010, the wrong one −0.3 | +0.002 |
| NoMajority | refund − pay for the parts that matched | unpaid | the clean half paid | +0.002 |
| MainMissed (`expire`) | +0.100 | −0.1 stake | paid if they finished | — |
| A verifier misses | that half's fee back + its 0.05 slash | +0.020 | −0.05 stake | — |
| TiebreakerMissed | refund + T's slash | unpaid | the clean half paid | −0.05 stake |
| Client never shares (a range or the tie items) | forfeits that pay | +0.020 | paid anyway | — |

**Replicated, similar** (12 frames at 0.001, so price 0.012 and deposit 0.024). The same settlement as above, plus disputes:

| Outcome | Client (net) | Main M | Verifiers | Tie-breaker T |
|---|---|---|---|---|
| Verified (accepted, no dispute) | −0.024 | +0.012 | +0.006 each | — |
| MainOutvoted (M's frames bad) | +0.286 (M's slash; the bond comes back) | −0.3 stake | +0.006 each | +0.002 |
| VerifierOutvoted (a verifier's frames bad) | +0.280 | +0.012 | the bad one −0.3, the other +0.006 | +0.002 |
| DisputeRejected (nothing was wrong) | −0.026 (the bond pays T) | +0.012 | +0.006 each | +0.002 |
| Unverified, M's frames missing or bad | +0.298 (M's slash minus T's fee) | −0.3 stake | — | +0.002 |

**Checked** (20 puzzles, so deposit 0.002):

| Outcome | Client (net) | Main M |
|---|---|---|
| Cancelled (not accepted) | 0 | — |
| Delivered, k puzzles solved | −k × 0.0001 | +k × 0.0001 (unsolved puzzles are refunded, never slashed) |
| Wrong answer submitted | — | the call reverts; nothing is paid |
| MainMissed (`expire`) | +0.100 | −0.1 stake |

Reputation counters live in the registry, per market:
- replicated: verified and unverified completions, misses and outvoted for main providers; checks completed, missed and outvoted for verifiers and tie-breakers;
- checked: jobs completed, misses, items solved, items not found.

The exact rules are in `docs/INTERFACE.md`, sections 7 and 8.

## Setup

```bash
brew install foundry                    # forge, anvil, cast (or: curl -L https://foundry.paradigm.xyz | bash && foundryup)
uv sync                                 # Python 3.12 venv with web3, pynacl, onnxruntime, pillow, numpy, pycryptodome, pytest
uv run scripts/fetch_demo_assets.py     # MobileNetV2 ONNX (~14 MB) + 200 Imagenette photos into assets/
brew install --cask blender             # optional: Blender 5.2 for the render jobs (without it they are skipped)
uv run scripts/calibrate_render.py      # with Blender: measure honest vs cheating renders, check the threshold
```

## Running

```bash
cd contracts && forge test              # Solidity tests: both markets, settlement, reverts, draws, task types, gas, deploy
uv run pytest                           # Python tests: libraries, conformance tests for every task, e2e on a real anvil chain
uv run scripts/demo.py                  # the nine demo scenarios on a fresh anvil (8 and 9 need Blender)
```

The Python helpers run `forge build` on their own when `contracts/out/` is missing. After editing a contract, run `forge build` yourself.

### The demo

`scripts/demo.py` sets everything up in one process:
- starts a fresh anvil;
- deploys the registry, both markets and both tasks;
- registers providers A–F (anvil accounts 2–7), each with 1 ETH stake and offering both tasks;
- posts the jobs from account 1;
- runs a deterministic step loop over the client and the agents.

For each scenario it prints the agents' log, the job's on-chain event timeline and a balance table, then asserts the results net of gas. "Net of gas" means wallet change plus the gas the account paid, cross-checked against the `Payout` / `ProviderSlashed` events and the registry stakes. If any check fails, it exits with code 1.

| # | Scenario | Expected (ETH) |
|---|---|---|
| 1 | Unverified image job (secret "no"), main A | client −0.020; A +0.020 |
| 2 | Verified image job (secret "yes"), main A, all honest. Also shows that jobs 1 and 2 looked identical on-chain | client −0.040; A +0.020; each verifier +0.010 |
| 3 | Main E fakes 20% of labels (verified) | E slashed 0.3; verifiers +0.010 each; T +0.002; client +0.278. All 40 fakes are caught |
| 4 | Every provider except A lies as verifier | both verifiers slashed 0.3; A +0.020; T +0.002; client +0.578 |
| 5 | Main F goes offline, then time travel and `expire()` | F slashed 0.1; client +0.100 |
| 6 | Key search, main A: 19 hidden keys + 1 puzzle whose key is outside its range | A +0.0019; client −0.0019 (the unsolvable puzzle is refunded) |
| 7 | Key search, main E submits made-up keys | the checker rejects them on-chain; `expire()` → E slashed 0.1; client +0.100 |
| 8 | Render job (similarity), main A, 12 frames, verified, all honest | the client accepts without a dispute; client −0.024; A +0.012; each verifier +0.006 |
| 9 | Render job (similarity), main E degrades 3 of 12 frames | the client disputes exactly those, the tie-breaker confirms; E slashed 0.3; verifiers +0.006 each; T +0.002; client +0.286 |

In scenario 5, F may have been one of the slashed liars in scenario 4 (about half the runs), and in scenario 7, E was slashed in scenario 3. A provider whose stake fell first tops it back up to 1 ETH.

### Running the pieces by hand

Use one terminal per command. Every fresh anvil puts the registry at the same address:

```bash
uv run python -m degpu.chain --port 8545                     # anvil + contracts + every task; prints the registry
uv run python -m degpu.agent --index 2 --behavior honest --registry 0x5FbDB2315678afecb367f032d93F642f64180aa3
uv run python -m degpu.agent --index 3 --behavior honest --registry 0x5FbD...
uv run python -m degpu.agent --index 4 --behavior honest --registry 0x5FbD...
uv run python -m degpu.agent --index 5 --behavior liar   --registry 0x5FbD...
uv run python -m degpu.client --registry 0x5FbD... post image-classify-v1 --main A --limit 20 --verify --wait
uv run python -m degpu.client --registry 0x5FbD... post key-search-v1 --main B --keys 10 --impossible 1 --wait
uv run python -m degpu.client --registry 0x5FbD... post blender-render-v1 --main A --frames 1-12 --verify --wait --out frames/
uv run python -m degpu.client --registry 0x5FbD... status replicated:1
uv run python -m degpu.client --registry 0x5FbD... results checked:1
```

Each task adds its own flags to `post <task>`; see `post <task> --help`. Leave out `--verify` to post an image job with a secret "no". A verified image job needs at least 4 active providers that offer the task: the main, 2 verifiers and a tie-breaker.

How the processes find each other:
- Agents and the client use anvil's unlocked accounts (`--index`). Agents offer every installed task unless `--tasks` limits them.
- Each agent keeps its X25519 key and per-job secrets in `.degpu-state/<address>.json`, so it can be restarted.
- The client keeps its job secrets in `.degpu-state/client-<address>.json`, including each image job's secret decision and salt.
- All processes must share the same store directory (`DEGPU_STORE`).

## Repository layout

```
contracts/src/          ProviderRegistry.sol, MarketBase.sol, ReplicatedMarket.sol, CheckedMarket.sol,
                        IChecker.sol, checkers/KeySearchChecker.sol
contracts/test/         Foundry tests (Settlement, Reverts, Draw, Encoding, Gas, Deploy, TaskTypes, CheckedMarket)
contracts/script/       Deploy.s.sol (RUNNER_HASH=0x.. forge script ... --broadcast)
degpu/                  chain.py, agent.py, client.py, crypto.py, storage.py
degpu/modes/            base.py (driver API), replicated.py, checked.py
degpu/tasks/            base.py (task API), image_classify_v1/ (task.py, runner.py), key_search_v1/,
                        blender_render_v1/ (task.py, render.py, similarity.py)
scripts/                fetch_demo_assets.py, demo.py, make_demo_scene.py (runs in Blender), calibrate_render.py
tests/                  test_crypto, test_storage, test_runner, test_decode, test_key_search, test_similarity,
                        test_tasks (conformance, every task), test_e2e; fake_render/ (a test-only similar task)
docs/                   ARCHITECTURE.md, ADDING_A_JOB_TYPE.md, INTERFACE.md (v4)
```

## Known limitations

- **The main provider sees every image** of a replicated job. Hiding data from the provider would need secure hardware (TEE), which is out of scope.
- **Verified replicated jobs cost 2× the price**, because every item is re-run once. The hidden decision lets clients verify only some of their jobs and still deter cheating on all of them.
- **Client patterns can leak the decision.** A provider might guess from a client's history, e.g. a client that always verifies.
- **A caught main provider can skip publishing.** It sees the revealed checks before it must publish, so it can take the 10% missed-deadline slash instead of the 30% wrong-result slash, and the client gets no labels.
- **Nothing forces the tie-breaker to run the items.** Both sides' leaves are public when it submits, so it could copy one side.
- **Randomness and collusion.** The draws use `prevrandao` and `blockhash`, which is demo-grade and can be manipulated; Chainlink VRF is the upgrade. A main provider colluding with a drawn verifier (or two colluding providers among M, a verifier and T) can swing an item.
- **Floating-point determinism.** Differences across machines or execution providers could flip a borderline top-1 label. Pinned library versions and single-threaded CPU inference make this unlikely, and the `maxMismatch` tolerance parameter exists for it (0 in the demo).
- **Similarity checks (render jobs):**
  - **The threshold trades two errors.** If it is too loose, a cheaper low-sample render passes; if it is too tight, honest GPU and CPU renders get disputed. It is a 30 dB placeholder until `scripts/calibrate_render.py` has measured the gap with Blender installed.
  - **A lazy tie-breaker** could approve both sides without re-rendering.
  - **The tie-breaker fee is flat (0.002 ETH)** however many frames it re-renders.
  - **The scene can carry Python scripts.** Providers run Blender with auto-run disabled, but there is no real sandbox.
- **Checked mode:**
  - Puzzles and their answers are public on-chain (a found key is visible to everyone).
  - "Not found" is unpaid but never slashed, so a lazy provider can waste a client's time; it shows only in its stats.
- **No mode yet for unverifiable services** (bandwidth, services sold on-chain). See the last section of `docs/ADDING_A_JOB_TYPE.md`.
- **Owner trust.** The registry owner decides which markets may slash stakes.
- **Scale.**
  - Every replicated leaf is posted on-chain, and each revealed check leaf is stored (about 24k gas per item: `revealCheck` of 100 leaves ≈ 2.4M gas).
  - That fits up to the 1,000-item limit; the upgrade path is a Merkle root plus per-item proofs.
- **Push payouts.** A recipient contract that rejects ETH would block a job's settlement. All demo participants are plain accounts.
- **Build setting.** The contracts are compiled without via-IR (`foundry.toml`), which keeps `ReplicatedMarket` under the 24 KB contract-size limit.
- **Storage** is a local directory standing in for IPFS. There is no web UI and no testnet deployment yet.
