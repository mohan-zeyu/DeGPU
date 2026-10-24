# DeGPU

DeGPU is a small decentralized compute marketplace, built as a university blockchain course project. Small teams rent idle GPUs (here, CPUs) from staked providers to run **batch ML inference**. Payment, stakes and verification live on-chain; the compute runs off-chain.

The client decides when posting a job whether it should be verified:

- **Unverified job:** the chosen main provider runs it and is paid. It is cheap, and nothing protects the client beyond the provider's stake, the deadlines and its reputation.
- **Verified job:** the contract draws a random **verifier** that re-runs a **secret random sample** of the items. If the results disagree, it draws a random **tie-breaker** that re-runs only the mismatched items. The majority decides, and the outvoted provider is slashed.

The contract only ever compares hashes, so no human judges anything. The first job type is `image-classify-v1`: top-1 ImageNet classification with a client-supplied ONNX model (MobileNetV2 in the demo).

- Interface spec (names, encodings, rules): [`docs/INTERFACE.md`](docs/INTERFACE.md).
- Run everything: `uv run scripts/demo.py`.

---

## Architecture

```
                 ┌──────────────────────── Ethereum (anvil) ────────────────────────┐
                 │  ProviderRegistry.sol            JobMarket.sol                    │
                 │  stake, X25519 key, price,       task types, job state machine,   │
                 │  reputation; lock/slash          escrow, random draws, compare,   │
                 │  only by the market  ◀────────▶  settlement (push payouts)        │
                 └───────────▲──────────────────────────────▲───────────────────────┘
                   createJob / share / expire                 accept / commit / reveal /
                   (degpu/client.py)                          publish / submitTiebreak
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
| Contracts | `contracts/src/ProviderRegistry.sol`, `contracts/src/JobMarket.sol` | The registry holds each provider's stake, X25519 key, price per item and reputation counters; only the market may lock, slash or bump them. The market holds the job state machine, the escrow, the verifier and tie-breaker draws, the leaf comparison and the settlement. |
| Chain glue | `degpu/chain.py` | Starts anvil, loads the ABIs from `contracts/out/`, deploys with the demo parameters, sends txs from anvil accounts, decodes events, and time-travels. |
| Provider agent | `degpu/agent.py` | Each `step()` polls events and acts as main, verifier or tie-breaker. Behaviours: `honest`, `cheat`, `liar`, `offline`. |
| Client | `degpu/client.py` | Posts jobs (encrypt, upload, commit, pay), auto-shares the sample and the tie-break items, and decodes the results. |
| Crypto | `degpu/crypto.py` | keccak and `abi.encode` commitments, HKDF key derivation, NaCl SecretBox file encryption, SealedBox payloads to X25519 keys. |
| Storage | `degpu/storage.py` | `put(bytes) -> "store:<sha256>"` and `get(uri)`. It is a local directory (`DEGPU_STORE`, default `.degpu-store/`). |
| Task type | `degpu/tasks/image_classify_v1/` | `runner.py` is the official runner (resize 256, centre-crop 224, ImageNet normalisation, ONNX Runtime on one CPU thread). Its keccak is pinned on-chain as `runnerHash`. `decode.py` turns leaves back into labels. |

**Privacy:**
- Every file is encrypted with a key derived from a random per-job key `k_job`.
- The client seals `k_job` to M's on-chain X25519 key, so M sees every item. V only gets the keys of the sampled items, and T only those of the mismatched items.
- The chain stores only hashes, salted result leaves and sealed blobs.

**Result format:**
- The result for item *i* is the leaf `keccak256(abi.encode(jobSalt, i, label))`. `jobSalt` is known only to the job's participants.
- Honest providers produce identical leaves, so the contract compares hashes without learning any labels.
- The client decodes each label by trying all 1000 classes.

## Job flow

```
client  createJob(M, N, dataHash, sampleHash, k, sealed k_job) + (N+k)·price   → Open
M       checks runner hash + inputs against dataHash, accept()                  → draws V (if k>0) → Committing
client  shareSample(sample keys + indices sealed to V)
M       commitResults(keccak(all N leaves))          V  commitSample(keccak(vSalt, k leaves))
                                                                                → SampleReveal
V       revealSample(indices, sampleSalt, leaves, vSalt)  (checked vs sampleHash, sampleCommit)
                                                                                → Publishing
M       publishResults(all N leaves)  (checked vs resultsCommit) → compare with V on the sample
          all match → Verified          mismatch on X → draw T → TieBreak
