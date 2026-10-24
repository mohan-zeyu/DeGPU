// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IChecker
/// @notice One checker contract per task type of the CheckedMarket: it decides whether an answer
///         solves an item. Items and answers are opaque to the market; only the checker knows
///         their layout (documented next to the task in degpu/tasks/<task>/).
interface IChecker {
    /// @notice True if `answer` solves `item`. Must be deterministic and cheap: the market calls it
    ///         once per submitted answer, all inside one transaction.
    function check(bytes calldata item, bytes32 answer) external view returns (bool);
}
