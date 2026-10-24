// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {MarketBase} from "./MarketBase.sol";
import {IChecker} from "./IChecker.sol";

/// @title CheckedMarket
/// @notice The "checked" verification mode: every answer is verified on-chain by the task type's
///         checker contract, so no other provider has to re-run anything. Fits puzzles that are
///         hard to solve and cheap to check (mining-style nonce search, key search...).
///         A client posts N items to a main provider M and deposits N x price. M accepts, solves
///         what it can and submits one answer per item, marking the items it could not solve.
///         The contract checks every answer it is given: a single wrong answer reverts the whole
///         submission, so a wrong answer is never accepted. M is paid per solved item and the
///         client gets the rest back. "Not found" is never slashed (it can't be proven false in
///         general); M simply isn't paid for that item.
/// @dev See docs/INTERFACE.md section 8.
contract CheckedMarket is MarketBase {
    uint256 public constant MAX_ITEMS = 1000;

    struct Params {
        uint64 acceptWindow;
        uint64 workWindow; // M must submit within this (+ the task's time for N items) after accept
        uint16 missedSlashBps; // M misses a deadline
    }

    enum Status {
        None,
        Open,
        Working,
        Closed
    }

    enum Outcome {
        None,
        Cancelled,
        Delivered,
        MainMissed
    }

    /// Reputation counters this market keeps in the registry.
    enum Stat {
        Completed,
        Missed,
        ItemsSolved,
        ItemsNotFound
    }

    struct Job {
        address client;
        address main;
        uint256 taskType;
        uint256 numItems;
        bytes32 itemsHash; // keccak256(abi.encode(bytes[] items))
        uint256 pricePerItem; // M's price, pinned at createJob; deposit = numItems * pricePerItem
        Status status;
        Outcome outcome;
        uint64 deadline; // deadline of the current phase
        uint256 solved; // items M submitted a (valid) answer for
    }

    Params internal _params;
    uint256 public jobCount; // job ids start at 1

    mapping(uint256 => IChecker) internal checkers; // task type => its checker
    mapping(uint256 => Job) internal jobs;

    event JobCreated(
        uint256 indexed jobId, address indexed client, address indexed main, uint256 taskType, bytes[] items
    );
    event JobAccepted(uint256 indexed jobId);
    event ResultsSubmitted(uint256 indexed jobId, bytes32[] answers, bool[] found);
    event JobClosed(uint256 indexed jobId, Outcome outcome);

    constructor(address registry_, Params memory p) MarketBase(registry_) {
        _params = p;
    }

    // ------------------------------------------------------------------
    // Setup and views
    // ------------------------------------------------------------------

    function mode() external pure override returns (string memory) {
        return "checked";
    }

    /// @notice Owner only: add a task type whose answers `checker` verifies.
    function addTaskType(IChecker checker, string calldata name, uint64 secondsPerItem)
        external
        returns (uint256 id)
    {
        require(address(checker) != address(0), "zero checker");
        id = _addTaskType(name, secondsPerItem);
        checkers[id] = checker;
    }

    function taskTypeOf(uint256 id)
        external
        view
        returns (address checker, string memory name, uint64 secondsPerItem)
    {
        TaskInfo storage t = taskInfo[id];
        return (address(checkers[id]), t.name, t.secondsPerItem);
    }

    function getJob(uint256 jobId) external view returns (Job memory) {
        return jobs[jobId];
    }

    function params() external view returns (Params memory) {
        return _params;
    }

    // ------------------------------------------------------------------
    // Open → Working → Closed
    // ------------------------------------------------------------------

    /// @notice Post `items` (layout defined by the task type) to `main`; deposit N x main's price.
    ///         The items are public: they are emitted in JobCreated and only their hash is stored.
    function createJob(address main, uint256 taskType, bytes[] calldata items)
        external
        payable
        returns (uint256 jobId)
    {
        _requireTaskType(taskType);
        require(registry.isActive(main), "main not active");
        require(main != msg.sender, "main is client");
        require(items.length >= 1 && items.length <= MAX_ITEMS, "bad numItems");
        uint256 pricePerItem = _pinPrice(main, taskType);
        require(msg.value == items.length * pricePerItem, "wrong value");

        jobId = ++jobCount;
        Job storage j = jobs[jobId];
        j.client = msg.sender;
        j.main = main;
        j.taskType = taskType;
        j.numItems = items.length;
        j.itemsHash = keccak256(abi.encode(items));
        j.pricePerItem = pricePerItem;
        _setPhase(j, Status.Open, _params.acceptWindow);
        emit JobCreated(jobId, msg.sender, main, taskType, items);
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
        _setPhase(j, Status.Working, _params.workWindow + _taskTime(j.taskType, j.numItems));
        emit JobAccepted(jobId);
    }

    /// @notice M submits one answer per item; `found[i] == false` means "no solution found" for item i
    ///         (its answer is ignored). Every found answer must pass the checker, or this reverts.
    function submitResults(uint256 jobId, bytes[] calldata items, bytes32[] calldata answers, bool[] calldata found)
        external
    {
        Job storage j = _job(jobId, Status.Working);
        require(msg.sender == j.main, "not main");
        _beforeDeadline(j);
        uint256 n = j.numItems;
        require(items.length == n && answers.length == n && found.length == n, "bad length");
        require(keccak256(abi.encode(items)) == j.itemsHash, "items mismatch");

        IChecker checker = checkers[j.taskType];
        uint256 solved = 0;
        for (uint256 i = 0; i < n; i++) {
            if (!found[i]) continue;
            require(checker.check(items[i], answers[i]), "invalid answer");
            solved++;
        }
        j.solved = solved;
        emit ResultsSubmitted(jobId, answers, found);
        _close(jobId, Outcome.Delivered);
    }

    /// @notice Anyone may close a job once its current deadline passed: Open → Cancelled,
    ///         Working → MainMissed (M slashed, the client refunded in full).
    function expire(uint256 jobId) external {
        Job storage j = jobs[jobId];
        require(j.status == Status.Open || j.status == Status.Working, "wrong status");
        require(block.timestamp > j.deadline, "deadline not passed");
        _close(jobId, j.status == Status.Open ? Outcome.Cancelled : Outcome.MainMissed);
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

    function _bump(address p, Stat s, uint256 amount) internal {
        if (amount > 0) registry.bump(p, uint8(s), amount);
    }

    /// Close the job: M is paid per solved item (or slashed if it missed), the client gets the rest.
    function _close(uint256 jobId, Outcome outcome) internal {
        Job storage j = jobs[jobId];
        bool accepted = j.status == Status.Working; // M is locked only after accept
        // effects first: the job can't be acted on again (also guards against reentrancy)
        j.status = Status.Closed;
        j.outcome = outcome;

        uint256 pool = j.numItems * j.pricePerItem;
        uint256 mainPay = 0;
        if (accepted) {
            if (outcome == Outcome.MainMissed) {
                pool += _slash(jobId, j.main, _params.missedSlashBps);
                _bump(j.main, Stat.Missed, 1);
            } else {
                mainPay = j.solved * j.pricePerItem;
                _bump(j.main, Stat.Completed, 1);
                _bump(j.main, Stat.ItemsSolved, j.solved);
                _bump(j.main, Stat.ItemsNotFound, j.numItems - j.solved);
            }
            registry.unlock(j.main);
        }

        // Interactions last: M, then the client gets the rest.
        _pay(jobId, j.main, mainPay);
        _pay(jobId, j.client, pool - mainPay);
        emit JobClosed(jobId, outcome);
    }
}
