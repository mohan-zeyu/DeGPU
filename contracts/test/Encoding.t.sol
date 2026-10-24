// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {DeGPUBase} from "./DeGPUBase.t.sol";
import {JobMarket} from "../src/JobMarket.sol";

/// @notice Golden vectors of INTERFACE.md section 2. The Python tests check the same values.
contract EncodingTest is DeGPUBase {
    bytes32 constant S11 = 0x1111111111111111111111111111111111111111111111111111111111111111;
    bytes32 constant S22 = 0x2222222222222222222222222222222222222222222222222222222222222222;
    bytes32 constant S33 = 0x3333333333333333333333333333333333333333333333333333333333333333;
    bytes32 constant S44 = 0x4444444444444444444444444444444444444444444444444444444444444444;
    bytes32 constant S55 = 0x5555555555555555555555555555555555555555555555555555555555555555;
    bytes32 constant S66 = 0x6666666666666666666666666666666666666666666666666666666666666666;

    bytes32 constant LEAF_3_207 = 0x9ffba109988ddb050a38d005f452309a2eabcf5a46a97621effdcf26c3e47508;
    bytes32 constant LEAF_0_1 = 0x7d7e572375c6eba8aac2779e4f5875bc01e37283fea38bb0535cb4cee76c8b8c;
    bytes32 constant LEAF_1_2 = 0xb17ae73b7d48db18adabbd31559bb80228399275ca5c82acdab14f1017480997;
    bytes32 constant RESULTS_COMMIT = 0x661107b6de8f058afd1c33983e60828b39a7b9bb77e45cd34feecff91a377be0;
    bytes32 constant SAMPLE_HASH = 0xa3f2acca7f8ff2353d15988e2b4d6043e7b51d3f53492f8dbb5b11b3856497bc;
    bytes32 constant SAMPLE_COMMIT = 0x50ea9093e9d3cc68aa0d194796a05d23b83e807ff05aabb344f341ff9b6159d3;
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

        uint256[] memory idx = new uint256[](3);
        idx[0] = 0;
        idx[1] = 5;
        idx[2] = 9;
        assertEq(keccak256(abi.encode(S22, idx)), SAMPLE_HASH, "sampleHash");

        assertEq(keccak256(abi.encode(S33, _twoLeaves())), SAMPLE_COMMIT, "sampleCommit");

        bytes32[] memory items = new bytes32[](2);
        items[0] = S55;
        items[1] = S66;
        assertEq(keccak256(abi.encode(S44, items)), DATA_HASH_GOLDEN, "dataHash");
    }

    /// The test helpers use the same encodings as the golden vectors.
    function test_HelpersMatchGolden() public pure {
        assertEq(_leaf(3, 207), LEAF_3_207);
        assertEq(_resultsCommit(_twoLeaves()), RESULTS_COMMIT);
        assertEq(_sampleCommit(_twoLeaves()), SAMPLE_COMMIT);
    }

    /// The contract itself accepts the golden resultsCommit and sampleCommit (N = 2, k = 2, S = [0, 1]).
    function test_ContractAcceptsGoldenCommits() public {
        _snap();
        uint256[] memory idx = new uint256[](2);
        idx[0] = 0;
        idx[1] = 1;
        vm.prank(client);
        uint256 id = market.createJob{value: _value(2, 2)}(A, TASK, 2, DATA_HASH, "uri", 2, _sampleHash(idx), "");
        address v = _accept(id);
        _share(id);
        vm.prank(A);
        market.commitResults(id, RESULTS_COMMIT);
        vm.prank(v);
        market.commitSample(id, SAMPLE_COMMIT);
        vm.prank(v);
        market.revealSample(id, idx, SAMPLE_SALT, _twoLeaves(), S33);
        vm.prank(A);
        market.publishResults(id, _twoLeaves());
        _assertClosed(id, JobMarket.Outcome.Verified);
    }

    /// The contract itself accepts the golden sampleHash (salt 0x22.., S = [0, 5, 9]).
    function test_ContractAcceptsGoldenSampleHash() public {
        uint256[] memory idx = new uint256[](3);
        idx[0] = 0;
        idx[1] = 5;
        idx[2] = 9;
        vm.prank(client);
        uint256 id = market.createJob{value: _value(10, 3)}(A, TASK, 10, DATA_HASH, "uri", 3, SAMPLE_HASH, "");
        address v = _accept(id);
        bytes32[] memory leaves = _honest(10);
        bytes32[] memory vLeaves = _pick(leaves, idx);
        _share(id);
        _commitM(id, leaves);
        _commitV(id, vLeaves);
        vm.prank(v);
        market.revealSample(id, idx, S22, vLeaves, V_SALT);
        assertEq(uint8(_job(id).status), uint8(JobMarket.Status.Publishing));
        _publish(id, leaves);
        assertEq(uint8(_job(id).outcome), uint8(JobMarket.Outcome.Verified));
        assertEq(address(market).balance, 0);
    }
}
