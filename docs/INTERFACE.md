# DeGPU shared interface spec (MVP: batch inference), v2

This file is the contract between every part of DeGPU. It pins every name, encoding and rule so the Solidity side and the Python side match exactly. If you find a contradiction, don't silently diverge: follow the spec and note the problem.

**What changed in v2:**
- **Hidden verification decision.** When posting, the client commits to a secret yes/no on whether to verify. Every job locks the same deposit (2 × price), so the main provider can't tell which jobs will be checked. The decision is revealed only after the main provider has committed its results. So providers must run every job honestly, and clients who skip verification are protected by the ones who pay for it.
- **Full coverage, split evenly.** A verified job is re-run in full by 2 randomly drawn verifiers, each taking half of the items. Every item is checked once, so a faked item is always caught. The secret sample (`sampleHash`, sample salt, hidden indices) is gone.
- **Simpler settlement.** Each party is paid or slashed by its own result. The client receives whatever is left (refunds plus all slashed stake).

Unchanged from v1:
- `dataHash` covers the model and the images.
- The tie-breaker submits once, with no commit/reveal.
- Mismatch tolerance `maxMismatch` (demo 0).

## 1. Roles and accounts (anvil default mnemonic)

| Account index | Role |
|---|---|
| 0 | deployer / owner of both contracts |
| 1 | client |
| 2–7 | providers A, B, C, D, E, F |

- M = the main provider, picked by the client.
- V0, V1 = verifiers, drawn when a "verify" decision is revealed.
- T = the tie-breaker, drawn on a mismatch.

## 2. Encodings (Solidity `abi.encode`, Python `eth_abi.encode`, hash = keccak256)

