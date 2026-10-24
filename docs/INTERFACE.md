# DeGPU shared interface spec, v4

This file is the contract between every part of DeGPU. It pins every name, encoding and rule so the Solidity side and the Python side match exactly. If you find a contradiction, don't silently diverge: follow the spec and note the problem.

**What changed in v4:**
- **Results compared by similarity.** In the replicated mode, each task type now says how its results are compared (`Compare.Exact` or `Compare.Similar`).
  - Exact tasks work as in v3.
  - Similar tasks (`blender-render-v1`) return **files**. They travel encrypted through the store, and each leaf pins one file's hash.
  - After `publishResults`, a similar job enters **Disputing**. The client compares M's files with each verifier's using the task's pinned metric, then either calls `acceptResults` or calls `dispute` with a bond.
  - The tie-breaker re-runs the disputed items and calls `submitJudgement` with one verdict per item.
  - Both comparisons share one verdict rule and the same settlement.
  - A new outcome, **DisputeRejected**, covers a dispute in which nobody was wrong.
- **Task availability.** A task can report that it can't run on a machine (`available()`, e.g. Blender missing). Agents don't offer such a task.

**What changed in v3:**
- **Job types are plugins.** A task is a folder under `degpu/tasks/` and picks a **verification mode**. Each mode is one market contract plus an off-chain driver in `degpu/modes/`. How to add a task: [ADDING_A_JOB_TYPE.md](ADDING_A_JOB_TYPE.md).
- **Two modes:**
  - **replicated:** `ReplicatedMarket`, the v2 `JobMarket` renamed. Work is checked by re-running it.
  - **checked:** the new `CheckedMarket`. A checker contract verifies each answer on-chain.
- **One registry, several markets.** The registry owner adds markets; any added market may lock, slash and bump.
  - A provider offers each (market, task type) at its own price, and a price of 0 means "not offered".
  - Reputation counters are kept per market.
- **Replicated mode:**
  - Draws only pick providers that offer the job's task type.
  - The compute, check and tie-break deadlines grow with the task's `secondsPerItem`.
  - Results are generic 32-byte words.
  - The model is now the generic "shared blob".
  - `runnerHash` covers the task's whole folder.
- **Unchanged from v2:** the hidden verification decision, full coverage by 2 verifiers, the tie-breaker, and per-party settlement. All v2 golden vectors stay valid.

## 1. Roles and accounts (anvil default mnemonic)

| Account index | Role |
|---|---|
| 0 | deployer: owner of the registry, both markets and the checkers |
| 1 | client |
| 2–7 | providers A, B, C, D, E, F |

- M = the main provider, picked by the client (both modes).
- V0, V1 = verifiers, drawn when a replicated job's "verify" decision is revealed.
- T = the tie-breaker, drawn on a replicated job's mismatch.

## 2. Encodings (Solidity `abi.encode`, Python `eth_abi.encode`, hash = keccak256)

**Replicated mode:**

