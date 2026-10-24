# DeGPU shared interface spec (MVP: batch inference)

This file is the contract between everyone building DeGPU. The approved design is in the plan; this spec pins every name, encoding and rule so the Solidity side and the Python side match exactly. If you find a contradiction, don't silently diverge: follow the spec, note the problem in your report.

Clarifications relative to the plan (all simplifications):
- **Inputs = model + images.** `dataHash` covers the model hash as well as the image hashes.
- **Tie-breaker submits once.** It submits its leaves directly, with no commit/reveal. Commit/reveal adds nothing at that point, because M's and V's leaves are already public.
- **The mismatch tolerance is `maxMismatch`.** If M and V disagree on at most `maxMismatch` sampled items, the job counts as verified and no tie-break happens. Demo value: 0.

## 1. Roles and accounts (anvil default mnemonic)

| Account index | Role |
|---|---|
| 0 | deployer / owner of both contracts |
| 1 | client |
| 2–7 | providers A, B, C, D, E, F |

Main provider = M (picked by the client), verifier = V (drawn at accept), tie-breaker = T (drawn on mismatch).

## 2. Encodings (Solidity `abi.encode`, Python `eth_abi.encode`, hash = keccak256)

| Name | Definition |
|---|---|
| `itemHash` | `keccak256(image file bytes)` |
| `modelHash` | `keccak256(model file bytes)` |
| `dataHash` | `keccak256(abi.encode(bytes32 modelHash, bytes32[] itemHashes))` |
| `leaf(i)` | `keccak256(abi.encode(bytes32 jobSalt, uint256 i, uint256 label))`, label in 0..999 |
| `resultsCommit` | `keccak256(abi.encode(bytes32[] leaves))` (all N leaves, index order) |
| `sampleHash` | `keccak256(abi.encode(bytes32 sampleSalt, uint256[] indices))` (indices strictly increasing) |
| `sampleCommit` | `keccak256(abi.encode(bytes32 vSalt, bytes32[] sampleLeaves))` (leaves in `indices` order) |
| `runnerHash` | `keccak256(bytes of degpu/tasks/image_classify_v1/runner.py)` |

Golden vectors (`0x11..` means 32 bytes of 0x11). Both Python and Solidity tests must check these:

```
leaf(0x11.., i=3, label=207)                = 0x9ffba109988ddb050a38d005f452309a2eabcf5a46a97621effdcf26c3e47508
leaf(0x11.., 0, 1)                          = 0x7d7e572375c6eba8aac2779e4f5875bc01e37283fea38bb0535cb4cee76c8b8c
leaf(0x11.., 1, 2)                          = 0xb17ae73b7d48db18adabbd31559bb80228399275ca5c82acdab14f1017480997
resultsCommit([leaf(0x11..,0,1), leaf(0x11..,1,2)])  = 0x661107b6de8f058afd1c33983e60828b39a7b9bb77e45cd34feecff91a377be0
sampleHash(0x22.., [0,5,9])                 = 0xa3f2acca7f8ff2353d15988e2b4d6043e7b51d3f53492f8dbb5b11b3856497bc
sampleCommit(0x33.., [leaf(0x11..,0,1), leaf(0x11..,1,2)]) = 0x50ea9093e9d3cc68aa0d194796a05d23b83e807ff05aabb344f341ff9b6159d3
dataHash(0x44.., [0x55.., 0x66..])          = 0x04ca3cee6744183786df649e62c82e681a1cc158de1e3a465006d79d9b48bdd3
```

## 3. Keys, encryption, sealed payloads (Python only)

- **HKDF:** HKDF-SHA256 (RFC 5869) with an empty salt (32 zero bytes), 32-byte output.
  - `job_salt = HKDF(k_job, b"degpu/job-salt")`
  - `model_key = HKDF(k_job, b"degpu/model")`
  - `item_key(i) = HKDF(k_job, b"degpu/item/%d" % i)`
  - Golden vectors for `k_job = 0x77..`:
    - `job_salt` = `0xe498e837d1aa76f441e8e27856448c4991f2e73b5d94dcf8745c92e68656ce64`
    - `model_key` = `0x25e5692a3174ace83b0eefef011757a926e43a5b61a64bb883b2e073b6d7cbf9`
    - `item_key(0)` = `0xcec66a1d2630bc67481343ce2eafb0a2666b92197c4ceb08017943cc4e277279`
