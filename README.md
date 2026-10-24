# DeGPU

DeGPU is a small decentralized compute marketplace, built as a university blockchain course project. Small teams rent idle GPUs (here, CPUs) from staked providers to run **batch ML inference**. Payment, stakes and verification live on-chain; the compute runs off-chain.

When posting a job, the client makes a **secret** decision about whether it should be verified:

- **Same deposit either way.** Every job locks 2 × price. The chain shows only a hash of the decision, so the main provider can't tell which jobs will be checked. It has to run every job honestly.
- **Revealed after the provider commits.** The client reveals the decision only after the main provider has committed to its results.
  - **Unverified** ("no"): the main provider is paid and the client gets the unused half of the deposit back.
  - **Verified** ("yes"): the contract draws **2 random verifiers**. Each re-runs half of the items, so every item is checked. On any mismatch, a random **tie-breaker** re-runs only the mismatched items, the majority decides each item, and the outvoted provider is slashed.

Because the decision is hidden, verified jobs also protect the unverified ones. Faking earns at most the job price (0.020 ETH in the demo) but risks a 0.3 ETH slash, so cheating stops paying once about 1 in 15 jobs is verified.

The contract only ever compares hashes; no human judges anything. The first job type is `image-classify-v1`: top-1 ImageNet classification with a client-supplied ONNX model (MobileNetV2 in the demo).

- Interface spec (names, encodings, rules): [`docs/INTERFACE.md`](docs/INTERFACE.md).
- Run everything: `uv run scripts/demo.py`.

---

## Architecture

```
                 ┌──────────────────────── Ethereum (anvil) ────────────────────────┐
                 │  ProviderRegistry.sol            JobMarket.sol                    │
                 │  stake, X25519 key, price,       task types, job state machine,   │
                 │  reputation; lock/slash          escrow, hidden decision, draws,  │
                 │  only by the market  ◀────────▶  compare, settlement (push pay)   │
                 └───────────▲──────────────────────────────▲───────────────────────┘
                   createJob / revealDecision /               accept / commit / check /
                   share / expire (degpu/client.py)           publish / submitTiebreak
                             │                                (degpu/agent.py)
                      ┌──────┴──────┐                     ┌───────────┴───────────┐
                      │   Client    │                     │  Provider agents A–F  │
                      │ encrypts,   │                     │  main / verifier /    │
                      │ uploads,    │                     │  tie-breaker roles,   │
                      │ decodes     │                     │  ONNX runner          │
                      └──────┬──────┘                     └───────────┬───────────┘
                             └─────── degpu/storage.py (content-addressed, ───────┘
                                      encrypted blobs; stands in for IPFS)
```

| Part | Files | What it does |
|---|---|---|
| Contracts | `contracts/src/ProviderRegistry.sol`, `contracts/src/JobMarket.sol` | The registry holds each provider's stake, X25519 key, price per item and reputation counters; only the market may lock, slash or bump them. The market holds the job state machine, the escrow, the hidden decision, the verifier and tie-breaker draws, the item-by-item comparison and the settlement. |
| Chain glue | `degpu/chain.py` | Starts anvil, loads the ABIs from `contracts/out/`, deploys with the demo parameters, sends txs from anvil accounts, decodes events, and time-travels. |
| Provider agent | `degpu/agent.py` | Each `step()` polls events and acts as main, verifier or tie-breaker. Behaviours: `honest`, `cheat`, `liar`, `offline`. |
| Client | `degpu/client.py` | Posts jobs (encrypt, upload, commit to the decision, pay). Then it reveals the decision, shares each verifier's range and the tie-break items, and decodes the results. |
| Crypto | `degpu/crypto.py` | keccak and `abi.encode` commitments, HKDF key derivation, NaCl SecretBox file encryption, SealedBox payloads to X25519 keys. |
| Storage | `degpu/storage.py` | `put(bytes) -> "store:<sha256>"` and `get(uri)`. It is a local directory (`DEGPU_STORE`, default `.degpu-store/`). |
| Task type | `degpu/tasks/image_classify_v1/` | `runner.py` is the official runner (resize 256, centre-crop 224, ImageNet normalisation, ONNX Runtime on one CPU thread). Its keccak is pinned on-chain as `runnerHash`. `decode.py` turns leaves back into labels. |

**Privacy:**
- Every file is encrypted with a key derived from a random per-job key `k_job`.
- The client seals `k_job` to M's on-chain X25519 key, so M sees every item.
- Each verifier gets the keys of its half of the items only, and T only those of the mismatched items.
- The chain stores only hashes, salted result leaves and sealed blobs.