| Name | Definition |
|---|---|
| `itemHash` | `keccak256(item blob)` |
| `sharedHash` | `keccak256(shared blob)`, or 32 zero bytes if the job has none (the shared blob of `image-classify-v1` is the model) |
| `dataHash` | `keccak256(abi.encode(bytes32 sharedHash, bytes32[] itemHashes))` |
| `word` | the task's 32-byte result for one item: for `image-classify-v1`, the label as a uint256; for a similar task, `keccak256(result file bytes)` |
| `leaf(i)` | `keccak256(abi.encode(bytes32 jobSalt, uint256 i, bytes32 word))` |
| `resultsCommit` | `keccak256(abi.encode(bytes32[] leaves))` (all N leaves, in index order) |
| `verifyCommit` | `keccak256(abi.encode(bytes32 verifySalt, bool verify))` |
| `checkCommit` | `keccak256(abi.encode(bytes32 vSalt, bytes32[] rangeLeaves))` (the verifier's range, in index order) |
| `runnerHash` | `keccak256(concat over the task folder's .py files, sorted by relative path, of keccak256(relative path) ‖ keccak256(file bytes))` |

Because a word is a 32-byte big-endian value, `leaf` with an integer word is byte-identical to the v2 `keccak256(abi.encode(jobSalt, i, uint256 label))`.

**Checked mode:**

| Name | Definition |
|---|---|
| `itemsHash` | `keccak256(abi.encode(bytes[] items))` |
| `key-search-v1` item | `abi.encode(bytes32 keyHash, uint256 lo, uint256 hi)` |
| `key-search-v1` answer | the key k as a uint256, valid if `lo ≤ k < hi` and `keccak256(abi.encode(k)) == keyHash` |

**Ranges:** with `m = numVerifiers` (demo 2), verifier slot `j` covers items `[j*N/m, (j+1)*N/m)` (integer division). The ranges are public once the verifiers are drawn; by then M has already committed.

Golden vectors (`0x11..` means 32 bytes of 0x11). Both Python and Solidity tests must check these:

```
leaf(0x11.., i=3, word=207)                 = 0x9ffba109988ddb050a38d005f452309a2eabcf5a46a97621effdcf26c3e47508
leaf(0x11.., 0, 1)                          = 0x7d7e572375c6eba8aac2779e4f5875bc01e37283fea38bb0535cb4cee76c8b8c
leaf(0x11.., 1, 2)                          = 0xb17ae73b7d48db18adabbd31559bb80228399275ca5c82acdab14f1017480997
resultsCommit([leaf(0x11..,0,1), leaf(0x11..,1,2)])  = 0x661107b6de8f058afd1c33983e60828b39a7b9bb77e45cd34feecff91a377be0
checkCommit(0x33.., [leaf(0x11..,0,1), leaf(0x11..,1,2)]) = 0x50ea9093e9d3cc68aa0d194796a05d23b83e807ff05aabb344f341ff9b6159d3
verifyCommit(0x88.., true)                  = 0xa2f6db48e4217cc07583f9ea52bd1fc0e90a717552373e82eea50b3a6ff9c928
verifyCommit(0x88.., false)                 = 0x571c2a6cc17bceba7d421165d8f2117dc954cbf951b4ebbb0cf9b95697b23540
dataHash(0x44.., [0x55.., 0x66..])          = 0x04ca3cee6744183786df649e62c82e681a1cc158de1e3a465006d79d9b48bdd3
keccak256(abi.encode(uint256(42)))          = 0xbeced09521047d05b8960b7e7bcc1d1292cf3e4b2a6b63f48335cbde5f7545d2
key-search: the key of that hash in [0, 100) is 42
```

## 3. Keys, encryption, sealed payloads (replicated mode, Python only)

- **HKDF:** HKDF-SHA256 (RFC 5869), empty salt, 32-byte output.
  - `job_salt = HKDF(k_job, b"degpu/job-salt")`
  - `shared_key = HKDF(k_job, b"degpu/model")`. The label predates the generic name and is kept so the vectors stay valid.
  - `item_key(i) = HKDF(k_job, b"degpu/item/%d" % i)`
  - `result_key(i) = HKDF(k_job, b"degpu/result/%d" % i)`: M's result file for item i (similar tasks)
  - `check_result_key(j, i) = HKDF(k_job, b"degpu/check-result/%d/%d" % (j, i))`: verifier slot j's result file for item i (similar tasks)
  - Golden vectors for `k_job = 0x77..`:
    - `job_salt` = `0xe498e837d1aa76f441e8e27856448c4991f2e73b5d94dcf8745c92e68656ce64`
    - `shared_key` = `0x25e5692a3174ace83b0eefef011757a926e43a5b61a64bb883b2e073b6d7cbf9`
    - `item_key(0)` = `0xcec66a1d2630bc67481343ce2eafb0a2666b92197c4ceb08017943cc4e277279`
- **File encryption:** `nacl.secret.SecretBox(key).encrypt(plaintext)`. The shared blob is encrypted with `shared_key`, and item i with `item_key(i)`.
- **Provider keys:** each provider has an X25519 keypair. The 32-byte public key is registered on-chain as `encPubKey`.
- **Sealed payloads:** `nacl.public.SealedBox(PublicKey(encPubKey)).encrypt(json_bytes)`. The JSON is UTF-8; byte values are `0x`-hex strings.
  - for M (`createJob`): `{"k_job": "0x.."}`
  - for verifier slot j (`shareRange`): `{"job_salt": "0x..", "shared_key": "0x..", "start": s, "end": e, "item_keys": {"<i>": "0x..", ...}}`
  - for T (`shareTiebreak`): `{"job_salt": "0x..", "shared_key": "0x..", "indices": [..], "item_keys": {...}}`
  - **Similar tasks add:**
    - for verifier slot j: `"result_keys": {"<i>": check_result_key(j, i)}` for its range;
    - for T: `"main_result_keys": {"<i>": result_key(i)}` and `"check_result_keys": {"<i>": check_result_key(j, i)}` for the disputed items.
- **Secrets:** `verifySalt` and `vSalt` are random 32 bytes. The client keeps `verifySalt` and its yes/no decision until it reveals them.
- **Checked mode has no secrets:** items are posted on-chain in the clear.

## 4. Storage and manifest (replicated mode)

- **`Store`:** `put(data) -> "store:<sha256hex>"`; `get(uri)` raises `KeyError` if the blob is missing. The root comes from `DEGPU_STORE` and defaults to `.degpu-store/`.
- **Manifest:** plaintext JSON at `dataURI`:
  `{"task": "<task name>", "shared": {"uri", "hash"} | null, "items": [{"uri", "hash"}, ...]}`
  - The `uri`s point at ciphertexts.
  - The `hash`es are keccak256 of the plaintexts.
  - `degpu/modes/replicated.py` writes it (`pack_inputs`) and checks it (`load_inputs`).
- **Results manifest (similar tasks):**
  - plaintext JSON `{"items": {"<i>": "store:.."}}`, where each URI points at a result file encrypted with its result key;
  - M announces it in `publishResults(.., resultsURI)`, and each verifier in `revealCheck(.., resultsURI)`;
  - a reader accepts a file only if `leaf(jobSalt, i, keccak256(file))` equals the on-chain leaf (`load_results`).

## 5. Tasks

- **Discovery:** `degpu.tasks.all_tasks()` finds every sub-package of `degpu/tasks/` whose `task.py` defines `TASK`, an instance of `ReplicatedTask` or `CheckedTask` (`degpu/tasks/base.py`).
- **Registration:** `Chain.deploy` registers every task in its mode's market, with the task's `name` and `seconds_per_item`.
  - A replicated task is registered with its `runner_hash()`.
  - A checked task is registered with a freshly deployed `checker_contract`.

  Task-type ids are numbered per market, from 1.
- **Built-in tasks:**

| Task | Mode | Shared blob / items | Word / answer | Price (demo) | secondsPerItem |
|---|---|---|---|---|---|
| `image-classify-v1` | replicated, exact | ONNX model / encoded images. MobileNetV2 preprocessing and inference as in `runner.py` (top-1 index, one image per batch) | label as uint256 (0..999) | 0.0001 ETH | 1 |
| `blender-render-v1` | replicated, similar | `.blend` scene / frame numbers. Rendered with Blender 5.2 Cycles; `render.py` forces the settings | a PNG per frame, similar if every tile of an 8×8 grid is within the tolerance (`similarity.py`) | 0.001 ETH | 30 |
| `key-search-v1` | checked | — / `abi.encode(bytes32 keyHash, uint256 lo, uint256 hi)` | key k with `lo ≤ k < hi` and `keccak256(abi.encode(k)) == keyHash` | 0.0001 ETH | 2 |

`key-search-v1` was added by following ADDING_A_JOB_TYPE.md; its golden vector is in section 2. Mining (`nonce-search-v1`) was dropped, because a provider would keep a valid nonce for itself rather than hand it in.

## 6. `ProviderRegistry.sol`

```solidity
constructor(uint256 minStake);
addMarket(address market)                   // owner only; any number of markets
register(bytes32 encPubKey) payable         // stake >= minStake
addStake() payable; withdrawStake(uint256); setEncPubKey(bytes32);
setPrice(address market, uint256 taskType, uint256 pricePerItem)   // 0 = not offered; market must be added
// added markets only:
lock(address); unlock(address);
slash(address p, uint256 bps) returns (uint256)   // sends the amount to the calling market
bump(address p, uint8 stat, uint256 amount)        // counter of the calling market
// views
isActive(p) = registered && stake >= minStake
priceOf(p, market, taskType); getProvider(p) -> (registered, stake, encPubKey, locks)
statOf(p, market, stat); providerCount; providerAt; marketCount; marketAt; isMarket(market); minStake; owner
```

The lock count is shared by all markets, and `withdrawStake` requires zero locks.

## 7. `MarketBase.sol` and `ReplicatedMarket.sol`

`MarketBase` (abstract) is shared by every market:
- the immutable `registry` and `owner`;
- `receive()` accepts ETH only from the registry;
- `mode()` returns the mode name (`"replicated"`, `"checked"`);
- a task table with `taskTypeCount`, `TaskInfo {name, secondsPerItem}` and the event `TaskTypeAdded`;
- the internal `_pinPrice(main, taskType)`, which reverts with "main does not offer task" when the price is 0;
- the internal `_slash` and `_pay`, with the events `Payout(jobId, to, amount)` and `ProviderSlashed(jobId, provider, amount)`.

```solidity
uint256 constant MAX_ITEMS = 1000;
struct Params {
  uint64 acceptWindow;   // demo 300
  uint64 computeWindow;  // demo 600: + secondsPerItem * N after accept
  uint64 decideWindow;   // demo 300: client must reveal its decision within this after M commits
  uint64 checkWindow;    // demo 600: + secondsPerItem * ceil(N / numVerifiers) after the draw
  uint64 revealWindow;   // demo 300
  uint64 publishWindow;  // demo 300
  uint64 disputeWindow;  // demo 300: similar tasks, the client reviews the results
  uint64 tiebreakWindow; // demo 600: + secondsPerItem * mismatched.length
  uint256 tiebreakFee;   // demo 0.002 ether
  uint16 wrongSlashBps;  // demo 3000
  uint16 missedSlashBps; // demo 1000
  uint16 checkMissedSlashBps; // demo 500
  uint16 maxMismatch;    // demo 0
  uint8 numVerifiers;    // demo 2
}
enum Status  { None, Open, Committing, Deciding, Checking, CheckReveal, Publishing, Disputing, TieBreak, Closed }
enum Outcome { None, Cancelled, Delivered, Verified, MainOutvoted, VerifierOutvoted, BothOutvoted, NoMajority, MainMissed, TiebreakerMissed, TieClientNoShare, DisputeRejected }
enum Compare { Exact, Similar }   // per task type
enum Drop    { None, ClientNoReveal, NoEligibleVerifier }
enum VState  { None, Assigned, Shared, Committed, Revealed, NoShare, BadInput, Missed, Outvoted }
enum Stat    { VerifiedCompleted, UnverifiedCompleted, Missed, Outvoted, ChecksCompleted, ChecksMissed, ChecksOutvoted }
struct Job {
  address client; address main; address tiebreaker;
  uint256 taskType; uint256 numItems;
  bytes32 dataHash; string dataURI; bytes32 verifyCommit;
  uint256 price;                 // numItems * priceOf(main, this, taskType), pinned at createJob; deposit = 2 * price
  Status status; Outcome outcome; Drop drop;
  bool decided; bool verify; bool tieShared; bool tieSubmitted; bool mainOutvoted;
  bytes32 resultsCommit; uint64 deadline; uint256 slashedPool;
  uint256 disputeBond;           // similar tasks: what the client paid to dispute (= tiebreakFee)
  uint256 outvotedMask; uint256 unresolvedMask;
  address[] verifiers; VState[] vstate; bytes32[] vcommit;
  uint256[] mismatched; bytes32[] mainMismatchLeaves;
}
addTaskType(bytes32 runnerHash, string name, uint64 secondsPerItem, Compare compare) returns (uint256)   // owner only
taskTypeOf(id) -> (runnerHash, name, secondsPerItem, compare); getJob; params; jobCount
rangeOf(jobId, slot) -> (start, end); feeOf(jobId, slot); checkLeafOf(jobId, i)
```

### Functions by phase

Every function reverts on the wrong caller, the wrong status, or a passed deadline, unless stated otherwise.

| Function | Caller | Requires | Effect |
|---|---|---|---|
| `createJob(address main, uint256 taskType, uint256 numItems, bytes32 dataHash, string dataURI, bytes32 verifyCommit, bytes sealedForMain) payable returns (uint256)` | client | task type exists; `isActive(main)`; main offers the task; `main != client`; `1 ≤ numItems ≤ MAX_ITEMS`; `verifyCommit != 0`; `msg.value == 2 * price` | Open, deadline = now + acceptWindow; emit `JobCreated` |
| `cancel(jobId)` | client any time, or anyone after the deadline | Open | close **Cancelled** |
| `accept(jobId)` | main | Open, `isActive(main)` | lock M; Committing, deadline = now + computeWindow + secondsPerItem·N; emit `JobAccepted` |
| `commitResults(jobId, bytes32 commit)` | main | Committing, `commit != 0` | store; Deciding, deadline = now + decideWindow; emit `ResultsCommitted` |
| `revealDecision(jobId, bytes32 verifySalt, bool verify)` | client | Deciding; `verifyCommit` matches | `decided = true`; emit `DecisionRevealed(jobId, verify)`. If `verify`: draw `numVerifiers` distinct providers, excluding client, M and each other. If enough are eligible: lock them, all `Assigned`, Checking, deadline = now + checkWindow + secondsPerItem·⌈N/m⌉, emit `VerifiersDrawn(jobId, verifiers)`. If not enough: drop NoEligibleVerifier. If `!verify` or dropped: Publishing, deadline = now + publishWindow |
| `shareRange(jobId, uint256 slot, bytes sealedForVerifier)` | client | Checking, `vstate[slot] == Assigned` | → `Shared`; emit `RangeShared(jobId, slot, verifier, sealedForVerifier)` |
| `commitCheck(jobId, bytes32 commit)` | a verifier of the job | Checking, own state `Shared`, `commit != 0` | → `Committed`; emit `CheckCommitted(jobId, slot)`; advance if no slot is still `Assigned`/`Shared` |
| `reportBadInput(jobId)` | verifier (Checking, own state `Shared`) **or** tie-breaker (TieBreak, `tieShared`) | — | verifier → `BadInput`, unlock, emit `VerifierDropped(jobId, slot, BadInput)`, advance if possible. Tie-breaker: close **TieClientNoShare** |
| (advance from Checking) | — | every slot is in `Committed`, `BadInput`, `NoShare` or `Missed` | if any `Committed`: CheckReveal, deadline = now + revealWindow; else Publishing, deadline = now + publishWindow |
| `revealCheck(jobId, bytes32[] leaves, bytes32 vSalt, string resultsURI)` | a verifier | CheckReveal, own state `Committed`, `leaves.length == end − start`, `checkCommit` matches | store `checkLeaf[i]` for its range; → `Revealed`; emit `CheckRevealed(jobId, slot, leaves, resultsURI)` (the URI of its result files, `""` for exact tasks); if no slot is still `Committed`: Publishing, deadline = now + publishWindow |
| `publishResults(jobId, bytes32[] leaves, string resultsURI)` | main | Publishing, `leaves.length == numItems`, `resultsCommit` matches | emit `ResultsPublished(jobId, leaves, resultsURI)`. **Similar task:** Disputing, deadline = now + disputeWindow. **Exact task:** for every `Revealed` slot, compare M's leaves with `checkLeaf` over its range. If mismatches ≤ maxMismatch: close **Verified** if any slot is `Revealed`, else **Delivered**. Otherwise store the mismatches (indices + M's leaves) and draw T, excluding client, M and all verifiers. If no T: close **NoMajority**. Else lock T, TieBreak, deadline = now + tiebreakWindow + secondsPerItem·#mismatched, emit `TiebreakStarted(jobId, T, mismatched)` |
| `dispute(jobId, uint256[] items) payable` | client | Disputing (similar tasks only); `msg.value == tiebreakFee` (the bond); items non-empty, strictly increasing, `< numItems` | store the bond; `mismatched = items`; emit `ResultsDisputed`; draw T as above (no T → **NoMajority**) |
| `acceptResults(jobId)` | client | Disputing | close **Verified** if any slot is `Revealed`, else **Delivered** |
| `shareTiebreak(jobId, bytes sealedForTiebreaker)` | client | TieBreak, not shared | `tieShared = true`; emit `TiebreakShared` |
| `submitTiebreak(jobId, bytes32[] leaves)` | tie-breaker | exact task; TieBreak, `tieShared`, length == `mismatched.length` | per item: `verdict(i, T's leaf == M's, T's leaf == checkLeaf[i])`; emit `TiebreakSubmitted`; close with the outcome below |
| `submitJudgement(jobId, uint8[] verdicts)` | tie-breaker | similar task; TieBreak, `tieShared`, length == `mismatched.length` | per item: `verdict(i, bit 0, bit 1)` where bit 0 = M's result acceptable, bit 1 = the owning verifier's; emit `JudgementSubmitted`; close with the outcome below |
| `expire(jobId)` | anyone | now > deadline, not Closed | see below |

