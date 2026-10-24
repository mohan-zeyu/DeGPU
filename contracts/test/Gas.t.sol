// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console} from "forge-std/Test.sol";
import {DeGPUBase} from "./DeGPUBase.t.sol";
import {JobMarket} from "../src/JobMarket.sol";

/// @notice Gas of the heavy calls at demo size (N = 200 leaves, 100 per verifier).
///         Numbers are execution gas of the call (no 21000 base cost, no calldata cost).
///         Run `forge test --match-contract GasTest --isolate --gas-report` for full transaction gas.
contract GasTest is DeGPUBase {
    function test_Gas_VerifiedFlow() public {
        bytes32[] memory l = _honest(N);
        uint256 id = _create(A, N, true);
        _accept(id);
        _commitM(id, l);
        _decide(id, true);
        _shareAll(id);
        _commitV(id, 0, l);
        _commitV(id, 1, l);

        address v0 = _verifiers(id)[0];
        bytes32[] memory r0 = _slice(l, 0, 100);
        vm.prank(v0);
        uint256 g = gasleft();
        market.revealCheck(id, r0, V_SALT);
        uint256 revealGas = g - gasleft();
        _revealV(id, 1, l);

        vm.prank(A);
        g = gasleft();
        market.publishResults(id, l);
        uint256 publishGas = g - gasleft();

        console.log("revealCheck (100 leaves) gas:", revealGas);
        console.log("publishResults (200 leaves, Verified, settles) gas:", publishGas);
        assertEq(uint8(_job(id).outcome), uint8(JobMarket.Outcome.Verified));
        assertEq(address(market).balance, 0);
        assertLt(revealGas, 3_000_000); // ~22k per new storage slot: one leaf per item is stored
        assertLt(publishGas, 2_000_000);
    }

    function test_Gas_PublishUnverified() public {
        bytes32[] memory l = _honest(N);
        uint256 id = _toPublishingUnverified(A, l);
        vm.prank(A);
        uint256 g = gasleft();
        market.publishResults(id, l);
        uint256 publishGas = g - gasleft();
        console.log("publishResults (200 leaves, Delivered, settles) gas:", publishGas);
        assertEq(address(market).balance, 0);
        assertLt(publishGas, 1_000_000);
    }

    function test_Gas_PublishWithMismatch() public {
        bytes32[] memory l = _honest(N);
        bytes32[] memory m = _copy(l);
        m[0] = _wrong(0, 1);
        uint256 id = _toPublishingVerified(A, m, l, l);
        vm.prank(A);
        uint256 g = gasleft();
        market.publishResults(id, m);
        uint256 publishGas = g - gasleft();
        console.log("publishResults (200 leaves, 1 mismatch, starts tie-break) gas:", publishGas);
        assertEq(uint8(_job(id).status), uint8(JobMarket.Status.TieBreak));
        assertLt(publishGas, 2_000_000);
    }
}
