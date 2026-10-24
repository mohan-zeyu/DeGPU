// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IChecker} from "../IChecker.sol";

/// @title KeySearchChecker
/// @notice Checker for task type `key-search-v1` (brute-force a key hidden in a range).
///         item   = abi.encode(bytes32 keyHash, uint256 lo, uint256 hi)
///         answer = the key k as a uint256
///         valid if lo <= k < hi and keccak256(abi.encode(k)) == keyHash
contract KeySearchChecker is IChecker {
    function check(bytes calldata item, bytes32 answer) external pure returns (bool) {
        (bytes32 keyHash, uint256 lo, uint256 hi) = abi.decode(item, (bytes32, uint256, uint256));
        uint256 key = uint256(answer);
        return key >= lo && key < hi && keccak256(abi.encode(key)) == keyHash;
    }
}