- **File encryption:** `nacl.secret.SecretBox(key).encrypt(plaintext)` (random nonce prepended). The model is encrypted with `model_key`, and image i with `item_key(i)`.
- **Provider keys:** each provider has an X25519 keypair (`nacl.public.PrivateKey`). The 32-byte public key is registered on-chain as `encPubKey` (bytes32).
- **Sealed payloads:** `nacl.public.SealedBox(PublicKey(encPubKey)).encrypt(json_bytes)`. The JSON is UTF-8; all byte values are `0x`-hex strings and indices are ints.
  - for M (`createJob`): `{"k_job": "0x.."}`
  - for V (`shareSample`): `{"job_salt": "0x..", "model_key": "0x..", "sample_salt": "0x..", "indices": [..], "item_keys": {"<i>": "0x..", ...}}`
  - for T (`shareTiebreak`): `{"job_salt": "0x..", "model_key": "0x..", "indices": [..], "item_keys": {...}}`
- **Salts:** `sample_salt` and `vSalt` are random 32 bytes. The client picks S as `k` distinct indices drawn uniformly at random, then sorts them ascending.

## 4. Storage and manifest

- **`degpu/storage.py` `Store`:** root dir from env `DEGPU_STORE`, defaulting to `.degpu-store/` in the repo root.
  - `put(data: bytes) -> str` returns `"store:" + sha256hex(data)`.
  - `get(uri: str) -> bytes` raises `KeyError` if missing.
- **Manifest:** plaintext JSON, stored with `put`; its URI is the job's `dataURI`:
  `{"task": "image-classify-v1", "model": {"uri": "store:..", "hash": "0x<modelHash>"}, "items": [{"uri": "store:..", "hash": "0x<itemHash>"}, ...]}`
  - The `uri`s point at ciphertexts.
  - The `hash`es are of the plaintexts.
  - `dataHash` is computed from these hashes in item order.

## 5. Task type `image-classify-v1`

- Registered as task type id **1**: `addTaskType(runnerHash, "image-classify-v1")`.
- **Model:** MobileNetV2 ONNX (ImageNet, 1000 classes). The demo asset lives at `assets/mobilenetv2.onnx`.
- **`degpu/tasks/image_classify_v1/runner.py`:**
  - `NUM_CLASSES = 1000`
  - `runner_hash() -> bytes`: keccak of the file's own bytes.
  - `class Runner(model_bytes: bytes)` with `.classify(images: list[bytes]) -> list[int]`.
  - ONNX Runtime CPUExecutionProvider with `intra_op_num_threads=1`, `inter_op_num_threads=1`, sequential execution.
  - Preprocessing: PIL → RGB → resize the shorter side to 256 (bilinear) → centre-crop 224 → float32/255 → normalise (mean 0.485/0.456/0.406, std 0.229/0.224/0.225) → NCHW.
  - Output: argmax of the logits.
- **`degpu/tasks/image_classify_v1/decode.py`:** `decode_labels(job_salt: bytes, leaves: list[bytes], num_classes=1000) -> list[int | None]` recovers each label by trying every class.
- **Runner check:** an agent refuses a job whose task type `runnerHash` differs from its local `runner_hash()`.

## 6. `ProviderRegistry.sol`

