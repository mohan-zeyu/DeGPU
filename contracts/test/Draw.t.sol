// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {DeGPUBase} from "./DeGPUBase.t.sol";
import {ReplicatedMarket} from "../src/ReplicatedMarket.sol";

/// @notice Verifier / tie-breaker draws: exclusions, distinctness, inactive providers, and that
///         the draw only happens after M has committed. vm.prevrandao varies the randomness.
contract DrawTest is DeGPUBase {
    uint256 constant SN = 10; // small jobs keep the loops fast

    /// Small verified job drawn under `seed`; returns its verifiers.
    function _smallVerified(address main, uint256 seed) internal returns (uint256 id, address[] memory vs) {
        vm.prevrandao(bytes32(seed));
        id = _create(main, SN, true);
        _accept(id);
        _commitM(id, _honest(SN));
        vs = _decide(id, true);
    }

    /// Small verified job where M is wrong on item 0, run until the tie-breaker is drawn.
    function _smallMismatch(address main, uint256 seed) internal returns (uint256 id, address[] memory vs, address t) {
        bytes32[] memory m = _honest(SN);
        m[0] = _wrong(0, 1);
        bytes32[] memory h = _honest(SN);
        vm.prevrandao(bytes32(seed));
        id = _create(main, SN, true);
        _accept(id);
        _commitM(id, m);
        vs = _decide(id, true);
        _shareAll(id);
        _commitV(id, 0, h);
        _commitV(id, 1, h);
        _revealV(id, 0, h);
        _revealV(id, 1, h);
        vm.prevrandao(bytes32(seed * 7919 + 13));
        _publish(id, m);
        t = _job(id).tiebreaker;
    }

    function test_Draw_VerifiersDistinct_NeverClientOrMain() public {
        uint256 distinct = 0;
        address first;
        for (uint256 s = 1; s <= 40; s++) {
            (, address[] memory vs) = _smallVerified(A, s);
            assertEq(vs.length, 2);
            assertTrue(vs[0] != vs[1], "same verifier twice");
            for (uint256 x = 0; x < 2; x++) {
                assertTrue(vs[x] != A && vs[x] != client, "excluded party drawn");
            }
            if (s == 1) first = vs[0];
            else if (vs[0] != first) distinct++;
        }
        assertGt(distinct, 0, "draws should vary with prevrandao");
    }

    function test_Draw_TiebreakerNeverClientMainOrVerifiers() public {
        for (uint256 s = 1; s <= 30; s++) {
            (, address[] memory vs, address t) = _smallMismatch(A, s);
            assertTrue(t != address(0));
            assertTrue(t != A && t != client && t != vs[0] && t != vs[1], "excluded party drawn as T");
        }
    }

    function test_Draw_NothingDrawnBeforeReveal() public {
        uint256 id = _create(A, SN, true);
        uint256 nonce = market.drawNonce();
        _accept(id);
        _commitM(id, _honest(SN));
        assertEq(market.drawNonce(), nonce, "no draw before the decision is revealed");
        assertEq(_verifiers(id).length, 0);
        _decide(id, true);
        assertEq(market.drawNonce(), nonce + 2);
    }

    function test_Draw_SkipsUnderStakedProviders() public {
        _deactivateAllBut(A, E, F); // B..D withdraw down to 0.5 ETH
        for (uint256 s = 1; s <= 20; s++) {
            (, address[] memory vs) = _smallVerified(A, s);
            assertTrue((vs[0] == E && vs[1] == F) || (vs[0] == F && vs[1] == E), "only E and F are eligible");
        }
    }

    function test_Draw_SkipsSlashedProvider() public {
        // E cheats as main and is slashed 30% -> 0.7 ETH < minStake
        (uint256 id,,) = _smallMismatch(E, 1);
        _shareTie(id);
        bytes32[] memory tl = new bytes32[](1);
        tl[0] = _leaf(0, _label(0));
        _submitTie(id, tl);
        assertEq(uint8(_job(id).outcome), uint8(ReplicatedMarket.Outcome.MainOutvoted));
        assertFalse(registry.isActive(E));

        vm.prank(client);
        vm.expectRevert(bytes("main not active"));
        market.createJob{value: 2 * SN * PPI}(E, TASK, SN, DATA_HASH, "uri", _verifyCommit(false), "");
        for (uint256 s = 2; s <= 30; s++) {
            (, address[] memory vs, address t) = _smallMismatch(A, s);
            assertTrue(vs[0] != E && vs[1] != E, "slashed verifier drawn");
            assertTrue(t != E, "slashed tiebreaker drawn");
        }
    }

    function test_Draw_ClientIsOnlyOtherProvider() public {
        _deactivateAllBut(A, address(0), address(0));
        vm.startPrank(client);
        registry.register{value: STAKE}(bytes32(uint256(99)));
        registry.setPrice(address(market), TASK, PPI);
        vm.stopPrank();
        (uint256 id, address[] memory vs) = _smallVerified(A, 1);
        assertEq(vs.length, 0);
        assertEq(uint8(_job(id).drop), uint8(ReplicatedMarket.Drop.NoEligibleVerifier));
    }

    /// Only providers that offer the job's task type are drawn, as verifiers or as tie-breaker.
    function test_Draw_OnlyProvidersOfferingTheTask() public {
        // B and E stop offering the task; with A as main, C, D and F remain
        vm.prank(B);
        registry.setPrice(address(market), TASK, 0);
        vm.prank(E);
        registry.setPrice(address(market), TASK, 0);
        for (uint256 s = 1; s <= 30; s++) {
            (, address[] memory vs, address t) = _smallMismatch(A, s);
            for (uint256 k = 0; k < 2; k++) {
                assertTrue(vs[k] != B && vs[k] != E, "verifier doesn't offer the task");
            }
            assertTrue(t != B && t != E && t != address(0), "tie-breaker doesn't offer the task");
        }
    }

    /// With too few providers offering the task, a "yes" decision is dropped to unverified.
    function test_Draw_TooFewOfferingProviders() public {
        address[3] memory off = [B, C, D];
        for (uint256 k = 0; k < 3; k++) {
            vm.prank(off[k]);
            registry.setPrice(address(market), TASK, 0);
        }
        // only E and F offer it besides A: two verifiers are drawn, but no tie-breaker is left
        (uint256 id, address[] memory vs, address t) = _smallMismatch(A, 3);
        assertEq(vs.length, 2);
        assertEq(t, address(0));
        assertEq(uint8(_job(id).outcome), uint8(ReplicatedMarket.Outcome.NoMajority));
        // and with only one other provider offering it, no verifier can be drawn at all
        vm.prank(E);
        registry.setPrice(address(market), TASK, 0);
        (uint256 id2, address[] memory vs2) = _smallVerified(A, 4);
        assertEq(vs2.length, 0);
        assertEq(uint8(_job(id2).drop), uint8(ReplicatedMarket.Drop.NoEligibleVerifier));
    }
}
