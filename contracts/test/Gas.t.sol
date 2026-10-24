// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console} from "forge-std/Test.sol";
import {DeGPUBase} from "./DeGPUBase.t.sol";
import {JobMarket} from "../src/JobMarket.sol";

/// @notice Gas of the heavy calls at demo size (N = 200 leaves, k = 20 sampled).
///         Numbers are execution gas of the call (no 21000 base cost, no calldata cost).
///         Run `forge test --match-contract GasTest --isolate --gas-report` for full transaction gas.
contract GasTest is DeGPUBase {
    function test_Gas_VerifiedFlow() public {
        bytes32[] memory leaves = _honest(N);
        uint256[] memory idx = _indices(N, K);
        bytes32[] memory vLeaves = _pick(leaves, idx);
        uint256 id = _create(A, N, K);
        address v = _accept(id);
        _share(id);
        _commitM(id, leaves);
        _commitV(id, vLeaves);

        vm.prank(v);
        uint256 g = gasleft();
        market.revealSample(id, idx, SAMPLE_SALT, vLeaves, V_SALT);
        uint256 revealGas = g - gasleft();

        vm.prank(A);
        g = gasleft();
        market.publishResults(id, leaves);
        uint256 publishGas = g - gasleft();

        console.log("revealSample (20 leaves) gas:", revealGas);
        console.log("publishResults (200 leaves, Verified, settles) gas:", publishGas);
        assertEq(uint8(_job(id).outcome), uint8(JobMarket.Outcome.Verified));
        assertEq(address(market).balance, 0);
        assertLt(revealGas, 1_500_000); // ~22k per new storage slot: 2 values per sampled item are stored
        assertLt(publishGas, 1_000_000);
    }

    function test_Gas_PublishUnverified() public {
        bytes32[] memory leaves = _honest(N);
        uint256 id = _create(A, N, 0);
        _accept(id);
        vm.prank(A);
        uint256 g = gasleft();
        market.publishResults(id, leaves);
        uint256 publishGas = g - gasleft();
        console.log("publishResults (200 leaves, Delivered, settles) gas:", publishGas);
        assertEq(address(market).balance, 0);
        assertLt(publishGas, 1_000_000);
    }

    function test_Gas_PublishWithMismatch() public {
        bytes32[] memory leaves = _honest(N);
        uint256[] memory idx = _indices(N, K);
        bytes32[] memory vLeaves = _pick(leaves, idx);
        vLeaves[0] = _wrong(0, 1);
        uint256 id = _toPublishing(A, leaves, vLeaves);
        vm.prank(A);
        uint256 g = gasleft();
        market.publishResults(id, leaves);
        uint256 publishGas = g - gasleft();
        console.log("publishResults (200 leaves, 1 mismatch, starts tie-break) gas:", publishGas);
        assertEq(uint8(_job(id).status), uint8(JobMarket.Status.TieBreak));
        assertLt(publishGas, 1_000_000);
    }
}