| Name | Definition |
|---|---|
| `itemHash` | `keccak256(image file bytes)` |
| `modelHash` | `keccak256(model file bytes)` |
| `dataHash` | `keccak256(abi.encode(bytes32 modelHash, bytes32[] itemHashes))` |
| `leaf(i)` | `keccak256(abi.encode(bytes32 jobSalt, uint256 i, uint256 label))`, label in 0..999 |
| `resultsCommit` | `keccak256(abi.encode(bytes32[] leaves))` (all N leaves, index order) |
| `verifyCommit` | `keccak256(abi.encode(bytes32 verifySalt, bool verify))` |
| `checkCommit` | `keccak256(abi.encode(bytes32 vSalt, bytes32[] rangeLeaves))` (the verifier's range, index order) |
| `runnerHash` | `keccak256(bytes of degpu/tasks/image_classify_v1/runner.py)` |

**Ranges:** with `m = numVerifiers` (demo 2), verifier slot `j` covers items `[j*N/m, (j+1)*N/m)` (integer division). The ranges are public once the verifiers are drawn; by then M has already committed.

Golden vectors (`0x11..` means 32 bytes of 0x11). Both Python and Solidity tests must check these:

```
leaf(0x11.., i=3, label=207)                = 0x9ffba109988ddb050a38d005f452309a2eabcf5a46a97621effdcf26c3e47508
leaf(0x11.., 0, 1)                          = 0x7d7e572375c6eba8aac2779e4f5875bc01e37283fea38bb0535cb4cee76c8b8c
leaf(0x11.., 1, 2)                          = 0xb17ae73b7d48db18adabbd31559bb80228399275ca5c82acdab14f1017480997
resultsCommit([leaf(0x11..,0,1), leaf(0x11..,1,2)])  = 0x661107b6de8f058afd1c33983e60828b39a7b9bb77e45cd34feecff91a377be0
checkCommit(0x33.., [leaf(0x11..,0,1), leaf(0x11..,1,2)]) = 0x50ea9093e9d3cc68aa0d194796a05d23b83e807ff05aabb344f341ff9b6159d3
verifyCommit(0x88.., true)                  = 0xa2f6db48e4217cc07583f9ea52bd1fc0e90a717552373e82eea50b3a6ff9c928
verifyCommit(0x88.., false)                 = 0x571c2a6cc17bceba7d421165d8f2117dc954cbf951b4ebbb0cf9b95697b23540
dataHash(0x44.., [0x55.., 0x66..])          = 0x04ca3cee6744183786df649e62c82e681a1cc158de1e3a465006d79d9b48bdd3
```

## 3. Keys, encryption, sealed payloads (Python only)

- **HKDF:** HKDF-SHA256 (RFC 5869), empty salt, 32-byte output.
  - `job_salt = HKDF(k_job, b"degpu/job-salt")`
  - `model_key = HKDF(k_job, b"degpu/model")`
  - `item_key(i) = HKDF(k_job, b"degpu/item/%d" % i)`
  - Golden vectors for `k_job = 0x77..`:
    - `job_salt` = `0xe498e837d1aa76f441e8e27856448c4991f2e73b5d94dcf8745c92e68656ce64`
    - `model_key` = `0x25e5692a3174ace83b0eefef011757a926e43a5b61a64bb883b2e073b6d7cbf9`
    - `item_key(0)` = `0xcec66a1d2630bc67481343ce2eafb0a2666b92197c4ceb08017943cc4e277279`
- **File encryption:** `nacl.secret.SecretBox(key).encrypt(plaintext)`. The model is encrypted with `model_key`, and image i with `item_key(i)`.
- **Provider keys:** each provider has an X25519 keypair. The 32-byte public key is registered on-chain as `encPubKey`.
- **Sealed payloads:** `nacl.public.SealedBox(PublicKey(encPubKey)).encrypt(json_bytes)`. The JSON is UTF-8; byte values are `0x`-hex strings.
  - for M (`createJob`): `{"k_job": "0x.."}`
  - for verifier slot j (`shareRange`): `{"job_salt": "0x..", "model_key": "0x..", "start": s, "end": e, "item_keys": {"<i>": "0x..", ...}}`
  - for T (`shareTiebreak`): `{"job_salt": "0x..", "model_key": "0x..", "indices": [..], "item_keys": {...}}`
- **Secrets:** `verifySalt` and `vSalt` are random 32 bytes. The client keeps `verifySalt` and its yes/no decision until it reveals them.

## 4. Storage and manifest (unchanged)

- **`Store`:** `put(data) -> "store:<sha256hex>"`; `get(uri)` raises `KeyError` if missing. Root from `DEGPU_STORE`, default `.degpu-store/`.
- **Manifest:** plaintext JSON at `dataURI`:
  `{"task": "image-classify-v1", "model": {"uri", "hash"}, "items": [{"uri", "hash"}, ...]}`
  - The `uri`s point at ciphertexts.
  - The `hash`es are keccak of the plaintexts.

## 5. Task type `image-classify-v1` (unchanged)

- Task type id **1**, with the runner hash pinned on-chain.
- MobileNetV2 ONNX; preprocessing and output as implemented in `runner.py` (top-1 class index, one image per batch).
- `decode_labels(job_salt, leaves)` recovers labels by trying all 1000 classes.

## 6. `ProviderRegistry.sol` (unchanged)

```solidity
enum Stat { VerifiedCompleted, UnverifiedCompleted, Missed, Outvoted, ChecksCompleted, ChecksMissed, ChecksOutvoted }
constructor(uint256 minStake); setMarket(address); register(bytes32 encPubKey, uint256 pricePerItem) payable;
addStake() payable; withdrawStake(uint256); setPrice(uint256); setEncPubKey(bytes32);
// JobMarket only: lock(address); unlock(address); slash(address p, uint256 bps) returns (uint256); bump(address, Stat)
// views: isActive, providerCount, providerAt, getProvider, statOf, minStake
```

## 7. `JobMarket.sol`

```solidity
uint256 constant MAX_ITEMS = 1000;
struct Params {
  uint64 acceptWindow;   // demo 300
  uint64 computeWindow;  // demo 600: M must commit within this after accept
  uint64 decideWindow;   // demo 300: client must reveal its decision within this after M commits
  uint64 checkWindow;    // demo 600: verifiers must commit within this after being drawn
  uint64 revealWindow;   // demo 300: verifiers must reveal within this after the check phase ends
  uint64 publishWindow;  // demo 300: M must publish within this
  uint64 tiebreakWindow; // demo 600
  uint256 tiebreakFee;   // demo 0.002 ether
  uint16 wrongSlashBps;  // demo 3000
  uint16 missedSlashBps; // demo 1000
  uint16 checkMissedSlashBps; // demo 500
  uint16 maxMismatch;    // demo 0
  uint8 numVerifiers;    // demo 2
}
enum Status  { None, Open, Committing, Deciding, Checking, CheckReveal, Publishing, TieBreak, Closed }
enum Outcome { None, Cancelled, Delivered, Verified, MainOutvoted, VerifierOutvoted, BothOutvoted, NoMajority, MainMissed, TiebreakerMissed, TieClientNoShare }
enum Drop    { None, ClientNoReveal, NoEligibleVerifier }           // why a job ended up unverified
enum VState  { None, Assigned, Shared, Committed, Revealed, NoShare, BadInput, Missed, Outvoted }
struct Job {
  address client; address main; address tiebreaker;
  uint256 taskType; uint256 numItems;
  bytes32 dataHash; string dataURI; bytes32 verifyCommit;
  uint256 price;                 // numItems * pricePerItem(main), pinned at createJob; deposit = 2 * price (price + fee, fee == price)
  Status status; Outcome outcome; Drop drop;
  bool decided; bool verify;     // decided = decision revealed (or defaulted to false)
  bool tieShared;
  bytes32 resultsCommit;
  uint64 deadline;
  uint256 slashedPool;           // ETH slashed so far for this job and held by the market
  address[] verifiers; VState[] vstate; bytes32[] vcommit;
  uint256[] mismatched; bytes32[] mainMismatchLeaves;
}
// extra getters
function getJob(uint256 jobId) external view returns (Job memory);
function jobCount() external view returns (uint256);
function rangeOf(uint256 jobId, uint256 slot) external view returns (uint256 start, uint256 end);
function checkLeafOf(uint256 jobId, uint256 i) external view returns (bytes32);   // a verifier's revealed leaf for item i
function feeOf(uint256 jobId, uint256 slot) external view returns (uint256);    // (end-start) * pricePerItem
```

### Functions by phase

Every function reverts on the wrong caller, the wrong status, or a passed deadline, unless stated otherwise.

| Function | Caller | Requires | Effect |
|---|---|---|---|
| `createJob(address main, uint256 taskType, uint256 numItems, bytes32 dataHash, string dataURI, bytes32 verifyCommit, bytes sealedForMain) payable returns (uint256)` | client | task type exists; `isActive(main)`; `main != client`; `1 ≤ numItems ≤ MAX_ITEMS`; `verifyCommit != 0`; `msg.value == 2 * price` | Open, deadline = now + acceptWindow; emit `JobCreated` |
| `cancel(jobId)` | client any time, or anyone after the deadline | Open | close **Cancelled** |
| `accept(jobId)` | main | Open, `isActive(main)` | lock M; Committing, deadline = now + computeWindow; emit `JobAccepted` |
| `commitResults(jobId, bytes32 commit)` | main | Committing, `commit != 0` | store; Deciding, deadline = now + decideWindow; emit `ResultsCommitted` |
| `revealDecision(jobId, bytes32 verifySalt, bool verify)` | client | Deciding; `verifyCommit` matches | `decided = true`; emit `DecisionRevealed(jobId, verify)`. If `verify`: draw `numVerifiers` distinct providers, excluding client, M and each other. If enough are eligible: lock them, all `Assigned`, Checking, deadline = now + checkWindow, emit `VerifiersDrawn(jobId, verifiers)`. If not enough: drop NoEligibleVerifier. If `!verify` or dropped: Publishing, deadline = now + publishWindow |
| `shareRange(jobId, uint256 slot, bytes sealedForVerifier)` | client | Checking, `vstate[slot] == Assigned` | → `Shared`; emit `RangeShared(jobId, slot, verifier, sealedForVerifier)` |
| `commitCheck(jobId, bytes32 commit)` | a verifier of the job | Checking, own state `Shared`, `commit != 0` | → `Committed`; emit `CheckCommitted(jobId, slot)`; advance if no slot is still `Assigned`/`Shared` |
| `reportBadInput(jobId)` | verifier (Checking, own state `Shared`) **or** tie-breaker (TieBreak, `tieShared`) | — | verifier → `BadInput`, unlock, emit `VerifierDropped(jobId, slot, BadInput)`, advance if possible. Tie-breaker: close **TieClientNoShare** |
| (advance from Checking) | — | every slot is in `Committed`, `BadInput`, `NoShare` or `Missed` | if any `Committed`: CheckReveal, deadline = now + revealWindow; else Publishing, deadline = now + publishWindow |
| `revealCheck(jobId, bytes32[] leaves, bytes32 vSalt)` | a verifier | CheckReveal, own state `Committed`, `leaves.length == end − start`, `checkCommit` matches | store `checkLeaf[i]` for its range; → `Revealed`; emit `CheckRevealed(jobId, slot, leaves)`; if no slot is still `Committed`: Publishing, deadline = now + publishWindow |
| `publishResults(jobId, bytes32[] leaves)` | main | Publishing, `leaves.length == numItems`, `resultsCommit` matches | emit `ResultsPublished(jobId, leaves)`. For every `Revealed` slot, compare M's leaves with `checkLeaf` over its range. If mismatches ≤ maxMismatch: close **Verified** if any slot is `Revealed`, else **Delivered**. Otherwise store the mismatches (indices + M's leaves) and draw T, excluding client, M and all verifiers. If no T: close **NoMajority**. Else lock T, TieBreak, deadline = now + tiebreakWindow, emit `TiebreakStarted(jobId, T, mismatched)` |
| `shareTiebreak(jobId, bytes sealedForTiebreaker)` | client | TieBreak, not shared | `tieShared = true`; emit `TiebreakShared` |
| `submitTiebreak(jobId, bytes32[] leaves)` | tie-breaker | TieBreak, `tieShared`, length == `mismatched.length` | per mismatched item i, owned by slot j: T's leaf == M's → slot j outvoted; else T's leaf == `checkLeaf[i]` → M outvoted; else unresolved. Emit `TiebreakSubmitted`; close with the outcome below |
| `expire(jobId)` | anyone | now > deadline, not Closed | see below |

