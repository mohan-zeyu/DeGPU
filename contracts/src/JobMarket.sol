// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ProviderRegistry} from "./ProviderRegistry.sol";

/// @title JobMarket
/// @notice Batch-inference jobs with optional sampled verification.
///         A client posts a job to a main provider M and pays price + fee into escrow.
///         If the client asked for a sample (sampleSize > 0), a random verifier V re-runs the
///         secret sample. M and V commit, V reveals, M publishes all leaves, and the contract
///         compares the sampled leaves. On a mismatch a random tie-breaker T re-runs only the
///         mismatched items and the majority decides who gets slashed.
/// @dev See docs/INTERFACE.md section 7 for every rule implemented here.
///      Randomness (prevrandao + previous blockhash) is demo-grade; VRF would be the upgrade.
contract JobMarket {
    uint256 public constant MAX_ITEMS = 1000;

    struct Params {
        uint64 acceptWindow;
        uint64 computeWindow;
        uint64 revealWindow;
        uint64 publishWindow;
        uint64 tiebreakWindow;
        uint256 tiebreakFee; // max pay for the tie-breaker
        uint16 wrongSlashBps; // outvoted M or V
        uint16 missedSlashBps; // M misses a deadline
        uint16 checkMissedSlashBps; // V or T misses a deadline
        uint16 maxMismatch; // tolerated sampled mismatches that still count as Verified
    }

    enum Status {
        None,
        Open,
        Committing,
        SampleReveal,
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

    /// Why verification was dropped (the job then finishes as an unverified "Delivered" job).
    enum Drop {
        None,
        NoEligibleVerifier,
        ClientNoShare,
        BadInput,
        VerifierMissed
    }

    struct Job {
        address client;
        address main;
        address verifier;
        address tiebreaker;
        uint256 taskType;
        uint256 numItems;
        uint256 sampleSize;
        bytes32 dataHash;
        string dataURI;
        bytes32 sampleHash;
        uint256 price; // numItems * pricePerItem(main), pinned at createJob
        uint256 fee; // sampleSize * pricePerItem(main), pinned at createJob
        Status status;
        Outcome outcome;
        Drop drop;
        bool sampleShared;
        bool tieShared;
        bytes32 resultsCommit;
        bytes32 sampleCommit;
        uint64 deadline; // deadline of the current phase
        uint256 verifierSlash; // held for the client after a VerifierMissed drop
        uint256[] sampleIndices; // set by revealSample
        bytes32[] verifierLeaves; // set by revealSample
        uint256[] mismatched; // item indices where M and V disagree
        bytes32[] mainMismatchLeaves; // M's leaves on `mismatched`
        bytes32[] verifierMismatchLeaves; // V's leaves on `mismatched`
    }

    struct TaskType {
        bytes32 runnerHash;
        string name;
    }

    ProviderRegistry public immutable registry;
    address public immutable owner;
    Params internal _params;

    uint256 public jobCount; // job ids start at 1
    uint256 public taskTypeCount; // task type ids start at 1
    uint256 public drawNonce; // mixed into every random draw

    mapping(uint256 => TaskType) internal taskTypes;
    mapping(uint256 => Job) internal jobs;

    event JobCreated(
        uint256 indexed jobId,
        address indexed client,
        address indexed main,
        uint256 taskType,
        uint256 numItems,
        uint256 sampleSize,
        bytes32 dataHash,
        string dataURI,
        bytes sealedForMain
    );
    event JobAccepted(uint256 indexed jobId, address verifier);
    event VerificationDropped(uint256 indexed jobId, Drop reason);
    event SampleShared(uint256 indexed jobId, address indexed verifier, bytes sealedForVerifier);
    event ResultsCommitted(uint256 indexed jobId);
    event SampleCommitted(uint256 indexed jobId);
    event SampleRevealed(uint256 indexed jobId, uint256[] indices, bytes32[] leaves);
    event ResultsPublished(uint256 indexed jobId, bytes32[] leaves);
    event TiebreakStarted(uint256 indexed jobId, address indexed tiebreaker, uint256[] mismatched);
    event TiebreakShared(uint256 indexed jobId, address indexed tiebreaker, bytes sealedForTiebreaker);
    event TiebreakSubmitted(uint256 indexed jobId, bytes32[] leaves);
    event JobClosed(uint256 indexed jobId, Outcome outcome);
    event Payout(uint256 indexed jobId, address indexed to, uint256 amount);
    event ProviderSlashed(uint256 indexed jobId, address indexed provider, uint256 amount);

    constructor(address registry_, Params memory p) {
        owner = msg.sender;
        registry = ProviderRegistry(registry_);
        _params = p;
    }

    /// Slashed stake arrives here from the registry; nobody else may send ETH directly.
    receive() external payable {
        require(msg.sender == address(registry), "only registry");
    }

    // ------------------------------------------------------------------
    // Setup and views
    // ------------------------------------------------------------------

    function addTaskType(bytes32 runnerHash, string calldata name) external returns (uint256 id) {
        require(msg.sender == owner, "not owner");
        id = ++taskTypeCount;
        taskTypes[id] = TaskType(runnerHash, name);
    }

    function taskTypeOf(uint256 id) external view returns (bytes32 runnerHash, string memory name) {
        TaskType storage t = taskTypes[id];
        return (t.runnerHash, t.name);
    }

    function getJob(uint256 jobId) external view returns (Job memory) {
        return jobs[jobId];
    }

    function params() external view returns (Params memory) {
        return _params;
    }

    // ------------------------------------------------------------------
    // Open
    // ------------------------------------------------------------------

    function createJob(
        address main,
        uint256 taskType,
        uint256 numItems,
        bytes32 dataHash,
        string calldata dataURI,
        uint256 sampleSize,
        bytes32 sampleHash,
        bytes calldata sealedForMain
    ) external payable returns (uint256 jobId) {
        require(taskType >= 1 && taskType <= taskTypeCount, "unknown task type");
        require(registry.isActive(main), "main not active");
        require(main != msg.sender, "main is client");
        require(numItems >= 1 && numItems <= MAX_ITEMS, "bad numItems");
        require(sampleSize <= numItems, "sampleSize > numItems");

        // Pin price and fee from the main provider's current per-item price.
        (,,, uint256 pricePerItem,) = registry.getProvider(main);
        uint256 price = numItems * pricePerItem;
        uint256 fee = sampleSize * pricePerItem;
        require(msg.value == price + fee, "wrong value");

        jobId = ++jobCount;
        Job storage j = jobs[jobId];
        j.client = msg.sender;
        j.main = main;
        j.taskType = taskType;
        j.numItems = numItems;
        j.sampleSize = sampleSize;
        j.dataHash = dataHash;
        j.dataURI = dataURI;
        j.sampleHash = sampleHash;
        j.price = price;
        j.fee = fee;
        _setPhase(j, Status.Open, _params.acceptWindow);

        emit JobCreated(jobId, msg.sender, main, taskType, numItems, sampleSize, dataHash, dataURI, sealedForMain);
    }

    /// @notice The client may cancel an Open job at any time; anyone may once the accept deadline passed.
    function cancel(uint256 jobId) external {
        Job storage j = _job(jobId, Status.Open);
        require(msg.sender == j.client || block.timestamp > j.deadline, "not client");
        _close(jobId, Outcome.Cancelled);
    }

    /// @notice M takes the job. If a sample was requested, a verifier is drawn right away.
    function accept(uint256 jobId) external {
        Job storage j = _job(jobId, Status.Open);
        require(msg.sender == j.main, "not main");
        _beforeDeadline(j);
        require(registry.isActive(j.main), "main not active");

        registry.lock(j.main);
        bool dropped = false;
        if (j.sampleSize > 0) {
            address v = _draw(jobId, j.client, j.main, address(0));
            if (v != address(0)) {
                registry.lock(v);
                j.verifier = v;
                _setPhase(j, Status.Committing, _params.computeWindow);
            } else {
                dropped = true;
            }
        }
        if (j.verifier == address(0)) {
            // unverified job (k = 0) or nobody could verify: M publishes directly
            _setPhase(j, Status.Publishing, _params.computeWindow);
        }
        emit JobAccepted(jobId, j.verifier);
        if (dropped) _drop(jobId, j, Drop.NoEligibleVerifier);
    }

    // ------------------------------------------------------------------
    // Committing
    // ------------------------------------------------------------------

    /// @notice The client seals the sample's keys and indices to V.
    function shareSample(uint256 jobId, bytes calldata sealedForVerifier) external {
        Job storage j = _job(jobId, Status.Committing);
        require(msg.sender == j.client, "not client");
        _beforeDeadline(j);
        require(!j.sampleShared, "already shared");
        j.sampleShared = true;
        emit SampleShared(jobId, j.verifier, sealedForVerifier);
    }

    /// @notice M commits to all N leaves: keccak256(abi.encode(bytes32[] leaves)).
    function commitResults(uint256 jobId, bytes32 commit) external {
        Job storage j = _job(jobId, Status.Committing);
        require(msg.sender == j.main, "not main");
        _beforeDeadline(j);
        require(j.resultsCommit == 0, "already committed");
        require(commit != 0, "zero commit");
        j.resultsCommit = commit;
        emit ResultsCommitted(jobId);
        _advanceIfBothCommitted(j);
    }

    /// @notice V commits to its sample leaves: keccak256(abi.encode(bytes32 vSalt, bytes32[] sampleLeaves)).
    function commitSample(uint256 jobId, bytes32 commit) external {
        Job storage j = _job(jobId, Status.Committing);
        require(msg.sender == j.verifier, "not verifier");
        _beforeDeadline(j);
        require(j.sampleShared, "sample not shared");
        require(j.sampleCommit == 0, "already committed");
        require(commit != 0, "zero commit");
        j.sampleCommit = commit;
        emit SampleCommitted(jobId);
        _advanceIfBothCommitted(j);
    }

    /// @notice V (before committing) or T (after the client shared) says its inputs don't match dataHash.
    function reportBadInput(uint256 jobId) external {
        Job storage j = jobs[jobId];
        if (j.status == Status.Committing && msg.sender == j.verifier) {
            _beforeDeadline(j);
            require(j.sampleShared, "sample not shared");
            require(j.sampleCommit == 0, "already committed");
            _drop(jobId, j, Drop.BadInput);
            registry.unlock(j.verifier);
            _setPhase(j, Status.Publishing, _params.computeWindow);
        } else if (j.status == Status.TieBreak && msg.sender == j.tiebreaker) {
            _beforeDeadline(j);
            require(j.tieShared, "tie not shared");
            _close(jobId, Outcome.TieClientNoShare);
        } else {
            revert("not allowed");
        }
    }

    // ------------------------------------------------------------------
    // SampleReveal
    // ------------------------------------------------------------------

    /// @notice V opens both the client's sample commitment and its own sample commitment.
    function revealSample(
        uint256 jobId,
        uint256[] calldata indices,
        bytes32 sampleSalt,
        bytes32[] calldata leaves,
        bytes32 vSalt
    ) external {
        Job storage j = _job(jobId, Status.SampleReveal);
        require(msg.sender == j.verifier, "not verifier");
        _beforeDeadline(j);

        uint256 k = j.sampleSize;
        require(indices.length == k && leaves.length == k, "bad length");
        require(keccak256(abi.encode(sampleSalt, indices)) == j.sampleHash, "sampleHash mismatch");
        for (uint256 x = 1; x < k; x++) {
            require(indices[x - 1] < indices[x], "indices not increasing");
        }
        require(indices[k - 1] < j.numItems, "index out of range");
        require(keccak256(abi.encode(vSalt, leaves)) == j.sampleCommit, "sampleCommit mismatch");

        j.sampleIndices = indices;
        j.verifierLeaves = leaves;
        _setPhase(j, Status.Publishing, _params.publishWindow);
        emit SampleRevealed(jobId, indices, leaves);
    }

    // ------------------------------------------------------------------
    // Publishing
    // ------------------------------------------------------------------

    /// @notice M publishes all N leaves. With a revealed sample they are compared to V's leaves.
    function publishResults(uint256 jobId, bytes32[] calldata leaves) external {
        Job storage j = _job(jobId, Status.Publishing);
        require(msg.sender == j.main, "not main");
        _beforeDeadline(j);
        require(leaves.length == j.numItems, "bad length");
        if (j.resultsCommit != 0) {
            require(keccak256(abi.encode(leaves)) == j.resultsCommit, "resultsCommit mismatch");
        }
        emit ResultsPublished(jobId, leaves);

        // No verification (k = 0, or verification was dropped): plain delivery.
        if (j.drop != Drop.None || j.verifierLeaves.length == 0) {
            _close(jobId, Outcome.Delivered);
            return;
        }

        // Compare M's leaves with V's on the sampled indices.
        uint256[] memory idx = j.sampleIndices;
        bytes32[] memory vLeaves = j.verifierLeaves;
        uint256 k = idx.length;
        uint256 count = 0;
        for (uint256 x = 0; x < k; x++) {
            if (leaves[idx[x]] != vLeaves[x]) count++;
        }
        if (count <= _params.maxMismatch) {
            _close(jobId, Outcome.Verified);
            return;
        }

        // Record the disagreements for the tie-breaker.
        uint256[] memory mis = new uint256[](count);
        bytes32[] memory mLeaves = new bytes32[](count);
        bytes32[] memory vMis = new bytes32[](count);
        uint256 m = 0;
        for (uint256 x = 0; x < k; x++) {
            uint256 i = idx[x];
            if (leaves[i] != vLeaves[x]) {
                mis[m] = i;
                mLeaves[m] = leaves[i];
                vMis[m] = vLeaves[x];
                m++;
            }
        }
        j.mismatched = mis;
        j.mainMismatchLeaves = mLeaves;
        j.verifierMismatchLeaves = vMis;

        address t = _draw(jobId, j.client, j.main, j.verifier);
        if (t == address(0)) {
            _close(jobId, Outcome.NoMajority);
            return;
        }
        registry.lock(t);
        j.tiebreaker = t;
        _setPhase(j, Status.TieBreak, _params.tiebreakWindow);
        emit TiebreakStarted(jobId, t, mis);
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

    /// @notice T submits its leaves for the mismatched items (in `mismatched` order); the majority decides.
    function submitTiebreak(uint256 jobId, bytes32[] calldata leaves) external {
        Job storage j = _job(jobId, Status.TieBreak);
        require(msg.sender == j.tiebreaker, "not tiebreaker");
        _beforeDeadline(j);
        require(j.tieShared, "tie not shared");
        uint256 m = j.mismatched.length;
        require(leaves.length == m, "bad length");

        bool mainOut = false;
        bool verifierOut = false;
        for (uint256 x = 0; x < m; x++) {
            if (leaves[x] == j.mainMismatchLeaves[x]) {
                verifierOut = true; // T agrees with M
            } else if (leaves[x] == j.verifierMismatchLeaves[x]) {
                mainOut = true; // T agrees with V
            }
            // else: three different answers, no majority on this item
        }
        emit TiebreakSubmitted(jobId, leaves);

        Outcome o;
        if (mainOut && verifierOut) o = Outcome.BothOutvoted;
        else if (mainOut) o = Outcome.MainOutvoted;
        else if (verifierOut) o = Outcome.VerifierOutvoted;
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
        } else if (s == Status.Committing) {
            if (j.resultsCommit == 0) {
                _close(jobId, Outcome.MainMissed);
            } else if (!j.sampleShared) {
                _drop(jobId, j, Drop.ClientNoShare); // V stays locked: it is owed the fee
                _setPhase(j, Status.Publishing, _params.publishWindow);
            } else {
                _verifierMissed(jobId, j);
            }
        } else if (s == Status.SampleReveal) {
            _verifierMissed(jobId, j);
        } else if (s == Status.Publishing) {
            _close(jobId, Outcome.MainMissed);
        } else {
            // TieBreak
            _close(jobId, j.tieShared ? Outcome.TiebreakerMissed : Outcome.TieClientNoShare);
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

    function _drop(uint256 jobId, Job storage j, Drop reason) internal {
        j.drop = reason;
        emit VerificationDropped(jobId, reason);
    }

    function _advanceIfBothCommitted(Job storage j) internal {
        if (j.resultsCommit != 0 && j.sampleCommit != 0) {
            _setPhase(j, Status.SampleReveal, _params.revealWindow);
        }
    }

    /// V missed a deadline: slash it, hold the slash for the client, and continue unverified.
    function _verifierMissed(uint256 jobId, Job storage j) internal {
        _drop(jobId, j, Drop.VerifierMissed);
        j.verifierSlash = _slash(jobId, j.verifier, _params.checkMissedSlashBps);
        registry.bump(j.verifier, ProviderRegistry.Stat.ChecksMissed);
        registry.unlock(j.verifier);
        _setPhase(j, Status.Publishing, _params.publishWindow);
    }

    /// Draw a random active provider that is none of ex1..ex3; address(0) if there is none.
    function _draw(uint256 jobId, address ex1, address ex2, address ex3) internal returns (address) {
        uint256 n = registry.providerCount();
        if (n == 0) return address(0);
        uint256 start = uint256(
            keccak256(abi.encode(block.prevrandao, blockhash(block.number - 1), jobId, ex1, ex2, ex3, drawNonce++))
        ) % n;
        for (uint256 x = 0; x < n; x++) {
            address p = registry.providerAt((start + x) % n);
            if (p != ex1 && p != ex2 && p != ex3 && registry.isActive(p)) return p;
        }
        return address(0);
    }

    function _slash(uint256 jobId, address p, uint256 bps) internal returns (uint256 amount) {
        amount = registry.slash(p, bps); // the registry sends `amount` wei to this contract
        emit ProviderSlashed(jobId, p, amount);
    }

    function _bump(address p, ProviderRegistry.Stat s) internal {
        registry.bump(p, s);
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    /// Who receives what when a job closes (amounts in wei).
    struct Pay {
        uint256 client;
        uint256 main;
        uint256 verifier;
        uint256 tiebreaker;
    }

    /// Close the job: slash, bump stats, unlock participants, then push the payouts.
    function _close(uint256 jobId, Outcome outcome) internal {
        Job storage j = jobs[jobId];
        // effects first: the job can't be acted on again (also guards against reentrancy)
        j.status = Status.Closed;
        j.outcome = outcome;

        Pay memory pay = _settle(jobId, j, outcome);
        _unlockAll(j, outcome);

        // interactions last
        _pay(jobId, j.client, pay.client);
        _pay(jobId, j.main, pay.main);
        _pay(jobId, j.verifier, pay.verifier);
        _pay(jobId, j.tiebreaker, pay.tiebreaker);
        emit JobClosed(jobId, outcome);
    }

    /// The "Settlement on close" table of INTERFACE.md section 7.
    function _settle(uint256 jobId, Job storage j, Outcome outcome) internal returns (Pay memory pay) {
        uint256 price = j.price;
        uint256 fee = j.fee;
        uint256 tiebreakFee = _params.tiebreakFee;

        if (outcome == Outcome.Cancelled) {
            pay.client = price + fee;
        } else if (outcome == Outcome.Delivered) {
            pay.main = price;
            if (j.drop == Drop.ClientNoShare) {
                pay.verifier = fee; // the client forfeits the fee to V
            } else {
                // NoEligibleVerifier, BadInput, VerifierMissed (with V's slash) or no sample (fee 0)
                pay.client = fee + j.verifierSlash;
            }
            _bump(j.main, ProviderRegistry.Stat.UnverifiedCompleted);
        } else if (outcome == Outcome.Verified) {
            pay.main = price;
            pay.verifier = fee;
            _bump(j.main, ProviderRegistry.Stat.VerifiedCompleted);
            _bump(j.verifier, ProviderRegistry.Stat.ChecksCompleted);
        } else if (outcome == Outcome.MainOutvoted) {
            uint256 sM = _slash(jobId, j.main, _params.wrongSlashBps);
            uint256 tf = _min(sM, tiebreakFee);
            pay.client = price + sM - tf;
            pay.verifier = fee;
            pay.tiebreaker = tf;
            _bump(j.main, ProviderRegistry.Stat.Outvoted);
            _bump(j.verifier, ProviderRegistry.Stat.ChecksCompleted);
            _bump(j.tiebreaker, ProviderRegistry.Stat.ChecksCompleted);
        } else if (outcome == Outcome.VerifierOutvoted) {
            uint256 sV = _slash(jobId, j.verifier, _params.wrongSlashBps);
            uint256 tf = _min(sV, tiebreakFee);
            pay.main = price + sV - tf;
            pay.client = fee;
            pay.tiebreaker = tf;
            _bump(j.main, ProviderRegistry.Stat.VerifiedCompleted);
            _bump(j.verifier, ProviderRegistry.Stat.ChecksOutvoted);
            _bump(j.tiebreaker, ProviderRegistry.Stat.ChecksCompleted);
        } else if (outcome == Outcome.BothOutvoted) {
            uint256 sM = _slash(jobId, j.main, _params.wrongSlashBps);
            uint256 sV = _slash(jobId, j.verifier, _params.wrongSlashBps);
            uint256 tf = _min(sM + sV, tiebreakFee);
            pay.client = price + fee + sM + sV - tf;
            pay.tiebreaker = tf;
            _bump(j.main, ProviderRegistry.Stat.Outvoted);
            _bump(j.verifier, ProviderRegistry.Stat.ChecksOutvoted);
            _bump(j.tiebreaker, ProviderRegistry.Stat.ChecksCompleted);
        } else if (outcome == Outcome.NoMajority) {
            uint256 tf = j.tiebreaker != address(0) ? _min(fee, tiebreakFee) : 0;
            pay.client = price + fee - tf;
            pay.tiebreaker = tf;
            if (j.tiebreaker != address(0)) _bump(j.tiebreaker, ProviderRegistry.Stat.ChecksCompleted);
        } else if (outcome == Outcome.MainMissed) {
            uint256 sM = _slash(jobId, j.main, _params.missedSlashBps);
            // V is paid from M's slash only if it finished its part (committed and was not dropped).
            bool vFinished = j.sampleCommit != 0 && j.drop == Drop.None;
            uint256 vPay = vFinished ? _min(sM, fee) : 0;
            pay.verifier = vPay;
            // verifierSlash is non-zero only after a VerifierMissed drop; it belongs to the client.
            pay.client = price + fee + sM - vPay + j.verifierSlash;
            _bump(j.main, ProviderRegistry.Stat.Missed);
            if (vFinished) _bump(j.verifier, ProviderRegistry.Stat.ChecksCompleted);
        } else if (outcome == Outcome.TiebreakerMissed) {
            uint256 sT = _slash(jobId, j.tiebreaker, _params.checkMissedSlashBps);
            pay.client = price + fee + sT;
            _bump(j.tiebreaker, ProviderRegistry.Stat.ChecksMissed);
        } else if (outcome == Outcome.TieClientNoShare) {
            pay.main = price;
            pay.verifier = fee;
            _bump(j.main, ProviderRegistry.Stat.UnverifiedCompleted);
            _bump(j.verifier, ProviderRegistry.Stat.ChecksCompleted);
        }
    }

    /// Unlock every participant that is still locked by this job.
    function _unlockAll(Job storage j, Outcome outcome) internal {
        // M is locked from accept on; only a Cancelled job was never accepted.
        if (outcome != Outcome.Cancelled) registry.unlock(j.main);
        // V was already unlocked when verification was dropped for BadInput or VerifierMissed.
        if (j.verifier != address(0) && j.drop != Drop.BadInput && j.drop != Drop.VerifierMissed) {
            registry.unlock(j.verifier);
        }
        if (j.tiebreaker != address(0)) registry.unlock(j.tiebreaker);
    }

    /// Push `amount` wei to `to` (skipped when zero) and log it.
    function _pay(uint256 jobId, address to, uint256 amount) internal {
        if (amount == 0) return;
        emit Payout(jobId, to, amount);
        (bool ok,) = to.call{value: amount}("");
        require(ok, "payout failed");
    }
}