client  shareTiebreak(keys of X sealed to T)
T       submitTiebreak(leaves for X) → per item majority of {M, V, T} → slash the outvoted, settle
```

How the main variants differ:
- **Unverified job (k = 0):** after `accept`, M goes straight to `publishResults` and is paid.
- **Missed deadline:** anyone may call `expire()`.
- **Inputs that don't match `dataHash`:** the verifier calls `reportBadInput`. The job then continues unverified and the client gets its fee back.

**Why cheating does not pay:**
- M can't tell which items are sampled, so it has to run every item honestly.
- Both M and V commit before either reveals, so neither can copy the other.
- `dataHash` and `sampleHash` pin the inputs and the sample, so the client can't change them later.
- Faking a fraction *f* of the items is caught with probability 1 − (1 − f)ᵏ. With k = 20, faking 20% is caught about 99% of the time. The expected slash (0.3 ETH) far exceeds the gain (about 0.002 ETH).

## Outcomes

Demo settings:
- stake 1 ETH (suspended below 0.8 ETH);
- price 0.0001 ETH per item, so 200 items cost 0.020 ETH;
- verification fee k × the same rate, so 0.002 ETH at 10%;
- tie-breaker fee 0.002 ETH;
- slashes: wrong result 30%, M misses a deadline 10%, V or T misses a deadline 5%.

| Outcome | Client | Main M | Verifier V | Tie-breaker T |
|---|---|---|---|---|
| Cancelled (not accepted) | full refund | — | — | — |
| Delivered (unverified) | pays price | + price | — | — |
| Verified (sample matches) | pays price + fee | + price | + fee | — |
| MainOutvoted | refund + M's slash − T's pay | −30% stake | + fee | + min(slash, 0.002) |
| VerifierOutvoted | pays price (fee refunded) | + price + V's slash − T's pay | −30% stake | + min(slash, 0.002) |
| BothOutvoted | full refund + both slashes − T's pay | −30% | −30% | + min(slashes, 0.002) |
| NoMajority | refund minus T's pay | unpaid | unpaid | + min(fee, 0.002) |
| MainMissed (`expire`) | full refund + M's slash − V's pay | −10% | paid from M's slash if V finished | — |
| V misses a deadline | fee refunded + V's slash; job continues unverified | + price | −5% | — |
| TiebreakerMissed | full refund + T's slash | unpaid | unpaid | −5% |
| V reports bad input | fee refunded; job continues unverified | + price | unpaid | — |
| Client never shares the sample / tie items | forfeits the fee | + price | + fee | — |

Reputation counters live in the registry:
- for main providers: verified completions, unverified completions, misses, outvoted;
- for verifiers and tie-breakers: checks completed, checks missed, checks outvoted.

The exact rules are in the settlement table of `docs/INTERFACE.md` section 7.

## Setup

```bash
brew install foundry                    # forge, anvil, cast (or: curl -L https://foundry.paradigm.xyz | bash && foundryup)
uv sync                                 # Python 3.12 venv with web3, pynacl, onnxruntime, pillow, numpy, pycryptodome, pytest
uv run scripts/fetch_demo_assets.py     # MobileNetV2 ONNX (~14 MB) + 200 Imagenette photos into assets/
```

## Running

```bash
cd contracts && forge test              # Solidity tests: every settlement row, reverts, draws, gas, deploy script
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

For each scenario it prints the agents' log, the job's on-chain event timeline and a balance table. It then asserts the results net of gas: wallet change plus the gas the account paid, cross-checked against the `Payout` / `ProviderSlashed` events and the registry stakes. It also checks that the labels the client decodes equal a local run of the runner. If any check fails, it exits with code 1.

| # | Scenario | Expected (ETH) |
|---|---|---|
| 1 | Unverified, main A, sample 0 | client −0.020; A +0.020 |
| 2 | Verified honest, main A, sample 20 | client −0.022; A +0.020; V +0.002 |
| 3 | Main E fakes 20% of labels | E slashed 0.3; V +0.002; T +0.002; client +0.296 |
| 4 | Every provider except A lies as verifier | V slashed 0.3; A +0.318; T +0.002; client −0.020 |
| 5 | Main F goes offline, then time travel and `expire()` | F slashed 0.1; client +0.100 |

Two scenarios can need an extra step:
- **Scenario 3:** a 20% cheat escapes a 20-item sample about 1% of the time. The demo then says so and retries with a new job, up to 3 times.
- **Scenario 5:** F may have been the slashed liar in scenario 4. If so, it tops its stake back up to 1 ETH before the scenario.

### Running the pieces by hand

Use one terminal per command:

```bash
uv run python -m degpu.chain --port 8545                     # anvil + contracts; prints the market address
uv run python -m degpu.agent --index 2 --behavior honest --market 0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512
uv run python -m degpu.agent --index 3 --behavior honest --market 0xe7f1...
uv run python -m degpu.agent --index 4 --behavior liar   --market 0xe7f1...
uv run python -m degpu.client --market 0xe7f1... post --main A --limit 20 --sample-rate 0.5 --wait
uv run python -m degpu.client --market 0xe7f1... status 1
uv run python -m degpu.client --market 0xe7f1... results 1
```

How the processes find each other:
- Agents use anvil's unlocked accounts (`--index`).
- Each agent keeps its X25519 key and per-job secrets in `.degpu-state/<address>.json`, so it can be restarted. The client keeps its job secrets in `.degpu-state/client-<address>.json`.
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
docs/INTERFACE.md       the shared interface spec
```

## Known limitations

- **The main provider sees every image.** Hiding data from the provider would need secure hardware (TEE), which is out of scope.
- **Collusion.** A verifier colluding with the main provider could leak which items are sampled. The random draw makes this unlikely, but not impossible.
- **Randomness.** The verifier and tie-breaker draws use `prevrandao` and `blockhash`, which is demo-grade and can be manipulated; Chainlink VRF is the upgrade. Two colluding providers among M, V and T can also swing an item.
- **Unverified jobs** have no protection beyond stake, deadlines and reputation, by design.
- **Floating-point determinism.** Differences across machines or execution providers could flip a borderline top-1 label. Pinned library versions and single-threaded CPU inference make this unlikely, and the `maxMismatch` tolerance parameter exists for it (0 in the demo).
- **Scale.** Every leaf is posted on-chain, which is fine up to about 1,000 items. Sampled items cost about 44k gas each in `revealSample`, so very large samples (about 600 or more) won't fit in a block. The upgrade path is a Merkle root plus per-item proofs.
- **Push payouts.** A recipient contract that rejects ETH would block a job's settlement. All demo participants are plain accounts.
- **Storage** is a local directory standing in for IPFS. There is no web UI and no testnet deployment yet.