```solidity
enum Stat { VerifiedCompleted, UnverifiedCompleted, Missed, Outvoted, ChecksCompleted, ChecksMissed, ChecksOutvoted }

constructor(uint256 minStake)                 // demo: 0.8 ether; deployer = owner
function setMarket(address market) external   // owner only, once
function register(bytes32 encPubKey, uint256 pricePerItem) external payable  // msg.value >= minStake, not yet registered
function addStake() external payable
function withdrawStake(uint256 amount) external  // only when locks(msg.sender) == 0
function setPrice(uint256 pricePerItem) external
function setEncPubKey(bytes32 encPubKey) external
// JobMarket only:
function lock(address p) external              // locks[p]++
function unlock(address p) external            // locks[p]--
function slash(address p, uint256 bps) external returns (uint256 amount) // amount = stake*bps/10000; stake -= amount; sends amount to msg.sender
function bump(address p, Stat s) external      // stats[p][s]++
// views:
function isActive(address p) external view returns (bool)   // registered && stake >= minStake
function providerCount() external view returns (uint256)
function providerAt(uint256 i) external view returns (address)
function getProvider(address p) external view returns (bool registered, uint256 stake, bytes32 encPubKey, uint256 pricePerItem, uint256 locks)
function statOf(address p, Stat s) external view returns (uint256)
function minStake() external view returns (uint256)
events: ProviderRegistered(address indexed provider, bytes32 encPubKey, uint256 pricePerItem, uint256 stake)
        StakeChanged(address indexed provider, uint256 newStake)
        Slashed(address indexed provider, uint256 amount)
```

## 7. `JobMarket.sol`

```solidity
uint256 constant MAX_ITEMS = 1000;
struct Params {
  uint64 acceptWindow; uint64 computeWindow; uint64 revealWindow; uint64 publishWindow; uint64 tiebreakWindow;
  uint256 tiebreakFee;        // demo 0.002 ether
  uint16 wrongSlashBps;       // demo 3000
  uint16 missedSlashBps;      // demo 1000
  uint16 checkMissedSlashBps; // demo 500
  uint16 maxMismatch;         // demo 0
}
enum Status  { None, Open, Committing, SampleReveal, Publishing, TieBreak, Closed }
enum Outcome { None, Cancelled, Delivered, Verified, MainOutvoted, VerifierOutvoted, BothOutvoted, NoMajority, MainMissed, TiebreakerMissed, TieClientNoShare }
enum Drop    { None, NoEligibleVerifier, ClientNoShare, BadInput, VerifierMissed }   // why verification was dropped
struct Job {
  address client; address main; address verifier; address tiebreaker;
  uint256 taskType; uint256 numItems; uint256 sampleSize;
  bytes32 dataHash; string dataURI; bytes32 sampleHash;
  uint256 price; uint256 fee;                    // price = numItems*pricePerItem(main), fee = sampleSize*pricePerItem(main), pinned at createJob
  Status status; Outcome outcome; Drop drop;
  bool sampleShared; bool tieShared;
  bytes32 resultsCommit; bytes32 sampleCommit;
  uint64 deadline;                               // deadline of the current phase
  uint256 verifierSlash;                         // held for the client after a VerifierMissed drop
  uint256[] sampleIndices; bytes32[] verifierLeaves;          // set by revealSample
  uint256[] mismatched; bytes32[] mainMismatchLeaves; bytes32[] verifierMismatchLeaves; // set on mismatch
}
constructor(address registry, Params memory p)   // deployer = owner; demo windows: accept 300, compute 600, reveal 300, publish 300, tiebreak 600 (seconds)
function addTaskType(bytes32 runnerHash, string calldata name) external returns (uint256 id)  // owner only; ids start at 1
function taskTypeOf(uint256 id) external view returns (bytes32 runnerHash, string memory name)
function getJob(uint256 jobId) external view returns (Job memory)
function jobCount() external view returns (uint256)             // jobIds start at 1
function params() external view returns (Params memory)
```

### Functions by phase

Every function reverts on the wrong caller, the wrong status, or a passed deadline, unless stated otherwise. `now` = `block.timestamp`.