**`expire` by status:**
- **Open** → Cancelled.
- **Committing** → MainMissed.
- **Deciding** → the client never revealed: `decided = true`, `verify = false`, drop ClientNoReveal → Publishing, deadline = now + publishWindow.
- **Checking:**
  - `Assigned` slots → `NoShare` (the client never shared);
  - `Shared` slots → `Missed` (slash `checkMissedSlashBps` into `slashedPool`, bump ChecksMissed, unlock);
  - then advance.
- **CheckReveal:** `Committed` slots → `Missed` (same slash) → Publishing, deadline = now + publishWindow.
- **Publishing** → MainMissed.
- **TieBreak:** `!tieShared` → TieClientNoShare; else TiebreakerMissed (slash T `checkMissedSlashBps`).

**Draw:** as in v1, `_draw(jobId, exclusions...)` with prevrandao + previous blockhash + a nonce. It skips inactive and excluded providers and returns `address(0)` if none is left.

### Settlement on close (per party; the client gets the rest)

`pool = 2 * price + slashedPool` (+ any slash taken at close). Payouts are made in the order main → verifiers → T → client. Each payout emits `Payout`, each slash emits `ProviderSlashed`. Closing unlocks everyone still locked and emits `JobClosed`. The market's balance is 0 after every close.

- **Main** is paid `price` unless:
  - it missed a deadline (slash `missedSlashBps`, bump Missed);
  - it was outvoted on any item (slash `wrongSlashBps`, bump Outvoted);
  - the outcome is NoMajority or TiebreakerMissed (unpaid, no slash);
  - the job was Cancelled.

  When paid, it bumps VerifiedCompleted if any slot was `Revealed`, otherwise UnverifiedCompleted.
