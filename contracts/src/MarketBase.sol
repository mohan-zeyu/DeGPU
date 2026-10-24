// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ProviderRegistry} from "./ProviderRegistry.sol";

/// @title MarketBase
/// @notice What every DeGPU market shares, whatever its verification mode: the link to the
///         ProviderRegistry, the owner, a table of task types (name and time budget per item),
///         price pinning from the registry, slashing and push payouts. A concrete market adds its
///         own per-task data (a runner hash, a checker contract...) and its own job state machine.
/// @dev See docs/INTERFACE.md section 7 and docs/ADDING_A_JOB_TYPE.md.
abstract contract MarketBase {
    struct TaskInfo {
        string name;
        uint64 secondsPerItem; // added to the work deadlines, per item a phase must process
    }

    ProviderRegistry public immutable registry;
    address public immutable owner;

    uint256 public taskTypeCount; // task type ids start at 1
    mapping(uint256 => TaskInfo) internal taskInfo;

    event TaskTypeAdded(uint256 indexed taskType, string name, uint64 secondsPerItem);
    event Payout(uint256 indexed jobId, address indexed to, uint256 amount);
    event ProviderSlashed(uint256 indexed jobId, address indexed provider, uint256 amount);

    constructor(address registry_) {
        owner = msg.sender;
        registry = ProviderRegistry(registry_);
    }

    /// Slashed stake arrives here from the registry; nobody else may send ETH directly.
    receive() external payable {
        require(msg.sender == address(registry), "only registry");
    }

    /// The verification mode this market implements ("replicated", "checked", ...). Off-chain
    /// code finds every market through the registry and picks its driver by this name.
    function mode() external pure virtual returns (string memory);

    // ------------------------------------------------------------------
    // Task types
    // ------------------------------------------------------------------

    /// Owner only: append a task type; the concrete market stores its own extra data under `id`.
    function _addTaskType(string calldata name, uint64 secondsPerItem) internal returns (uint256 id) {
        require(msg.sender == owner, "not owner");
        id = ++taskTypeCount;
        taskInfo[id] = TaskInfo(name, secondsPerItem);
        emit TaskTypeAdded(id, name, secondsPerItem);
    }

    function _requireTaskType(uint256 taskType) internal view {
        require(taskType >= 1 && taskType <= taskTypeCount, "unknown task type");
    }

    /// Extra time a phase gets for processing `items` items of `taskType`.
    function _taskTime(uint256 taskType, uint256 items) internal view returns (uint64) {
        return uint64(items) * taskInfo[taskType].secondsPerItem;
    }

    // ------------------------------------------------------------------
    // Prices and offers (kept in the registry, per market and task type)
    // ------------------------------------------------------------------

    /// Wei per item `p` charges for `taskType` in this market (0 = not offered).
    function _priceOf(address p, uint256 taskType) internal view returns (uint256) {
        return registry.priceOf(p, address(this), taskType);
    }

    /// Price per item of `main` for `taskType`; reverts if `main` doesn't offer it.
    function _pinPrice(address main, uint256 taskType) internal view returns (uint256 pricePerItem) {
        pricePerItem = _priceOf(main, taskType);
        require(pricePerItem > 0, "main does not offer task");
    }

    // ------------------------------------------------------------------
    // Money
    // ------------------------------------------------------------------

    function _slash(uint256 jobId, address p, uint256 bps) internal returns (uint256 amount) {
        amount = registry.slash(p, bps); // the registry sends `amount` wei to this contract
        emit ProviderSlashed(jobId, p, amount);
    }

    /// Push `amount` wei to `to` (skipped when zero) and log it.
    function _pay(uint256 jobId, address to, uint256 amount) internal {
        if (amount == 0) return;
        emit Payout(jobId, to, amount);
        (bool ok,) = to.call{value: amount}("");
        require(ok, "payout failed");
    }
}