**`expire` by status:**
- **Open** → Cancelled.
- **Committing** → MainMissed.
- **Deciding:** the client never revealed. Set `decided = true` and `verify = false`, drop ClientNoReveal, then move to Publishing with deadline = now + publishWindow.
- **Checking:**
  - `Assigned` slots → `NoShare` (the client never shared);
  - `Shared` slots → `Missed` (slash `checkMissedSlashBps` into `slashedPool`, bump ChecksMissed, unlock);
  - then advance.
- **CheckReveal:** `Committed` slots → `Missed` (same slash), then Publishing with deadline = now + publishWindow.
- **Publishing** → MainMissed.
- **Disputing:** the client neither disputed nor accepted; the job closes as with `acceptResults`.
- **TieBreak:** if `!tieShared`, TieClientNoShare; otherwise TiebreakerMissed (slash T by `checkMissedSlashBps`).

**The verdict rule (both comparisons), per item i that T re-ran:**

| | Effect |
|---|---|
| a `Revealed` verifier covers i, M ok and verifier not | the verifier's slot is outvoted |
| a `Revealed` verifier covers i, verifier ok and M not | M is outvoted |
| a `Revealed` verifier covers i, both ok | nobody (the dispute was unfounded) |
| a `Revealed` verifier covers i, neither ok | the slot is unresolved |
| no `Revealed` verifier covers i (e.g. an unverified job) | M is outvoted if not ok; T judges alone |