| Function | Caller | Requires | Effect |
|---|---|---|---|
| `createJob(address main, uint256 taskType, uint256 numItems, bytes32 dataHash, string dataURI, uint256 sampleSize, bytes32 sampleHash, bytes sealedForMain) payable returns (uint256)` | client | task type exists; `isActive(main)`; `main != client`; `1 ≤ numItems ≤ MAX_ITEMS`; `sampleSize ≤ numItems`; `msg.value == price + fee` | status Open, deadline = now + acceptWindow; emit `JobCreated` |
| `cancel(jobId)` | client any time, or anyone after the deadline | Open | close **Cancelled** |
| `accept(jobId)` | main | Open, now ≤ deadline, `isActive(main)` | lock M. If `sampleSize > 0`, draw V (excluding client and M): lock V, status Committing, deadline = now + computeWindow; if no V is eligible, drop NoEligibleVerifier. If `sampleSize == 0` or dropped: status Publishing, deadline = now + computeWindow. Emit `JobAccepted(jobId, verifier)` |
| `shareSample(jobId, bytes sealedForVerifier)` | client | Committing, V set, not yet shared | `sampleShared = true`; emit `SampleShared(jobId, verifier, sealedForVerifier)` |
| `commitResults(jobId, bytes32 commit)` | main | Committing, not yet committed | store; emit `ResultsCommitted`; advance if both committed |
| `commitSample(jobId, bytes32 commit)` | verifier | Committing, `sampleShared`, not yet committed | store; emit `SampleCommitted`; advance if both committed |
| (advance) | — | both commits present | status SampleReveal, deadline = now + revealWindow |
| `reportBadInput(jobId)` | verifier (Committing, shared, before `commitSample`) **or** tiebreaker (TieBreak, `tieShared`) | — | verifier: drop BadInput, unlock V, status Publishing, deadline = now + computeWindow. Tiebreaker: close **TieClientNoShare** |
| `revealSample(jobId, uint256[] indices, bytes32 sampleSalt, bytes32[] leaves, bytes32 vSalt)` | verifier | SampleReveal; `sampleHash` matches; `indices.length == leaves.length == sampleSize`; strictly increasing; last `< numItems`; `sampleCommit` matches | store; status Publishing, deadline = now + publishWindow; emit `SampleRevealed(jobId, indices, leaves)` |
| `publishResults(jobId, bytes32[] leaves)` | main | Publishing; `leaves.length == numItems`; if `resultsCommit != 0` it must match | emit `ResultsPublished(jobId, leaves)`. If V revealed and drop == None: compare `leaves[indices[j]]` with `verifierLeaves[j]`. ≤ maxMismatch mismatches → close **Verified**. Otherwise store the mismatches and draw T (excluding client, M, V): if none, close **NoMajority**; else lock T, status TieBreak, deadline = now + tiebreakWindow, emit `TiebreakStarted(jobId, tiebreaker, mismatched)`. Without verification → close **Delivered** |
| `shareTiebreak(jobId, bytes sealedForTiebreaker)` | client | TieBreak, not yet shared | `tieShared = true`; emit `TiebreakShared(jobId, tiebreaker, sealedForTiebreaker)` |
| `submitTiebreak(jobId, bytes32[] leaves)` | tiebreaker | TieBreak, `tieShared`, length == `mismatched.length` | per item: equals M's leaf → V outvoted; else equals V's leaf → M outvoted; else no majority. Any M and any V outvoted → **BothOutvoted**; any M → **MainOutvoted**; any V → **VerifierOutvoted**; else **NoMajority**. Emit `TiebreakSubmitted(jobId, leaves)` |
| `expire(jobId)` | anyone | now > deadline, status not Closed | **Open** → Cancelled. **Committing:** no `resultsCommit` → MainMissed; else if `!sampleShared` → drop ClientNoShare; else drop VerifierMissed (slash V `checkMissedSlashBps`, keep the amount in `verifierSlash`, bump ChecksMissed, unlock V); after a drop: status Publishing, deadline = now + publishWindow. **SampleReveal** → drop VerifierMissed (same) → Publishing. **Publishing** → MainMissed. **TieBreak:** `!tieShared` → TieClientNoShare; else TiebreakerMissed |

