// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {DeGPUBase} from "./DeGPUBase.t.sol";
import {ReplicatedMarket} from "../src/ReplicatedMarket.sol";

/// @notice Golden vectors of INTERFACE.md (v2) section 2. The Python tests check the same values.
contract EncodingTest is DeGPUBase {
    bytes32 constant S11 = 0x1111111111111111111111111111111111111111111111111111111111111111;
    bytes32 constant S33 = 0x3333333333333333333333333333333333333333333333333333333333333333;
    bytes32 constant S44 = 0x4444444444444444444444444444444444444444444444444444444444444444;
    bytes32 constant S55 = 0x5555555555555555555555555555555555555555555555555555555555555555;
    bytes32 constant S66 = 0x6666666666666666666666666666666666666666666666666666666666666666;
    bytes32 constant S88 = 0x8888888888888888888888888888888888888888888888888888888888888888;

    bytes32 constant LEAF_3_207 = 0x9ffba109988ddb050a38d005f452309a2eabcf5a46a97621effdcf26c3e47508;
    bytes32 constant LEAF_0_1 = 0x7d7e572375c6eba8aac2779e4f5875bc01e37283fea38bb0535cb4cee76c8b8c;
    bytes32 constant LEAF_1_2 = 0xb17ae73b7d48db18adabbd31559bb80228399275ca5c82acdab14f1017480997;
    bytes32 constant RESULTS_COMMIT = 0x661107b6de8f058afd1c33983e60828b39a7b9bb77e45cd34feecff91a377be0;
    bytes32 constant CHECK_COMMIT = 0x50ea9093e9d3cc68aa0d194796a05d23b83e807ff05aabb344f341ff9b6159d3;
    bytes32 constant VERIFY_TRUE = 0xa2f6db48e4217cc07583f9ea52bd1fc0e90a717552373e82eea50b3a6ff9c928;
    bytes32 constant VERIFY_FALSE = 0x571c2a6cc17bceba7d421165d8f2117dc954cbf951b4ebbb0cf9b95697b23540;
    bytes32 constant DATA_HASH_GOLDEN = 0x04ca3cee6744183786df649e62c82e681a1cc158de1e3a465006d79d9b48bdd3;

    function _twoLeaves() internal pure returns (bytes32[] memory l) {
        l = new bytes32[](2);
        l[0] = LEAF_0_1;
        l[1] = LEAF_1_2;
    }

    function test_GoldenVectors() public pure {
        assertEq(keccak256(abi.encode(S11, uint256(3), uint256(207))), LEAF_3_207, "leaf(3,207)");
        assertEq(keccak256(abi.encode(S11, uint256(0), uint256(1))), LEAF_0_1, "leaf(0,1)");
        assertEq(keccak256(abi.encode(S11, uint256(1), uint256(2))), LEAF_1_2, "leaf(1,2)");
        assertEq(keccak256(abi.encode(_twoLeaves())), RESULTS_COMMIT, "resultsCommit");
        assertEq(keccak256(abi.encode(S33, _twoLeaves())), CHECK_COMMIT, "checkCommit");
        assertEq(keccak256(abi.encode(S88, true)), VERIFY_TRUE, "verifyCommit(true)");
        assertEq(keccak256(abi.encode(S88, false)), VERIFY_FALSE, "verifyCommit(false)");

        bytes32[] memory items = new bytes32[](2);
        items[0] = S55;
        items[1] = S66;
        assertEq(keccak256(abi.encode(S44, items)), DATA_HASH_GOLDEN, "dataHash");
    }

    /// The test helpers use the same encodings as the golden vectors.
    function test_HelpersMatchGolden() public pure {
        assertEq(_leaf(3, 207), LEAF_3_207);
        assertEq(_resultsCommit(_twoLeaves()), RESULTS_COMMIT);
        assertEq(_checkCommit(_twoLeaves()), CHECK_COMMIT);
        assertEq(_verifyCommit(true), VERIFY_TRUE);
        assertEq(_verifyCommit(false), VERIFY_FALSE);
    }

    /// The contract accepts the golden commitments end to end: N = 4, each verifier covers 2 items
    /// (slot 0 = items [0, 2), whose leaves are the two golden leaves).
    function test_ContractAcceptsGoldenCommits() public {
        _snap();
        bytes32[] memory l = new bytes32[](4);
        l[0] = LEAF_0_1;
        l[1] = LEAF_1_2;
        l[2] = _leaf(2, 3);
        l[3] = _leaf(3, 4);
        vm.prank(client);
        uint256 id = market.createJob{value: 2 * 4 * PPI}(A, TASK, 4, DATA_HASH, "uri", VERIFY_TRUE, "");
        _accept(id);
        _commitM(id, l);
        vm.prank(client);
        market.revealDecision(id, S88, true);
        _shareAll(id);
        address[] memory vs = _verifiers(id);
        vm.prank(vs[0]);
        market.commitCheck(id, CHECK_COMMIT);
        _commitV(id, 1, l);
        vm.prank(vs[0]);
        market.revealCheck(id, _twoLeaves(), S33, "");
        _revealV(id, 1, l);
        _publish(id, l);
        _assertClosed(id, ReplicatedMarket.Outcome.Verified);
    }
}
