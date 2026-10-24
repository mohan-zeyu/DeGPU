// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {DeGPUBase} from "./DeGPUBase.t.sol";
import {JobMarket} from "../src/JobMarket.sol";

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
        assertEq(uint8(_job(id).outcome), uint8(JobMarket.Outcome.MainOutvoted));
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
        vm.prank(client);
        registry.register{value: STAKE}(bytes32(uint256(99)), PPI);
        (uint256 id, address[] memory vs) = _smallVerified(A, 1);
        assertEq(vs.length, 0);
        assertEq(uint8(_job(id).drop), uint8(JobMarket.Drop.NoEligibleVerifier));
    }
}
