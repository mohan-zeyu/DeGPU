// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {MarketBase} from "./MarketBase.sol";

/// @title ReplicatedMarket
/// @notice The "replicated" verification mode: work is checked by re-running it on other providers.
///         Fits any task whose items have deterministic results (batch inference, rendering...).
///         A client posts a job to a main provider M with a commitment to a secret yes/no
///         ("verify this job?") and always deposits 2 x price, so M can't tell which jobs will be
///         checked. M runs every item and commits to its results; only then does the client
///         reveal the decision. If it is "yes", numVerifiers random verifiers each re-run an even
///         share of the items, commit, then reveal, and the contract compares every item. On a
///         mismatch a random tie-breaker T re-runs only the mismatched items and the majority
///         decides who gets slashed.
///         Verifiers and tie-breakers are drawn only among providers that offer the job's task type.
/// @dev See docs/INTERFACE.md section 7 for every rule implemented here.
///      Randomness (prevrandao + previous blockhash) is demo-grade; VRF would be the upgrade.
contract ReplicatedMarket is MarketBase {
    uint256 public constant MAX_ITEMS = 1000;

    struct Params {
        uint64 acceptWindow;
        uint64 computeWindow; // M must commit within this (+ the task's time for N items) after accept
        uint64 decideWindow; // client must reveal its decision within this after M commits
        uint64 checkWindow; // verifiers must commit within this (+ time for their range) after being drawn
        uint64 revealWindow; // verifiers must reveal within this
        uint64 publishWindow; // M must publish within this
        uint64 tiebreakWindow; // T must submit within this (+ time for the mismatched items)
        uint256 tiebreakFee; // max pay for the tie-breaker
        uint16 wrongSlashBps; // outvoted M or verifier
        uint16 missedSlashBps; // M misses a deadline
        uint16 checkMissedSlashBps; // verifier or T misses a deadline
        uint16 maxMismatch; // tolerated mismatches that still count as Verified
        uint8 numVerifiers; // verifiers per verified job; each covers an even share of the items
    }

    enum Status {
        None,
        Open,
        Committing,
        Deciding,
        Checking,
        CheckReveal,
        Publishing,
        TieBreak,
        Closed
    }

    enum Outcome {
        None,
        Cancelled,
        Delivered,
        Verified,
        MainOutvoted,
        VerifierOutvoted,
        BothOutvoted,
        NoMajority,
        MainMissed,
        TiebreakerMissed,
        TieClientNoShare
    }

    /// Why a job ended up unverified even though it could have been checked.
    enum Drop {
        None,
        ClientNoReveal,
        NoEligibleVerifier
    }

    /// State of one verifier slot.
    enum VState {
        None,
        Assigned, // drawn, waiting for the client to share its range
        Shared, // has its range, computing
        Committed,
        Revealed,
        NoShare, // the client never shared: paid anyway
        BadInput, // reported inputs that don't match dataHash: unpaid, no slash
        Missed, // missed commit or reveal: slashed
        Outvoted // outvoted by the tie-breaker: slashed
    }

    /// Reputation counters this market keeps in the registry. Main providers use the first four,
    /// verifiers and tie-breakers the last three.
    enum Stat {
        VerifiedCompleted,
        UnverifiedCompleted,
        Missed,
        Outvoted,
        ChecksCompleted,
        ChecksMissed,
        ChecksOutvoted
    }

    struct Job {
        address client;
        address main;
        address tiebreaker;
        uint256 taskType;
        uint256 numItems;
        bytes32 dataHash;
        string dataURI;
        bytes32 verifyCommit;
        uint256 price; // numItems * pricePerItem(main), pinned at createJob; deposit = 2 * price
        Status status;
        Outcome outcome;
        Drop drop;
        bool decided; // decision revealed (or defaulted to "no")
        bool verify;
        bool tieShared;
        bool tieSubmitted;
        bool mainOutvoted;
        bytes32 resultsCommit;
        uint64 deadline; // deadline of the current phase
        uint256 slashedPool; // stake slashed for this job and held here until close
        uint256 outvotedMask; // bit per verifier slot: outvoted by T
        uint256 unresolvedMask; // bit per verifier slot: owns a mismatched item with no majority
        address[] verifiers;
        VState[] vstate;
        bytes32[] vcommit;
        uint256[] mismatched; // item indices where M and the owning verifier disagree
        bytes32[] mainMismatchLeaves; // M's leaves on `mismatched`
    }

    Params internal _params;

    uint256 public jobCount; // job ids start at 1
    uint256 public drawNonce; // mixed into every random draw

    mapping(uint256 => bytes32) internal runnerHashes; // task type => keccak of the official runner code
    mapping(uint256 => Job) internal jobs;
    mapping(uint256 => mapping(uint256 => bytes32)) internal checkLeaf; // jobId => item => verifier's leaf

    event JobCreated(
        uint256 indexed jobId,
        address indexed client,
        address indexed main,
        uint256 taskType,
        uint256 numItems,
        bytes32 dataHash,
        string dataURI,
        bytes32 verifyCommit,
        bytes sealedForMain
    );
    event JobAccepted(uint256 indexed jobId);
    event ResultsCommitted(uint256 indexed jobId);
    event DecisionRevealed(uint256 indexed jobId, bool verify);
    event VerificationDropped(uint256 indexed jobId, Drop reason);
    event VerifiersDrawn(uint256 indexed jobId, address[] verifiers);
    event RangeShared(uint256 indexed jobId, uint256 slot, address indexed verifier, bytes sealedForVerifier);
    event CheckCommitted(uint256 indexed jobId, uint256 slot);
    event VerifierDropped(uint256 indexed jobId, uint256 slot, VState reason);
    event CheckRevealed(uint256 indexed jobId, uint256 slot, bytes32[] leaves);
    event ResultsPublished(uint256 indexed jobId, bytes32[] leaves);
    event TiebreakStarted(uint256 indexed jobId, address indexed tiebreaker, uint256[] mismatched);
    event TiebreakShared(uint256 indexed jobId, address indexed tiebreaker, bytes sealedForTiebreaker);
    event TiebreakSubmitted(uint256 indexed jobId, bytes32[] leaves);
    event JobClosed(uint256 indexed jobId, Outcome outcome);

    constructor(address registry_, Params memory p) MarketBase(registry_) {
        require(p.numVerifiers >= 1, "need a verifier");
        _params = p;
    }

    // ------------------------------------------------------------------
    // Setup and views
    // ------------------------------------------------------------------

    function mode() external pure override returns (string memory) {
        return "replicated";
    }

    /// @notice Owner only: add a task type whose official runner code hashes to `runnerHash`.
    function addTaskType(bytes32 runnerHash, string calldata name, uint64 secondsPerItem)
        external
        returns (uint256 id)
    {
        id = _addTaskType(name, secondsPerItem);
        runnerHashes[id] = runnerHash;
    }

    function taskTypeOf(uint256 id)
        external
        view
        returns (bytes32 runnerHash, string memory name, uint64 secondsPerItem)
    {
        TaskInfo storage t = taskInfo[id];
        return (runnerHashes[id], t.name, t.secondsPerItem);
    }

    function getJob(uint256 jobId) external view returns (Job memory) {
        return jobs[jobId];
    }

    function params() external view returns (Params memory) {
        return _params;
    }

    /// Items [start, end) covered by verifier `slot`.
    function rangeOf(uint256 jobId, uint256 slot) public view returns (uint256 start, uint256 end) {
        uint256 n = jobs[jobId].numItems;
        uint256 m = _params.numVerifiers;
        require(slot < m, "bad slot");
        start = (slot * n) / m;
        end = ((slot + 1) * n) / m;
    }

    /// What verifier `slot` earns: its share of the items at M's per-item price.
    function feeOf(uint256 jobId, uint256 slot) public view returns (uint256) {
        (uint256 s, uint256 e) = rangeOf(jobId, slot);
        Job storage j = jobs[jobId];
        return ((e - s) * j.price) / j.numItems;
    }

    function checkLeafOf(uint256 jobId, uint256 i) external view returns (bytes32) {
        return checkLeaf[jobId][i];
    }

    // ------------------------------------------------------------------
    // Open → Committing → Deciding
    // ------------------------------------------------------------------

    function createJob(
        address main,
        uint256 taskType,
        uint256 numItems,
        bytes32 dataHash,
        string calldata dataURI,
        bytes32 verifyCommit,
        bytes calldata sealedForMain
    ) external payable returns (uint256 jobId) {
        _requireTaskType(taskType);
        require(registry.isActive(main), "main not active");
        require(main != msg.sender, "main is client");
        require(numItems >= 1 && numItems <= MAX_ITEMS, "bad numItems");
        require(verifyCommit != 0, "zero verifyCommit");

        // Pin the price from M's current per-item price for this task type. Every job deposits
        // 2 x price (price + a full verification fee), so the deposit says nothing about the decision.
        uint256 price = numItems * _pinPrice(main, taskType);
        require(msg.value == 2 * price, "wrong value");

        jobId = ++jobCount;
        Job storage j = jobs[jobId];
        j.client = msg.sender;
        j.main = main;
        j.taskType = taskType;
        j.numItems = numItems;
        j.dataHash = dataHash;
        j.dataURI = dataURI;
        j.verifyCommit = verifyCommit;
        j.price = price;
        _setPhase(j, Status.Open, _params.acceptWindow);

        emit JobCreated(jobId, msg.sender, main, taskType, numItems, dataHash, dataURI, verifyCommit, sealedForMain);
    }

    /// @notice The client may cancel an Open job at any time; anyone may once the accept deadline passed.
    function cancel(uint256 jobId) external {
        Job storage j = _job(jobId, Status.Open);
        require(msg.sender == j.client || block.timestamp > j.deadline, "not client");
        _close(jobId, Outcome.Cancelled);
    }

    function accept(uint256 jobId) external {
        Job storage j = _job(jobId, Status.Open);
        require(msg.sender == j.main, "not main");
        _beforeDeadline(j);
        require(registry.isActive(j.main), "main not active");
        registry.lock(j.main);
        _setPhase(j, Status.Committing, _params.computeWindow + _taskTime(j.taskType, j.numItems));
        emit JobAccepted(jobId);
    }

    /// @notice M commits to all N leaves: keccak256(abi.encode(bytes32[] leaves)). It does this
    ///         before anyone knows whether the job will be verified.
    function commitResults(uint256 jobId, bytes32 commit) external {
        Job storage j = _job(jobId, Status.Committing);
        require(msg.sender == j.main, "not main");
        _beforeDeadline(j);
        require(commit != 0, "zero commit");
        j.resultsCommit = commit;
        _setPhase(j, Status.Deciding, _params.decideWindow);
        emit ResultsCommitted(jobId);
    }

    /// @notice The client opens its decision: keccak256(abi.encode(bytes32 verifySalt, bool verify)).
    function revealDecision(uint256 jobId, bytes32 verifySalt, bool verify) external {
        Job storage j = _job(jobId, Status.Deciding);
        require(msg.sender == j.client, "not client");
        _beforeDeadline(j);
        require(keccak256(abi.encode(verifySalt, verify)) == j.verifyCommit, "verifyCommit mismatch");
        j.decided = true;
        j.verify = verify;
        emit DecisionRevealed(jobId, verify);
        if (verify) {
            _startChecking(jobId, j);
        } else {
            _setPhase(j, Status.Publishing, _params.publishWindow);
        }
    }

    // ------------------------------------------------------------------
    // Checking → CheckReveal
    // ------------------------------------------------------------------

    /// @notice The client seals verifier `slot`'s item keys to it.
    function shareRange(uint256 jobId, uint256 slot, bytes calldata sealedForVerifier) external {
        Job storage j = _job(jobId, Status.Checking);
        require(msg.sender == j.client, "not client");
        _beforeDeadline(j);
        require(slot < j.verifiers.length, "bad slot");
        require(j.vstate[slot] == VState.Assigned, "already shared");
        j.vstate[slot] = VState.Shared;
        emit RangeShared(jobId, slot, j.verifiers[slot], sealedForVerifier);
    }

    /// @notice A verifier commits to its range: keccak256(abi.encode(bytes32 vSalt, bytes32[] rangeLeaves)).
    function commitCheck(uint256 jobId, bytes32 commit) external {
        Job storage j = _job(jobId, Status.Checking);
        uint256 slot = _slotOf(j, msg.sender);
        _beforeDeadline(j);
        require(j.vstate[slot] == VState.Shared, "not shared");
        require(commit != 0, "zero commit");
        j.vstate[slot] = VState.Committed;
        j.vcommit[slot] = commit;
        emit CheckCommitted(jobId, slot);
        _advanceChecking(j);
    }

    /// @notice A verifier (before committing) or T (after the client shared) says its inputs don't
    ///         match dataHash.
    function reportBadInput(uint256 jobId) external {
        Job storage j = jobs[jobId];
        if (j.status == Status.Checking) {
            uint256 slot = _slotOf(j, msg.sender);
            _beforeDeadline(j);
            require(j.vstate[slot] == VState.Shared, "not shared");
            j.vstate[slot] = VState.BadInput;
            registry.unlock(msg.sender);
            emit VerifierDropped(jobId, slot, VState.BadInput);
            _advanceChecking(j);
        } else if (j.status == Status.TieBreak && msg.sender == j.tiebreaker) {
            _beforeDeadline(j);
            require(j.tieShared, "tie not shared");
            _close(jobId, Outcome.TieClientNoShare);
        } else {
            revert("not allowed");
        }
    }

    /// @notice A verifier opens its commitment; its leaves are stored for the comparison.
    function revealCheck(uint256 jobId, bytes32[] calldata leaves, bytes32 vSalt) external {
        Job storage j = _job(jobId, Status.CheckReveal);
        uint256 slot = _slotOf(j, msg.sender);
        _beforeDeadline(j);
        require(j.vstate[slot] == VState.Committed, "not committed");
        (uint256 s, uint256 e) = rangeOf(jobId, slot);
        require(leaves.length == e - s, "bad length");
        require(keccak256(abi.encode(vSalt, leaves)) == j.vcommit[slot], "checkCommit mismatch");

        mapping(uint256 => bytes32) storage cl = checkLeaf[jobId];
        for (uint256 x = 0; x < leaves.length; x++) {
            cl[s + x] = leaves[x];
        }
        j.vstate[slot] = VState.Revealed;
        emit CheckRevealed(jobId, slot, leaves);
        if (!_anyState(j, VState.Committed)) _setPhase(j, Status.Publishing, _params.publishWindow);
    }

    // ------------------------------------------------------------------
    // Publishing
    // ------------------------------------------------------------------

    /// @notice M publishes all N leaves; they are compared item by item with every revealed range.
    function publishResults(uint256 jobId, bytes32[] calldata leaves) external {
        Job storage j = _job(jobId, Status.Publishing);
        require(msg.sender == j.main, "not main");
        _beforeDeadline(j);
        require(leaves.length == j.numItems, "bad length");
        require(keccak256(abi.encode(leaves)) == j.resultsCommit, "resultsCommit mismatch");
        emit ResultsPublished(jobId, leaves);

        // Count disagreements over every revealed range.
        mapping(uint256 => bytes32) storage cl = checkLeaf[jobId];
        bool anyRevealed = false;
        uint256 count = 0;
        for (uint256 slot = 0; slot < j.verifiers.length; slot++) {
            if (j.vstate[slot] != VState.Revealed) continue;
            anyRevealed = true;
            (uint256 s, uint256 e) = rangeOf(jobId, slot);
            for (uint256 i = s; i < e; i++) {
                if (leaves[i] != cl[i]) count++;
            }
        }
        if (count <= _params.maxMismatch) {
            _close(jobId, anyRevealed ? Outcome.Verified : Outcome.Delivered);
            return;
        }

        // Record the disagreements for the tie-breaker.
        for (uint256 slot = 0; slot < j.verifiers.length; slot++) {
            if (j.vstate[slot] != VState.Revealed) continue;
            (uint256 s, uint256 e) = rangeOf(jobId, slot);
            for (uint256 i = s; i < e; i++) {
                if (leaves[i] != cl[i]) {
                    j.mismatched.push(i);
                    j.mainMismatchLeaves.push(leaves[i]);
                }
            }
        }

        address[] memory ex = new address[](2 + j.verifiers.length);
        ex[0] = j.client;
        ex[1] = j.main;
        for (uint256 slot = 0; slot < j.verifiers.length; slot++) {
            ex[2 + slot] = j.verifiers[slot];
        }
        address t = _draw(jobId, ex, ex.length);
        if (t == address(0)) {
            _markAllUnresolved(j);
            _close(jobId, Outcome.NoMajority);
            return;
        }
        registry.lock(t);
        j.tiebreaker = t;
        _setPhase(j, Status.TieBreak, _params.tiebreakWindow + _taskTime(j.taskType, j.mismatched.length));
        emit TiebreakStarted(jobId, t, j.mismatched);
    }

    // ------------------------------------------------------------------
    // TieBreak
    // ------------------------------------------------------------------

    /// @notice The client seals the mismatched items' keys to T.
    function shareTiebreak(uint256 jobId, bytes calldata sealedForTiebreaker) external {
        Job storage j = _job(jobId, Status.TieBreak);
        require(msg.sender == j.client, "not client");
        _beforeDeadline(j);
        require(!j.tieShared, "already shared");
        j.tieShared = true;
        emit TiebreakShared(jobId, j.tiebreaker, sealedForTiebreaker);
    }

    /// @notice T submits its leaves for the mismatched items (in `mismatched` order); per item the
    ///         majority of {M, owning verifier, T} decides.
    function submitTiebreak(uint256 jobId, bytes32[] calldata leaves) external {
        Job storage j = _job(jobId, Status.TieBreak);
        require(msg.sender == j.tiebreaker, "not tiebreaker");
        _beforeDeadline(j);
        require(j.tieShared, "tie not shared");
        uint256 m = j.mismatched.length;
        require(leaves.length == m, "bad length");

        mapping(uint256 => bytes32) storage cl = checkLeaf[jobId];
        for (uint256 x = 0; x < m; x++) {
            uint256 i = j.mismatched[x];
            uint256 bit = 1 << _slotOfItem(j.numItems, i);
            if (leaves[x] == j.mainMismatchLeaves[x]) {
                j.outvotedMask |= bit; // T agrees with M: the verifier was wrong
            } else if (leaves[x] == cl[i]) {
                j.mainOutvoted = true; // T agrees with the verifier: M was wrong
            } else {
                j.unresolvedMask |= bit; // three different answers
            }
        }
        j.tieSubmitted = true;
        emit TiebreakSubmitted(jobId, leaves);

        Outcome o;
        if (j.mainOutvoted && j.outvotedMask != 0) o = Outcome.BothOutvoted;
        else if (j.mainOutvoted) o = Outcome.MainOutvoted;
        else if (j.outvotedMask != 0) o = Outcome.VerifierOutvoted;
        else o = Outcome.NoMajority;
        _close(jobId, o);
    }

    // ------------------------------------------------------------------
    // Deadlines
    // ------------------------------------------------------------------

    /// @notice Anyone may push a job forward once the current phase's deadline has passed.
    function expire(uint256 jobId) external {
        Job storage j = jobs[jobId];
        Status s = j.status;
        require(s != Status.None && s != Status.Closed, "wrong status");
        require(block.timestamp > j.deadline, "deadline not passed");

        if (s == Status.Open) {
            _close(jobId, Outcome.Cancelled);
        } else if (s == Status.Committing || s == Status.Publishing) {
            _close(jobId, Outcome.MainMissed);
        } else if (s == Status.Deciding) {
            // The client never revealed: the job is treated as unverified.
            j.decided = true;
            j.verify = false;
            j.drop = Drop.ClientNoReveal;
            emit VerificationDropped(jobId, Drop.ClientNoReveal);
            _setPhase(j, Status.Publishing, _params.publishWindow);
        } else if (s == Status.Checking) {
            for (uint256 slot = 0; slot < j.verifiers.length; slot++) {
                if (j.vstate[slot] == VState.Assigned) {
                    j.vstate[slot] = VState.NoShare; // the client's fault: still paid at close
                    emit VerifierDropped(jobId, slot, VState.NoShare);
                } else if (j.vstate[slot] == VState.Shared) {
                    _verifierMissed(jobId, j, slot);
                }
            }
            _advanceChecking(j);
        } else if (s == Status.CheckReveal) {
            for (uint256 slot = 0; slot < j.verifiers.length; slot++) {
                if (j.vstate[slot] == VState.Committed) _verifierMissed(jobId, j, slot);
            }
            _setPhase(j, Status.Publishing, _params.publishWindow);
        } else {
            // TieBreak
            if (j.tieShared) {
                _markAllUnresolved(j);
                _close(jobId, Outcome.TiebreakerMissed);
            } else {
                _close(jobId, Outcome.TieClientNoShare);
            }
        }
    }

    // ------------------------------------------------------------------
    // Internal helpers
    // ------------------------------------------------------------------

    function _job(uint256 jobId, Status s) internal view returns (Job storage j) {
        j = jobs[jobId];
        require(j.status == s, "wrong status");
    }

    function _beforeDeadline(Job storage j) internal view {
        require(block.timestamp <= j.deadline, "deadline passed");
    }

    function _setPhase(Job storage j, Status s, uint64 window) internal {
        j.status = s;
        j.deadline = uint64(block.timestamp) + window;
    }

    /// Slot index of verifier `v` in job `j` (reverts if `v` isn't one of its verifiers).
    function _slotOf(Job storage j, address v) internal view returns (uint256) {
        for (uint256 slot = 0; slot < j.verifiers.length; slot++) {
            if (j.verifiers[slot] == v) return slot;
        }
        revert("not verifier");
    }

    /// The verifier slot whose range contains item i (ranges are [slot*n/m, (slot+1)*n/m)).
    function _slotOfItem(uint256 n, uint256 i) internal view returns (uint256 slot) {
        uint256 m = _params.numVerifiers;
        slot = m - 1;
        while (slot > 0 && (slot * n) / m > i) slot--;
    }

    function _anyState(Job storage j, VState st) internal view returns (bool) {
        for (uint256 slot = 0; slot < j.vstate.length; slot++) {
            if (j.vstate[slot] == st) return true;
        }
        return false;
    }

    /// Draw `numVerifiers` distinct verifiers (excluding client and M); with too few eligible
    /// providers the job continues unverified.
    function _startChecking(uint256 jobId, Job storage j) internal {
        uint256 m = _params.numVerifiers;
        address[] memory ex = new address[](2 + m);
        ex[0] = j.client;
        ex[1] = j.main;
        for (uint256 slot = 0; slot < m; slot++) {
            address v = _draw(jobId, ex, 2 + slot);
            if (v == address(0)) {
                j.drop = Drop.NoEligibleVerifier;
                emit VerificationDropped(jobId, Drop.NoEligibleVerifier);
                _setPhase(j, Status.Publishing, _params.publishWindow);
                return;
            }
            ex[2 + slot] = v;
        }
        address[] memory drawn = new address[](m);
        for (uint256 slot = 0; slot < m; slot++) {
            address v = ex[2 + slot];
            registry.lock(v);
            j.verifiers.push(v);
            j.vstate.push(VState.Assigned);
            j.vcommit.push(bytes32(0));
            drawn[slot] = v;
        }
        uint256 largestRange = (j.numItems + m - 1) / m;
        _setPhase(j, Status.Checking, _params.checkWindow + _taskTime(j.taskType, largestRange));
        emit VerifiersDrawn(jobId, drawn);
    }

    /// Leave Checking once no slot is still waiting for a share or a commit.
    function _advanceChecking(Job storage j) internal {
        if (_anyState(j, VState.Assigned) || _anyState(j, VState.Shared)) return;
        if (_anyState(j, VState.Committed)) _setPhase(j, Status.CheckReveal, _params.revealWindow);
        else _setPhase(j, Status.Publishing, _params.publishWindow);
    }

    /// A verifier missed its commit or reveal: slash it now and hold the slash for the client.
    function _verifierMissed(uint256 jobId, Job storage j, uint256 slot) internal {
        address v = j.verifiers[slot];
        j.vstate[slot] = VState.Missed;
        j.slashedPool += _slash(jobId, v, _params.checkMissedSlashBps);
        _bump(v, Stat.ChecksMissed);
        registry.unlock(v);
        emit VerifierDropped(jobId, slot, VState.Missed);
    }

    /// Every slot that owns a mismatched item is unresolved (no tie-breaker, or T missed).
    function _markAllUnresolved(Job storage j) internal {
        for (uint256 x = 0; x < j.mismatched.length; x++) {
            j.unresolvedMask |= 1 << _slotOfItem(j.numItems, j.mismatched[x]);
        }
    }

    /// Draw a random active provider that offers the job's task type and is not among the first
    /// `nEx` entries of `ex`; address(0) if none.
    function _draw(uint256 jobId, address[] memory ex, uint256 nEx) internal returns (address) {
        uint256 n = registry.providerCount();
        if (n == 0) return address(0);
        uint256 taskType = jobs[jobId].taskType;
        uint256 start =
            uint256(keccak256(abi.encode(block.prevrandao, blockhash(block.number - 1), jobId, ex, drawNonce++))) % n;
        for (uint256 x = 0; x < n; x++) {
            address p = registry.providerAt((start + x) % n);
            bool excluded = false;
            for (uint256 y = 0; y < nEx; y++) {
                if (ex[y] == p) {
                    excluded = true;
                    break;
                }
            }
            if (!excluded && registry.isActive(p) && _priceOf(p, taskType) > 0) return p;
        }
        return address(0);
    }

    function _bump(address p, Stat s) internal {
        registry.bump(p, uint8(s), 1);
    }

    /// Close the job: decide each party's pay or slash, unlock everyone, then push the payouts.
    /// Each party is judged by its own result; the client receives everything left over
    /// (unused deposit plus all slashed stake). See "Settlement on close" in INTERFACE.md.
    function _close(uint256 jobId, Outcome outcome) internal {
        Job storage j = jobs[jobId];
        // effects first: the job can't be acted on again (also guards against reentrancy)
        j.status = Status.Closed;
        j.outcome = outcome;

        uint256 pool = 2 * j.price + j.slashedPool;
        if (outcome == Outcome.Cancelled) {
            _pay(jobId, j.client, pool);
            emit JobClosed(jobId, outcome);
            return;
        }

        // Main provider.
        uint256 mainPay = 0;
        if (outcome == Outcome.MainMissed) {
            pool += _slash(jobId, j.main, _params.missedSlashBps);
            _bump(j.main, Stat.Missed);
        } else if (j.mainOutvoted) {
            pool += _slash(jobId, j.main, _params.wrongSlashBps);
            _bump(j.main, Stat.Outvoted);
        } else if (j.unresolvedMask == 0) {
            mainPay = j.price;
            bool verified = outcome == Outcome.Verified || outcome == Outcome.VerifierOutvoted;
            _bump(j.main, verified ? Stat.VerifiedCompleted : Stat.UnverifiedCompleted);
        }
        registry.unlock(j.main);

        // Verifiers.
        uint256 nv = j.verifiers.length;
        uint256[] memory vPay = new uint256[](nv);
        uint256 vTotal = 0;
        for (uint256 slot = 0; slot < nv; slot++) {
            address v = j.verifiers[slot];
            VState st = j.vstate[slot];
            if (st == VState.BadInput || st == VState.Missed) continue; // already unlocked
            if ((j.outvotedMask >> slot) & 1 == 1) {
                pool += _slash(jobId, v, _params.wrongSlashBps);
                j.vstate[slot] = VState.Outvoted;
                _bump(v, Stat.ChecksOutvoted);
            } else if (st == VState.NoShare) {
                vPay[slot] = feeOf(jobId, slot); // the client never shared: it forfeits this share
            } else if (st == VState.Revealed && (j.unresolvedMask >> slot) & 1 == 0) {
                vPay[slot] = feeOf(jobId, slot);
                _bump(v, Stat.ChecksCompleted);
            }
            vTotal += vPay[slot];
            registry.unlock(v);
        }

        // Tie-breaker.
        uint256 tPay = 0;
        if (j.tiebreaker != address(0)) {
            if (outcome == Outcome.TiebreakerMissed) {
                pool += _slash(jobId, j.tiebreaker, _params.checkMissedSlashBps);
                _bump(j.tiebreaker, Stat.ChecksMissed);
            } else if (j.tieSubmitted) {
                uint256 left = pool - mainPay - vTotal;
                tPay = _params.tiebreakFee < left ? _params.tiebreakFee : left;
                _bump(j.tiebreaker, Stat.ChecksCompleted);
            }
            registry.unlock(j.tiebreaker);
        }

        // Interactions last: main, verifiers, tie-breaker, then the client gets the rest.
        _pay(jobId, j.main, mainPay);
        for (uint256 slot = 0; slot < nv; slot++) {
            _pay(jobId, j.verifiers[slot], vPay[slot]);
        }
        _pay(jobId, j.tiebreaker, tPay);
        _pay(jobId, j.client, pool - mainPay - vTotal - tPay);
        emit JobClosed(jobId, outcome);
    }
}