- **Verifier slot j** is paid `feeOf(slot)` if any of these hold:
  - it is `NoShare` (the client's fault);
  - it is `Revealed`, wasn't outvoted, and (unless the outcome is TieClientNoShare) none of its items are unresolved;
  - it is `Committed` or `Revealed` when the outcome is MainMissed (it did the work).

  If it was outvoted: slash `wrongSlashBps`, state `Outvoted`, bump ChecksOutvoted. A paid `Revealed` slot bumps ChecksCompleted.
- **T** is paid `min(tiebreakFee, what's left)` if it submitted, and bumps ChecksCompleted. If it missed: slash, bump ChecksMissed.
- **Client** gets everything left: the unused deposit (for unverified jobs, the whole fee) plus all slashed stake.

**Outcome label** (for `JobClosed`):
- Cancelled, MainMissed, TiebreakerMissed, TieClientNoShare as above.
- With no mismatch beyond the tolerance: **Verified** if any slot `Revealed`, else **Delivered**.
- After a tie-break or failed draw:
  - **BothOutvoted** if M and a verifier were outvoted;
  - **MainOutvoted** if only M was;
  - **VerifierOutvoted** if only verifiers were;
  - **NoMajority** if no one was outvoted.

**Events:**
- Job lifecycle:
  - `JobCreated(uint256 indexed jobId, address indexed client, address indexed main, uint256 taskType, uint256 numItems, bytes32 dataHash, string dataURI, bytes32 verifyCommit, bytes sealedForMain)`
  - `JobAccepted(uint256 indexed jobId)`
  - `ResultsCommitted(uint256 indexed jobId)`
  - `DecisionRevealed(uint256 indexed jobId, bool verify)`
  - `VerificationDropped(uint256 indexed jobId, Drop reason)`
- Verification:
  - `VerifiersDrawn(uint256 indexed jobId, address[] verifiers)`
  - `RangeShared(uint256 indexed jobId, uint256 slot, address indexed verifier, bytes sealedForVerifier)`
  - `CheckCommitted(uint256 indexed jobId, uint256 slot)`
  - `VerifierDropped(uint256 indexed jobId, uint256 slot, VState reason)`
  - `CheckRevealed(uint256 indexed jobId, uint256 slot, bytes32[] leaves)`
- Results and tie-break:
  - `ResultsPublished(uint256 indexed jobId, bytes32[] leaves)`
  - `TiebreakStarted(uint256 indexed jobId, address indexed tiebreaker, uint256[] mismatched)`
  - `TiebreakShared(uint256 indexed jobId, address indexed tiebreaker, bytes sealedForTiebreaker)`
  - `TiebreakSubmitted(uint256 indexed jobId, bytes32[] leaves)`
- Settlement:
  - `JobClosed(uint256 indexed jobId, Outcome outcome)`
  - `Payout(uint256 indexed jobId, address indexed to, uint256 amount)`
  - `ProviderSlashed(uint256 indexed jobId, address indexed provider, uint256 amount)`

## 8. Python API changes

- **`degpu/crypto.py`:**
  - add `verify_commit(verify_salt, verify: bool)`;
  - rename `sample_commit` to `check_commit` (same formula);
  - remove `sample_hash`.
- **Main provider (`agent.py`):** always `commitResults`, then waits for Publishing before `publishResults`. It never learns the decision before committing.
- **Verifier role:** on `VerifiersDrawn` naming it, it waits for its `RangeShared`, then checks inputs, runs its range, `commitCheck`s, and `revealCheck`s in CheckReveal. Behaviour `liar` = random labels when verifying.
- **Client (`client.py`):**
  - `post(main, model_path, image_paths, verify: bool)` commits the decision and deposits 2 × price;
  - `step()` reveals the decision once `ResultsCommitted` appears, shares each verifier's range after `VerifiersDrawn`, and shares the tie items with T.

## 9. Demo (`scripts/demo.py`)

Setup:
- fresh anvil;
- providers A–F register with 1 ETH at 0.0001 ETH per item;
- 200 images, so price = 0.020, deposit = 0.040, and each verifier covers 100 items (fee 0.010 each).

| # | Scenario | Main | Decision | Behaviour | Expected (net of gas) |
|---|---|---|---|---|---|
| 1 | Unverified | A | no | all honest | client −0.020; A +0.020 |
| 2 | Verified, honest | A | yes | all honest | client −0.040; A +0.020; V0, V1 +0.010 each |
| 3 | Cheater caught | E (`cheat` 0.2) | yes | others honest | E slashed 0.3; V0, V1 +0.010; T +0.002; client +0.278. Always caught, no retry |
| 4 | Lying verifiers | A | yes | every other provider `liar` (verifier role only) | both verifiers slashed 0.3; A +0.020; T +0.002; client +0.578 |
| 5 | Main offline | F (`offline`) | no | — | `expire` in Committing → F slashed 0.1; client +0.100 |

The demo also prints the on-chain `createJob` data for jobs 1 and 2 side by side, to show they look identical (same value, no decision visible) until the reveal.