For exact tasks "ok" means "T's leaf equals that side's leaf", so this is exactly the v2 rule.

**Draw:** `_draw(jobId, exclusions...)` mixes prevrandao, the previous blockhash and a nonce. It skips providers that are inactive, excluded, or that **don't offer the job's task type**, and returns `address(0)` if none is left.

### Settlement on close (per party; the client gets the rest)

`pool = 2 * price + slashedPool + disputeBond` (+ any slash taken at close). Payouts are made in the order main → verifiers → T → client. Each payout emits `Payout`, each slash emits `ProviderSlashed`. Closing unlocks everyone still locked and emits `JobClosed`. The market holds no ETH once all its jobs are closed.

- **Main** is paid `price` unless:
  - it missed a deadline (slash `missedSlashBps`, bump Missed);
  - it was outvoted on any item (slash `wrongSlashBps`, bump Outvoted);
  - the outcome is NoMajority or TiebreakerMissed (unpaid, no slash);
  - the job was Cancelled.

  When paid, it bumps VerifiedCompleted if the outcome is Verified or VerifierOutvoted, or DisputeRejected with a `Revealed` slot; otherwise UnverifiedCompleted.
- **Verifier slot j** is paid `feeOf(slot)` if any of these hold:
  - it is `NoShare` (the client's fault);
  - it is `Revealed`, wasn't outvoted, and (unless the outcome is TieClientNoShare) none of its items are unresolved;
  - it is `Committed` or `Revealed` when the outcome is MainMissed (it did the work).

  If it was outvoted: slash `wrongSlashBps`, state `Outvoted`, bump ChecksOutvoted. A paid `Revealed` slot bumps ChecksCompleted.
- **T** is paid `min(tiebreakFee, what's left)` if it submitted, and bumps ChecksCompleted. If it missed: slash, bump ChecksMissed.
- **Client** gets everything left: the unused deposit (for unverified jobs, the whole fee) plus all slashed stake. The dispute bond therefore pays T when nobody was slashed, and comes back otherwise.

**Outcome label** (for `JobClosed`):
- Cancelled, MainMissed, TiebreakerMissed, TieClientNoShare as above.
- With no mismatch beyond the tolerance: **Verified** if any slot `Revealed`, else **Delivered**.
- After a tie-break or failed draw:
  - **BothOutvoted** if M and a verifier were outvoted;
  - **MainOutvoted** if only M was;
  - **VerifierOutvoted** if only verifiers were;
  - **NoMajority** if no one was outvoted but some item is unresolved;
  - **DisputeRejected** if no one was outvoted and nothing is unresolved.

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
  - `CheckRevealed(uint256 indexed jobId, uint256 slot, bytes32[] leaves, string resultsURI)`
- Results and tie-break:
  - `ResultsPublished(uint256 indexed jobId, bytes32[] leaves, string resultsURI)`
  - `ResultsDisputed(uint256 indexed jobId, uint256[] items)`
  - `TiebreakStarted(uint256 indexed jobId, address indexed tiebreaker, uint256[] mismatched)`
  - `TiebreakShared(uint256 indexed jobId, address indexed tiebreaker, bytes sealedForTiebreaker)`
  - `TiebreakSubmitted(uint256 indexed jobId, bytes32[] leaves)`
  - `JudgementSubmitted(uint256 indexed jobId, uint8[] verdicts)`
- Settlement: `JobClosed(uint256 indexed jobId, Outcome outcome)`, plus `Payout` and `ProviderSlashed` from `MarketBase`.

## 8. `CheckedMarket.sol` and `IChecker.sol`

```solidity
interface IChecker { function check(bytes calldata item, bytes32 answer) external view returns (bool); }

uint256 constant MAX_ITEMS = 1000;
struct Params { uint64 acceptWindow; /* demo 300 */ uint64 workWindow; /* demo 300 */ uint16 missedSlashBps; /* demo 1000 */ }
enum Status  { None, Open, Working, Closed }
enum Outcome { None, Cancelled, Delivered, MainMissed }
enum Stat    { Completed, Missed, ItemsSolved, ItemsNotFound }
struct Job {
  address client; address main; uint256 taskType; uint256 numItems;
  bytes32 itemsHash; uint256 pricePerItem;   // pinned at createJob; deposit = numItems * pricePerItem
  Status status; Outcome outcome; uint64 deadline; uint256 solved;
}
addTaskType(IChecker checker, string name, uint64 secondsPerItem) returns (uint256)   // owner only
taskTypeOf(id) -> (checker, name, secondsPerItem); getJob; params; jobCount
```

| Function | Caller | Requires | Effect |
|---|---|---|---|
| `createJob(address main, uint256 taskType, bytes[] items) payable returns (uint256)` | client | task type exists; `isActive(main)`; main offers the task; `main != client`; `1 ≤ N ≤ MAX_ITEMS`; `msg.value == N * pricePerItem` | store `itemsHash`; Open, deadline = now + acceptWindow; emit `JobCreated(jobId, client, main, taskType, items)` |
| `cancel(jobId)` | client any time, or anyone after the deadline | Open | close **Cancelled** |
| `accept(jobId)` | main | Open, `isActive(main)` | lock M; Working, deadline = now + workWindow + secondsPerItem·N; emit `JobAccepted` |
| `submitResults(jobId, bytes[] items, bytes32[] answers, bool[] found)` | main | Working; all three lengths == N; `itemsHash` matches; `checker.check(items[i], answers[i])` for every `found[i]`, **else the whole call reverts ("invalid answer")** | `solved = #found`; emit `ResultsSubmitted(jobId, answers, found)`; close **Delivered** |
| `expire(jobId)` | anyone | now > deadline; Open or Working | Open → **Cancelled**; Working → **MainMissed** |

**Settlement:** `pool = N * pricePerItem` (+ M's slash on MainMissed).
- **Delivered:**
  - M is paid `solved * pricePerItem`.
  - M's stats are bumped: Completed +1, ItemsSolved +solved, ItemsNotFound +(N − solved).
  - The client gets the rest.

  "Not found" is never slashed.
- **MainMissed:** M is slashed `missedSlashBps` and bumps Missed. The client gets the whole pool: its full deposit plus the slash.
- **Cancelled:** the client is refunded in full.

M is unlocked on every close after accept.

**`KeySearchChecker`** (`contracts/src/checkers/KeySearchChecker.sol`) is the checker of `key-search-v1`; see the encodings in section 2.

## 9. Python API

- **`degpu/chain.py`:**
  - `Chain(rpc, registry_address)` finds every market through the registry and keys it by `mode()`: `chain.markets["replicated"]` and `chain.markets["checked"]`.
  - `Chain.deploy()` deploys everything and registers every installed task.
  - Helpers: `task_id(name)`, `price_of(addr, mode, id)`, `stat(addr, mode, stat)`, `job(mode, id)` and `events(mode, from_block, job_id=)`.
  - `JobRef(mode, id)` identifies a job, written `"checked:1"`.
- **`degpu/tasks/`:**
  - the task interface (`base.py`): `ReplicatedTask` (exact), `SimilarTask` (similar), `CheckedTask`, plus `available()`;
  - the task registry: `all_tasks()` and `get(name)`.

  See ADDING_A_JOB_TYPE.md.
- **`degpu/modes/`:** one `ProviderDriver` and one `ClientDriver` per mode (`base.py`, `replicated.py`, `checked.py`), listed in `PROVIDER_DRIVERS` and `CLIENT_DRIVERS`.
- **`ProviderAgent(chain, account, behavior, tasks=None, ...)`:**
  - `register()` stakes, publishes the key and offers every task at its `default_price`, except tasks that aren't `available()` here.
  - `step()` runs every mode driver.
  - Behaviours:
    - `honest`;
    - `cheat`: fakes 20% of results in the replicated mode, and makes up every answer in the checked mode;
    - `liar`: random results as a replicated verifier;
    - `offline`.
- **`Client(chain, account, ...)`:**
  - `post(task, main, inputs, **options)` returns a `JobRef`. The inputs are what `task.prepare` returns; the replicated mode takes `verify=` and `reveal=`.
  - Also: `step()`, `results(ref)`, `outcome(ref)`, `expire(ref)`, `cancel(ref)`.
- **CLI:**
  - `python -m degpu.chain`
  - `python -m degpu.agent --index N --registry 0x..`
  - `python -m degpu.client --registry 0x.. post <task> --main A [mode and task flags] [--wait]`
  - `python -m degpu.client --registry 0x.. results|status|expire|cancel <mode>:<id>`; `results` writes result files to `--out DIR` (default `results/<job>`)

## 10. Demo (`scripts/demo.py`)

Setup:
- a fresh anvil;
- providers A–F register with 1 ETH, and each offers both tasks at 0.0001 ETH per item;
- the replicated jobs use 200 images, so price = 0.020, deposit = 0.040, and each verifier covers 100 items (fee 0.010 each);
- the key-search jobs use 20 puzzles, each hiding its key among 2^16 values;
- the render jobs use 12 frames of the demo scene at 0.001 ETH per frame, so price = 0.012 and deposit = 0.024. They are skipped when Blender isn't installed.

| # | Scenario | Main | Mode / decision | Behaviour | Expected (net of gas) |
|---|---|---|---|---|---|
| 1 | Unverified | A | replicated, no | all honest | client −0.020; A +0.020 |
| 2 | Verified, honest | A | replicated, yes | all honest | client −0.040; A +0.020; V0, V1 +0.010 each |
| 3 | Cheater caught | E (`cheat` 0.2) | replicated, yes | others honest | E slashed 0.3; V0, V1 +0.010; T +0.002; client +0.278. Always caught, no retry |
| 4 | Lying verifiers | A | replicated, yes | every other provider `liar` (verifier role only) | both verifiers slashed 0.3; A +0.020; T +0.002; client +0.578 |
| 5 | Main offline | F (`offline`) | replicated, no | — | `expire` in Committing → F slashed 0.1; client +0.100 |
| 6 | Honest key search | A | checked | 19 solvable + 1 puzzle whose key is outside its range | A +0.0019; client −0.0019 (the unsolvable puzzle is refunded) |
| 7 | Cheating provider | E (`cheat`, stake topped up) | checked | made-up keys | submission reverts "invalid answer"; `expire` → E slashed 0.1; client +0.100 |
| 8 | Honest render | A | replicated similar, yes | all honest | the client accepts without a dispute; client −0.024; A +0.012; V0, V1 +0.006 each |
| 9 | Cheating render | E (`cheat` 0.25, stake topped up) | replicated similar, yes | 3 degraded frames | the client disputes exactly those; T confirms; E slashed 0.3; V0, V1 +0.006; T +0.002; client +0.286 |

The demo also prints the on-chain `createJob` data for jobs 1 and 2 side by side, to show they look identical (same value, no decision visible) until the reveal.
