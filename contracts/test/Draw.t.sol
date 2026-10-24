// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {DeGPUBase} from "./DeGPUBase.t.sol";
import {JobMarket} from "../src/JobMarket.sol";

/// @notice Verifier / tie-breaker draws: exclusions, inactive providers, and the exact formula.
///         vm.prevrandao varies the randomness between jobs.
contract DrawTest is DeGPUBase {
    uint256 constant SN = 10; // small jobs keep the loops fast
    uint256 constant SK = 2; // sample indices [0, 5]

    function _registerClientAsProvider() internal {
        vm.prank(client);
        registry.register{value: STAKE}(bytes32(uint256(99)), PPI);
        assertTrue(registry.isActive(client));
    }

    /// Small verified job with M wrong on item 0, run until the tie-breaker is drawn.
    function _smallMismatch(address main, uint256 seed) internal returns (uint256 id, address v, address t) {
        bytes32[] memory honest = _honest(SN);
        bytes32[] memory mLeaves = _honest(SN);
        mLeaves[0] = _wrong(0, 1);
        bytes32[] memory vLeaves = _pick(honest, _indices(SN, SK));

        vm.prevrandao(bytes32(seed));
        id = _create(main, SN, SK);
        v = _accept(id);
        _share(id);
        _commitM(id, mLeaves);
        _commitV(id, vLeaves);
        _reveal(id, vLeaves);
        vm.prevrandao(bytes32(seed * 7919 + 13));
        _publish(id, mLeaves);
        t = _job(id).tiebreaker;
    }

    function _indexOf(address p) internal view returns (uint256) {
        for (uint256 i = 0; i < providers.length; i++) {
            if (providers[i] == p) return i;
        }
        return type(uint256).max;
    }

    /// The draw formula of INTERFACE.md section 7, recomputed in the test.
    function _expectedDraw(uint256 jobId, address ex1, address ex2, address ex3) internal view returns (address) {
        uint256 n = registry.providerCount();
        uint256 start = uint256(
            keccak256(
                abi.encode(
                    block.prevrandao, blockhash(block.number - 1), jobId, ex1, ex2, ex3, market.drawNonce()
                )
            )
        ) % n;
        for (uint256 x = 0; x < n; x++) {
            address p = registry.providerAt((start + x) % n);
            if (p != ex1 && p != ex2 && p != ex3 && registry.isActive(p)) return p;
        }
        return address(0);
    }

    function test_Draw_VerifierNeverClientOrMain() public {
        _registerClientAsProvider();
        bool[6] memory seen;
        uint256 distinct = 0;
        for (uint256 s = 1; s <= 60; s++) {
            address main = providers[s % 6];
            vm.prevrandao(bytes32(s));
            uint256 id = _create(main, SN, SK);
            address v = _accept(id);
            assertTrue(v != address(0), "no verifier");
            assertTrue(v != client, "verifier is client");
            assertTrue(v != main, "verifier is main");
            uint256 i = _indexOf(v);
            assertTrue(i < 6, "verifier not a provider");
            if (!seen[i]) {
                seen[i] = true;
                distinct++;
            }
        }
        assertGe(distinct, 4, "draws should vary with prevrandao");
    }

    function test_Draw_TiebreakerNeverClientMainOrVerifier() public {
        _registerClientAsProvider();
        uint256 distinct = 0;
        bool[6] memory seen;
        for (uint256 s = 1; s <= 30; s++) {
            address main = providers[s % 6];
            (uint256 id, address v, address t) = _smallMismatch(main, s);
            assertEq(uint8(_job(id).status), uint8(JobMarket.Status.TieBreak));
            assertTrue(t != address(0), "no tiebreaker");
            assertTrue(t != client, "tiebreaker is client");
            assertTrue(t != main, "tiebreaker is main");
            assertTrue(t != v, "tiebreaker is verifier");
            uint256 i = _indexOf(t);
            if (!seen[i]) {
                seen[i] = true;
                distinct++;
            }
        }
        assertGe(distinct, 3, "draws should vary with prevrandao");
    }

    function test_Draw_SkipsUnderStakedProviders() public {
        _deactivateAllBut(A, F); // B..E withdraw down to 0.5 ETH
        for (uint256 s = 1; s <= 30; s++) {
            vm.prevrandao(bytes32(s));
            uint256 id = _create(A, SN, SK);
            assertEq(_accept(id), F, "only F is eligible");
        }
    }

    function test_Draw_SkipsSlashedProvider() public {
        // E cheats as main and is slashed 30% -> 0.7 ETH < minStake
        (uint256 id,,) = _smallMismatch(E, 1);
        _shareTie(id);
        bytes32[] memory tLeaves = new bytes32[](1);
        tLeaves[0] = _leaf(0, _label(0));
        _submitTie(id, tLeaves);
        assertEq(uint8(_job(id).outcome), uint8(JobMarket.Outcome.MainOutvoted));
        assertFalse(registry.isActive(E));
        assertEq(address(market).balance, 0);

        // E can no longer be picked as main, verifier or tie-breaker
        vm.prank(client);
        vm.expectRevert(bytes("main not active"));
        market.createJob{value: _value(SN, 0)}(E, TASK, SN, DATA_HASH, "uri", 0, 0, "");
        for (uint256 s = 2; s <= 40; s++) {
            (, address v, address t) = _smallMismatch(A, s);
            assertTrue(v != E, "slashed verifier drawn");
            assertTrue(t != E, "slashed tiebreaker drawn");
        }
    }

    function test_Draw_ClientIsOnlyOtherProvider() public {
        _deactivateAllBut(A, address(0));
        _registerClientAsProvider();
        uint256 id = _create(A, SN, SK);
        assertEq(_accept(id), address(0));
        assertEq(uint8(_job(id).drop), uint8(JobMarket.Drop.NoEligibleVerifier));
    }

    function test_Draw_MatchesFormula() public {
        for (uint256 s = 1; s <= 20; s++) {
            vm.prevrandao(bytes32(s * 1_000_003));
            uint256 id = _create(A, SN, SK);
            address expected = _expectedDraw(id, client, A, address(0));
            uint256 nonce = market.drawNonce();
            assertEq(_accept(id), expected);
            assertEq(market.drawNonce(), nonce + 1);
        }
    }
}