**Draw:** `_draw(jobId, ex1, ex2, ex3)`:
- `n = providerCount()`.
- `start = uint256(keccak256(abi.encode(block.prevrandao, blockhash(block.number-1), jobId, ex1, ex2, ex3, drawNonce++))) % n`.
- Return the first provider from `start` (wrapping round) that `isActive` and isn't excluded, or `address(0)`.

Tests control it with `vm.prevrandao`.

### Settlement on close

`tf` = the tie-breaker's pay; S_X = an amount slashed from X. All payouts are push transfers that emit `Payout(jobId, to, amount)`. Every slash emits `ProviderSlashed(jobId, provider, amount)`. Closing unlocks every still-locked participant and emits `JobClosed(jobId, outcome)`. After the last job closes, the JobMarket's ETH balance must be 0.

| Outcome | Payouts | Stats bumped |
|---|---|---|
| Cancelled | client ← price + fee | — |
| Delivered | main ← price. Fee by drop: none (fee 0); NoEligibleVerifier → client; BadInput → client; ClientNoShare → verifier; VerifierMissed → client ← fee + verifierSlash | M UnverifiedCompleted |
| Verified | main ← price; verifier ← fee | M VerifiedCompleted; V ChecksCompleted |
| MainOutvoted | S_M = slash(M, wrongSlashBps); tf = min(S_M, tiebreakFee); client ← price + S_M − tf; verifier ← fee; T ← tf | M Outvoted; V, T ChecksCompleted |
| VerifierOutvoted | S_V = slash(V, wrongSlashBps); tf = min(S_V, tiebreakFee); main ← price + S_V − tf; client ← fee; T ← tf | M VerifiedCompleted; V ChecksOutvoted; T ChecksCompleted |
| BothOutvoted | slash both by wrongSlashBps; tf = min(S_M + S_V, tiebreakFee); client ← price + fee + S_M + S_V − tf; T ← tf | M Outvoted; V ChecksOutvoted; T ChecksCompleted |
| NoMajority | tf = T exists ? min(fee, tiebreakFee) : 0; client ← price + fee − tf; T ← tf | T ChecksCompleted (if any) |
| MainMissed | S_M = slash(M, missedSlashBps); vPay = (sampleCommit ≠ 0 and drop == None) ? min(S_M, fee) : 0; verifier ← vPay; client ← price + fee + S_M − vPay + verifierSlash (any slash held from an earlier VerifierMissed drop) | M Missed; V ChecksCompleted if paid |
| TiebreakerMissed | S_T = slash(T, checkMissedSlashBps); client ← price + fee + S_T | T ChecksMissed |
| TieClientNoShare | main ← price; verifier ← fee | M UnverifiedCompleted; V ChecksCompleted |

**Events:**
- `JobCreated(uint256 indexed jobId, address indexed client, address indexed main, uint256 taskType, uint256 numItems, uint256 sampleSize, bytes32 dataHash, string dataURI, bytes sealedForMain)`
- `JobAccepted(uint256 indexed jobId, address verifier)`
- `VerificationDropped(uint256 indexed jobId, Drop reason)`
- `SampleShared(uint256 indexed jobId, address indexed verifier, bytes sealedForVerifier)` (`sealed` is a reserved word in Solidity)
- `ResultsCommitted(uint256 indexed jobId)`
- `SampleCommitted(uint256 indexed jobId)`
- `SampleRevealed(uint256 indexed jobId, uint256[] indices, bytes32[] leaves)`
- `ResultsPublished(uint256 indexed jobId, bytes32[] leaves)`
- `TiebreakStarted(uint256 indexed jobId, address indexed tiebreaker, uint256[] mismatched)`
- `TiebreakShared(uint256 indexed jobId, address indexed tiebreaker, bytes sealedForTiebreaker)`
- `TiebreakSubmitted(uint256 indexed jobId, bytes32[] leaves)`
- `JobClosed(uint256 indexed jobId, Outcome outcome)`
- `Payout(uint256 indexed jobId, address indexed to, uint256 amount)`
- `ProviderSlashed(uint256 indexed jobId, address indexed provider, uint256 amount)`