**Result format:**
- The result for item *i* is the leaf `keccak256(abi.encode(jobSalt, i, label))`. `jobSalt` is known only to the job's participants.
- Honest providers produce identical leaves, so the contract compares hashes without learning any labels.
- The client decodes each label by trying all 1000 classes.

## Job flow

```
client  createJob(M, N, dataHash, verifyCommit, sealed k_job) + 2·N·price            → Open
M       checks runner hash + inputs against dataHash, accept()                        → Committing
M       commitResults(keccak(all N leaves))   (doesn't know yet if it will be checked) → Deciding
client  revealDecision(verifySalt, verify)    (checked against verifyCommit)
          "no"  → Publishing
          "yes" → draw 2 verifiers; V0 covers items [0, N/2), V1 covers [N/2, N)     → Checking
client  shareRange(slot, item keys sealed to that verifier)   (for each verifier)
V0, V1  commitCheck(keccak(vSalt, range leaves))                                      → CheckReveal
V0, V1  revealCheck(range leaves, vSalt)                                              → Publishing
M       publishResults(all N leaves)  (checked vs resultsCommit) → compare every checked item
          all match → Verified         mismatches on X → draw T → TieBreak
client  shareTiebreak(keys of X sealed to T)
T       submitTiebreak(leaves for X) → per item, majority of {M, owning verifier, T} → slash the outvoted, settle
```

**How the variants differ:**
- **Unverified job:** after the "no" reveal, M publishes and is paid. The client gets the fee half of its deposit back.
- **Client never reveals:** after the decide deadline anyone may call `expire()`, and the job finishes unverified.
- **Missed deadline:** anyone may call `expire()`. A verifier that misses its commit or reveal is slashed 5%, and the other verifier's half is still checked.
- **Bad inputs:** a verifier whose inputs don't match `dataHash` calls `reportBadInput`. It is unpaid but not slashed, and its half goes unchecked.

**Why cheating does not pay:**
- **M can't pick which jobs to run honestly.** It commits before it knows whether the job is verified.
- **On a verified job every item is re-run**, so any faked item is caught. There's no luck involved, unlike sampling.
- **Nobody can copy.** M and both verifiers commit before anyone reveals.
- **The client can't change its mind.** `dataHash` pins the inputs, and `verifyCommit` pins the decision.

## Outcomes

Demo settings:
- stake 1 ETH (suspended below 0.8 ETH);
- price 0.0001 ETH per item, so 200 items cost 0.020 ETH and the deposit is 0.040 ETH;
- each verifier earns 0.010 ETH for its 100 items;
- tie-breaker fee 0.002 ETH;
- slashes: wrong result 30%, M misses a deadline 10%, a verifier or T misses a deadline 5%.

**Settlement rule:** each party is paid or slashed on its own result, and the client gets everything left over: unused deposit plus all slashed stake.

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

Reputation counters live in the registry:
- for main providers: verified completions, unverified completions, misses, outvoted;
- for verifiers and tie-breakers: checks completed, checks missed, checks outvoted.

The exact rules are in "Settlement on close" in `docs/INTERFACE.md` section 7.

## Setup

```bash
brew install foundry                    # forge, anvil, cast (or: curl -L https://foundry.paradigm.xyz | bash && foundryup)
uv sync                                 # Python 3.12 venv with web3, pynacl, onnxruntime, pillow, numpy, pycryptodome, pytest
uv run scripts/fetch_demo_assets.py     # MobileNetV2 ONNX (~14 MB) + 200 Imagenette photos into assets/
```

## Running

```bash
cd contracts && forge test              # Solidity tests: every settlement case, reverts, draws, gas, deploy script
uv run pytest                           # Python tests, including tests/test_e2e.py on a real anvil chain
uv run scripts/demo.py                  # the five demo scenarios on a fresh anvil
```

The Python helpers run `forge build` on their own when `contracts/out/` is missing.

### The demo

`scripts/demo.py` sets everything up in one process:
- starts a fresh anvil and deploys both contracts;
- registers providers A–F (anvil accounts 2–7), each with 1 ETH stake at 0.0001 ETH per item;
- posts 200 images from account 1;
- runs a deterministic step loop over the client and the agents.

