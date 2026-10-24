// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {KeySearchChecker} from "../src/checkers/KeySearchChecker.sol";

/// @notice Golden vectors for key-search-v1, shared with tests/test_key_search.py.
contract KeySearchCheckerTest is Test {
    bytes32 constant KEY_HASH_42 = 0xbeced09521047d05b8960b7e7bcc1d1292cf3e4b2a6b63f48335cbde5f7545d2;

    function test_KeySearchChecker_Golden() public {
        KeySearchChecker checker = new KeySearchChecker();
        assertEq(keccak256(abi.encode(uint256(42))), KEY_HASH_42);
        bytes memory item = abi.encode(KEY_HASH_42, uint256(0), uint256(100));
        assertTrue(checker.check(item, bytes32(uint256(42))));
        assertFalse(checker.check(item, bytes32(uint256(41))));
        // the right key, but outside the range
        assertFalse(checker.check(abi.encode(KEY_HASH_42, uint256(43), uint256(100)), bytes32(uint256(42))));
    }
}