`JobMarket` must have `receive()` accepting ETH only from the registry, so slashes can arrive.

## 8. Python modules and who owns them

| Owner | Files |
|---|---|
| Contracts agent | `contracts/src/ProviderRegistry.sol`, `contracts/src/JobMarket.sol`, `contracts/test/*.t.sol`, `contracts/script/Deploy.s.sol` |
| Python core agent | `degpu/crypto.py`, `degpu/storage.py`, `degpu/tasks/image_classify_v1/{runner.py,decode.py}`, `scripts/fetch_demo_assets.py`, `tests/test_crypto.py`, `tests/test_storage.py`, `tests/test_runner.py`, `tests/test_decode.py` |
| Integration agent | `degpu/chain.py`, `degpu/agent.py`, `degpu/client.py`, `scripts/demo.py`, `tests/test_e2e.py`, `README.md` |

**`degpu/crypto.py` API:**
- Hashing: `keccak(b) -> bytes`, `hkdf32(ikm, info) -> bytes`
- Key derivation: `job_salt(k_job)`, `model_key(k_job)`, `item_key(k_job, i)`
- Commitments: `leaf(job_salt, i, label)`, `results_commit(leaves)`, `sample_hash(sample_salt, indices)`, `sample_commit(v_salt, leaves)`, `data_hash(model_hash, item_hashes)`
- Keys and sealing: `generate_keypair() -> (priv32, pub32)`, `seal(pub32, payload: dict) -> bytes`, `unseal(priv32, blob) -> dict`
- File encryption: `encrypt(key32, plaintext) -> bytes`, `decrypt(key32, blob) -> bytes`

All byte values are `bytes`. Hex conversion only happens at the JSON boundary.

**Integration side (owned by the integration agent):**
- `chain.py`: loads ABIs/bytecode from `contracts/out/`, deploys both contracts with the demo params, sets the market, adds task type 1, and provides time-travel helpers (`evm_increaseTime`, `evm_mine`).
- `agent.py`: `ProviderAgent` with a `step()` that polls events and acts as main, verifier or tie-breaker. Behaviour flags:
  - `honest`
  - `cheat` (as main, replaces a fraction of its labels with wrong ones; default 0.2)
  - `liar` (as verifier only, random labels)
  - `offline` (accepts as main, then never acts)

  It persists its per-job secrets in memory for the demo, and in `.degpu-state/<address>.json` when run as a CLI daemon.
- `client.py`: `Client` with:
  - `post(main, model_path, image_paths, sample_rate) -> jobId`;
  - `step()`, which auto-shares the sample with V and the tie items with T;
  - `results(jobId) -> labels`.

## 9. Demo (`scripts/demo.py`)

Setup:
- fresh anvil;
- deploy; providers A–F register with 1 ETH stake at 0.0001 ETH per item;
- the client uses 200 images from `assets/images/`.

The demo runs these scenarios in order:

| # | Scenario | Main | Sample | Behaviour |
|---|---|---|---|---|
| 1 | Unverified | A | 0 | all honest |
| 2 | Verified, honest | A | 20 | all honest |
| 3 | Cheater caught | E (`cheat` 0.2) | 20 | others honest |
| 4 | Lying verifier | A | 20 | every other provider `liar` (as verifier only) |
| 5 | Main offline | F (`offline`) | 0 | — |

Expected results:
- **Scenario 1:** client −0.020; A +0.020.
- **Scenario 2:** client −0.022; A +0.020; V +0.002.
- **Scenario 3:** E slashed 0.3; V +0.002; T +0.002; client net +0.296. A 20% cheat escapes a 10% sample about 1% of the time; then the demo says so and retries.
- **Scenario 4:** V slashed 0.3; A +0.318; T +0.002; client net −0.020.
- **Scenario 5:** after time travel past the deadline, `expire` → F slashed 0.1; client net +0.100.

Balances are checked net of gas, using the `Payout` / `ProviderSlashed` events and registry stakes.
