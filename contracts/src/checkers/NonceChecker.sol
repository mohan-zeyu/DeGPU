// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IChecker} from "../IChecker.sol";

/// @title NonceChecker
/// @notice Checker for task type `nonce-search-v1` (mining-style proof of work).
///         item   = abi.encode(bytes32 challenge, uint256 target)
///         answer = a 32-byte nonce
///         valid if uint256(keccak256(abi.encode(challenge, nonce))) < target
contract NonceChecker is IChecker {
    function check(bytes calldata item, bytes32 answer) external pure returns (bool) {
        (bytes32 challenge, uint256 target) = abi.decode(item, (bytes32, uint256));
        return uint256(keccak256(abi.encode(challenge, answer))) < target;
    }
}