For each scenario it prints the agents' log, the job's on-chain event timeline and a balance table, then asserts the results net of gas. "Net of gas" means wallet change plus the gas the account paid, cross-checked against the `Payout` / `ProviderSlashed` events and the registry stakes. It also checks that the labels the client decodes equal a local run of the runner. If any check fails, it exits with code 1.

| # | Scenario | Expected (ETH) |
|---|---|---|
| 1 | Unverified (secret "no"), main A | client −0.020; A +0.020 |
| 2 | Verified (secret "yes"), main A, all honest. Also shows that jobs 1 and 2 looked identical on-chain | client −0.040; A +0.020; each verifier +0.010 |
| 3 | Main E fakes 20% of labels (verified) | E slashed 0.3; verifiers +0.010 each; T +0.002; client +0.278. All 40 fakes are caught |
| 4 | Every provider except A lies as verifier | both verifiers slashed 0.3; A +0.020; T +0.002; client +0.578 |
| 5 | Main F goes offline, then time travel and `expire()` | F slashed 0.1; client +0.100 |

In scenario 5, F may have been one of the slashed liars in scenario 4 (about half the runs). If so, it first tops its stake back up to 1 ETH.

### Running the pieces by hand

Use one terminal per command:

```bash
uv run python -m degpu.chain --port 8545                     # anvil + contracts; prints the market address
uv run python -m degpu.agent --index 2 --behavior honest --market 0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512
uv run python -m degpu.agent --index 3 --behavior honest --market 0xe7f1...
uv run python -m degpu.agent --index 4 --behavior honest --market 0xe7f1...
uv run python -m degpu.agent --index 5 --behavior liar   --market 0xe7f1...
uv run python -m degpu.client --market 0xe7f1... post --main A --limit 20 --verify --wait
uv run python -m degpu.client --market 0xe7f1... status 1
uv run python -m degpu.client --market 0xe7f1... results 1
```

Leave out `--verify` to post a job with a secret "no". A verified job needs at least 4 active providers: the main, 2 verifiers and a tie-breaker.

How the processes find each other:
- Agents use anvil's unlocked accounts (`--index`).
- Each agent keeps its X25519 key and per-job secrets in `.degpu-state/<address>.json`, so it can be restarted.
- The client keeps its job secrets, including each job's secret decision and salt, in `.degpu-state/client-<address>.json`.
- All processes must share the same store directory (`DEGPU_STORE`).

## Repository layout

```
contracts/src/          ProviderRegistry.sol, JobMarket.sol
contracts/test/         Foundry tests (Encoding, Settlement, Reverts, Draw, Gas, Deploy)
contracts/script/       Deploy.s.sol (RUNNER_HASH=0x.. forge script ... --broadcast)
degpu/                  chain.py, agent.py, client.py, crypto.py, storage.py
degpu/tasks/image_classify_v1/   runner.py (hash pinned on-chain), decode.py
scripts/                fetch_demo_assets.py, demo.py
tests/                  test_crypto, test_storage, test_runner, test_decode, test_e2e
docs/INTERFACE.md       the shared interface spec (v2)
```

## Known limitations

- **The main provider sees every image.** Hiding data from the provider would need secure hardware (TEE), which is out of scope.
- **Verified jobs cost 2× the price**, because every item is re-run once. The hidden decision lets clients verify only some of their jobs and still deter cheating on all of them.
- **Client patterns can leak the decision.** A provider might guess from a client's history, e.g. a client that always verifies.
- **Randomness and collusion.** The draws use `prevrandao` and `blockhash`, which is demo-grade and can be manipulated; Chainlink VRF is the upgrade. A main provider colluding with a drawn verifier (or two colluding providers among M, a verifier and T) can swing an item.
- **Floating-point determinism.** Differences across machines or execution providers could flip a borderline top-1 label. Pinned library versions and single-threaded CPU inference make this unlikely, and the `maxMismatch` tolerance parameter exists for it (0 in the demo).
- **Scale.**
  - Every leaf is posted on-chain, and each revealed check leaf is stored (about 24k gas per item: `revealCheck` of 100 leaves ≈ 2.4M gas).
  - That fits up to the 1,000-item limit, at about 12M gas per verifier.
  - The upgrade path is a Merkle root plus per-item proofs.
- **Push payouts.** A recipient contract that rejects ETH would block a job's settlement. All demo participants are plain accounts.
- **Build setting.** `JobMarket` is compiled without via-IR (`foundry.toml`), which keeps it under the 24 KB contract-size limit.
- **Storage** is a local directory standing in for IPFS. There is no web UI and no testnet deployment yet.
