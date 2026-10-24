// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {DeGPUBase} from "./DeGPUBase.t.sol";
import {JobMarket} from "../src/JobMarket.sol";
import {ProviderRegistry} from "../src/ProviderRegistry.sol";

/// @notice One test (or more) per settlement case of INTERFACE.md (v2) section 7, with exact payouts,
///         stake changes and stats. Demo numbers: price 0.02, deposit 0.04, 0.01 per verifier,
///         slash 0.3 (wrong) / 0.1 (main missed) / 0.05 (check missed), tie-breaker fee 0.002.
contract SettlementTest is DeGPUBase {
    // Item 5 is in verifier slot 0's range [0, 100), item 150 in slot 1's range [100, 200).
    uint256 constant I0 = 5;
    uint256 constant I1 = 150;

    function _honestAt(uint256[] memory idx) internal pure returns (bytes32[] memory l) {
        l = new bytes32[](idx.length);
        for (uint256 x = 0; x < idx.length; x++) {
            l[x] = _leaf(idx[x], _label(idx[x]));
        }
    }

    function _withWrong(uint256 i, uint256 delta) internal pure returns (bytes32[] memory l) {
        l = _honest(N);
        l[i] = _wrong(i, delta);
    }

    function _redeployWith(JobMarket.Params memory p) internal {
        _deploy(p);
        for (uint256 i = 0; i < providers.length; i++) {
            vm.prank(providers[i]);
            registry.register{value: STAKE}(bytes32(i + 1), PPI);
        }
    }

    // ------------------------------------------------------------------
    // Cancelled
    // ------------------------------------------------------------------

    function test_Cancelled_ByClient() public {
        _snap();
        uint256 id = _create(A, N, true);
        assertEq(address(market).balance, DEPOSIT);
        vm.prank(client);
        market.cancel(id);
        _assertClosed(id, JobMarket.Outcome.Cancelled);
        assertEq(_dBal(client), 0);
    }

    function test_Cancelled_ByExpire() public {
        _snap();
        uint256 id = _create(A, N, false);
        _pastDeadline(id);
        vm.prank(stranger);
        market.expire(id);
        _assertClosed(id, JobMarket.Outcome.Cancelled);
        assertEq(_dBal(client), 0);
    }

    // ------------------------------------------------------------------
    // Unverified: Delivered
    // ------------------------------------------------------------------

    function test_Delivered_DecisionNo() public {
        _snap();
        bytes32[] memory l = _honest(N);
        uint256 id = _toPublishingUnverified(A, l);
        assertEq(_verifiers(id).length, 0);
        assertTrue(_job(id).decided);
        assertFalse(_job(id).verify);
        _publish(id, l);
        _assertClosed(id, JobMarket.Outcome.Delivered);
        assertEq(_dBal(client), -_i(PRICE)); // the unused fee half of the deposit comes back
        assertEq(_dBal(A), _i(PRICE));
        assertEq(_stat(A, ProviderRegistry.Stat.UnverifiedCompleted), 1);
        assertEq(_stat(A, ProviderRegistry.Stat.VerifiedCompleted), 0);
    }

    function test_Delivered_ClientNoReveal() public {
        _snap();
        bytes32[] memory l = _honest(N);
        uint256 id = _create(A, N, true);
        _accept(id);
        _commitM(id, l);
        _pastDeadline(id);
        market.expire(id);
        JobMarket.Job memory j = _job(id);
        assertEq(uint8(j.status), uint8(JobMarket.Status.Publishing));
        assertEq(uint8(j.drop), uint8(JobMarket.Drop.ClientNoReveal));
        assertFalse(j.verify);
        _publish(id, l);
        _assertClosed(id, JobMarket.Outcome.Delivered);
        assertEq(_dBal(client), -_i(PRICE));
        assertEq(_dBal(A), _i(PRICE));
    }

    function test_Delivered_NoEligibleVerifier() public {
        _deactivateAllBut(A, B, address(0)); // only B could verify, but 2 are needed
        _snap();
        bytes32[] memory l = _honest(N);
        uint256 id = _create(A, N, true);
        _accept(id);
        _commitM(id, l);
        address[] memory vs = _decide(id, true);
        assertEq(vs.length, 0);
        assertEq(uint8(_job(id).drop), uint8(JobMarket.Drop.NoEligibleVerifier));
        assertEq(uint8(_job(id).status), uint8(JobMarket.Status.Publishing));
        _publish(id, l);
        _assertClosed(id, JobMarket.Outcome.Delivered);
        assertEq(_dBal(client), -_i(PRICE));
        assertEq(_dBal(A), _i(PRICE));
    }

    function test_Delivered_AllVerifiersBadInput() public {
        _snap();
        bytes32[] memory l = _honest(N);
        uint256 id = _create(A, N, true);
        _accept(id);
        _commitM(id, l);
        address[] memory vs = _decide(id, true);
        _shareAll(id);
        vm.prank(vs[0]);
        market.reportBadInput(id);
        assertEq(_locks(vs[0]), 0); // unlocked right away
        vm.prank(vs[1]);
        market.reportBadInput(id);
        assertEq(uint8(_job(id).status), uint8(JobMarket.Status.Publishing));
        _publish(id, l);
        _assertClosed(id, JobMarket.Outcome.Delivered);
        assertEq(_dBal(client), -_i(PRICE));
        assertEq(_dBal(vs[0]), 0);
        assertEq(_dBal(vs[1]), 0);
        assertEq(_dStake(vs[0]), 0);
    }

    function test_Delivered_ClientSharesNothing() public {
        _snap();
        bytes32[] memory l = _honest(N);
        uint256 id = _create(A, N, true);
        _accept(id);
        _commitM(id, l);
        address[] memory vs = _decide(id, true);
        _pastDeadline(id);
        market.expire(id); // both slots -> NoShare, nothing to reveal -> Publishing
        assertEq(uint8(_job(id).status), uint8(JobMarket.Status.Publishing));
        _publish(id, l);
        _assertClosed(id, JobMarket.Outcome.Delivered);
        // the client forfeits both verifier fees
        assertEq(_dBal(client), -_i(DEPOSIT));
        assertEq(_dBal(vs[0]), _i(HALF_FEE));
        assertEq(_dBal(vs[1]), _i(HALF_FEE));
        assertEq(_stat(A, ProviderRegistry.Stat.UnverifiedCompleted), 1);
    }

    // ------------------------------------------------------------------
    // Verified
    // ------------------------------------------------------------------

    function test_Verified() public {
        _snap();
        bytes32[] memory l = _honest(N);
        uint256 id = _runVerified(A, l, l, l);
        address[] memory vs = _verifiers(id);
        _assertClosed(id, JobMarket.Outcome.Verified);
        assertEq(_dBal(client), -_i(DEPOSIT));
        assertEq(_dBal(A), _i(PRICE));
        assertEq(_dBal(vs[0]), _i(HALF_FEE));
        assertEq(_dBal(vs[1]), _i(HALF_FEE));
        assertEq(_stat(A, ProviderRegistry.Stat.VerifiedCompleted), 1);
        assertEq(_stat(vs[0], ProviderRegistry.Stat.ChecksCompleted), 1);
        assertEq(_stat(vs[1], ProviderRegistry.Stat.ChecksCompleted), 1);
        // every item was checked: each verifier's range is stored
        assertEq(market.checkLeafOf(id, 0), l[0]);
        assertEq(market.checkLeafOf(id, N - 1), l[N - 1]);
    }

    function test_Verified_WithinMaxMismatch() public {
        JobMarket.Params memory p = demoParams();
        p.maxMismatch = 1;
        _redeployWith(p);
        _snap();
        bytes32[] memory l = _honest(N);
        uint256 id = _runVerified(A, l, l, _withWrong(I1, 1));
        _assertClosed(id, JobMarket.Outcome.Verified);
        assertEq(_dBal(client), -_i(DEPOSIT));
        assertEq(_dBal(A), _i(PRICE));
    }

    function test_Verified_OneVerifierBadInput() public {
        _snap();
        bytes32[] memory l = _honest(N);
        uint256 id = _create(A, N, true);
        _accept(id);
        _commitM(id, l);
        address[] memory vs = _decide(id, true);
        _shareAll(id);
        vm.prank(vs[1]);
        market.reportBadInput(id);
        _commitV(id, 0, l);
        assertEq(uint8(_job(id).status), uint8(JobMarket.Status.CheckReveal));
        _revealV(id, 0, l);
        _publish(id, l);
        _assertClosed(id, JobMarket.Outcome.Verified);
        assertEq(_dBal(client), -_i(PRICE + HALF_FEE)); // slot 1's fee comes back
        assertEq(_dBal(vs[0]), _i(HALF_FEE));
        assertEq(_dBal(vs[1]), 0);
        assertEq(uint8(_job(id).vstate[1]), uint8(JobMarket.VState.BadInput));
    }

    function test_Verified_OneVerifierNoShare() public {
        _snap();
        bytes32[] memory l = _honest(N);
        uint256 id = _create(A, N, true);
        _accept(id);
        _commitM(id, l);
        address[] memory vs = _decide(id, true);
        _share(id, 0);
        _commitV(id, 0, l);
        assertEq(uint8(_job(id).status), uint8(JobMarket.Status.Checking)); // slot 1 still waits
        _pastDeadline(id);
        market.expire(id);
        assertEq(uint8(_job(id).vstate[1]), uint8(JobMarket.VState.NoShare));
        assertEq(uint8(_job(id).status), uint8(JobMarket.Status.CheckReveal));
        _revealV(id, 0, l);
        _publish(id, l);
        _assertClosed(id, JobMarket.Outcome.Verified);
        assertEq(_dBal(client), -_i(DEPOSIT)); // the client forfeits slot 1's fee
        assertEq(_dBal(vs[0]), _i(HALF_FEE));
        assertEq(_dBal(vs[1]), _i(HALF_FEE));
    }

    function test_Verified_OneVerifierMissedCommit() public {
        _snap();
        bytes32[] memory l = _honest(N);
        uint256 id = _create(A, N, true);
        _accept(id);
        _commitM(id, l);
        address[] memory vs = _decide(id, true);
        _shareAll(id);
        _commitV(id, 0, l);
        _pastDeadline(id);
        market.expire(id); // slot 1 shared but never committed -> Missed, slashed now
        assertEq(uint8(_job(id).vstate[1]), uint8(JobMarket.VState.Missed));
        assertEq(_job(id).slashedPool, SLASH_CHECK);
        assertEq(_locks(vs[1]), 0);
        _revealV(id, 0, l);
        _publish(id, l);
        _assertClosed(id, JobMarket.Outcome.Verified);
        assertEq(_dBal(client), -_i(PRICE + HALF_FEE) + _i(SLASH_CHECK));
        assertEq(_dBal(vs[0]), _i(HALF_FEE));
        assertEq(_dBal(vs[1]), 0);
        assertEq(_dStake(vs[1]), -_i(SLASH_CHECK));
        assertEq(_stat(vs[1], ProviderRegistry.Stat.ChecksMissed), 1);
    }

    function test_Verified_OneVerifierMissedReveal() public {
        _snap();
        bytes32[] memory l = _honest(N);
        uint256 id = _create(A, N, true);
        _accept(id);
        _commitM(id, l);
        address[] memory vs = _decide(id, true);
        _shareAll(id);
        _commitV(id, 0, l);
        _commitV(id, 1, l);
        _revealV(id, 0, l);
        assertEq(uint8(_job(id).status), uint8(JobMarket.Status.CheckReveal));
        _pastDeadline(id);
        market.expire(id);
        assertEq(uint8(_job(id).status), uint8(JobMarket.Status.Publishing));
        _publish(id, l);
        _assertClosed(id, JobMarket.Outcome.Verified);
        assertEq(_dBal(client), -_i(PRICE + HALF_FEE) + _i(SLASH_CHECK));
        assertEq(_dStake(vs[1]), -_i(SLASH_CHECK));
        assertEq(_dBal(vs[0]), _i(HALF_FEE));
    }

    // ------------------------------------------------------------------
    // Tie-break outcomes
    // ------------------------------------------------------------------

    function test_MainOutvoted() public {
        _snap();
        bytes32[] memory l = _honest(N);
        bytes32[] memory m = _honest(N);
        m[I0] = _wrong(I0, 1);
        m[I1] = _wrong(I1, 1);
        uint256 id = _runVerified(A, m, l, l);
        assertEq(uint8(_job(id).status), uint8(JobMarket.Status.TieBreak));
        uint256[] memory mis = _job(id).mismatched;
        assertEq(mis.length, 2);
        assertEq(mis[0], I0);
        assertEq(mis[1], I1);
        address t = _job(id).tiebreaker;
        address[] memory vs = _verifiers(id);
        assertTrue(t != A && t != vs[0] && t != vs[1] && t != client);

        _shareTie(id);
        _submitTie(id, _honestAt(mis));
        _assertClosed(id, JobMarket.Outcome.MainOutvoted);
        assertEq(_dStake(A), -_i(SLASH_WRONG));
        assertEq(_dBal(A), 0);
        assertEq(_dBal(vs[0]), _i(HALF_FEE));
        assertEq(_dBal(vs[1]), _i(HALF_FEE));
        assertEq(_dBal(t), _i(TIEBREAK_FEE));
        // client: deposit 0.04 + slash 0.3 - fees 0.02 - T 0.002 = 0.318 back -> net +0.278
        assertEq(_dBal(client), _i(SLASH_WRONG) - _i(2 * HALF_FEE + TIEBREAK_FEE));
        assertEq(_stat(A, ProviderRegistry.Stat.Outvoted), 1);
        assertEq(_stat(t, ProviderRegistry.Stat.ChecksCompleted), 1);
        assertFalse(registry.isActive(A)); // 0.7 < 0.8
    }

    function test_VerifierOutvoted_One() public {
        _snap();
        bytes32[] memory l = _honest(N);
        uint256 id = _runVerified(A, l, l, _withWrong(I1, 1));
        address[] memory vs = _verifiers(id);
        address t = _job(id).tiebreaker;
        _shareTie(id);
        _submitTie(id, _honestAt(_job(id).mismatched));
        _assertClosed(id, JobMarket.Outcome.VerifierOutvoted);
        assertEq(_dBal(A), _i(PRICE));
        assertEq(_dBal(vs[0]), _i(HALF_FEE));
        assertEq(_dStake(vs[1]), -_i(SLASH_WRONG));
        assertEq(_dBal(vs[1]), 0);
        assertEq(_dBal(t), _i(TIEBREAK_FEE));
        // client: 0.04 + 0.3 - 0.02 - 0.01 - 0.002 = 0.308 back -> net +0.268
        assertEq(_dBal(client), _i(SLASH_WRONG) - _i(PRICE + HALF_FEE + TIEBREAK_FEE));
        assertEq(uint8(_job(id).vstate[1]), uint8(JobMarket.VState.Outvoted));
        assertEq(_stat(vs[1], ProviderRegistry.Stat.ChecksOutvoted), 1);
        assertEq(_stat(A, ProviderRegistry.Stat.VerifiedCompleted), 1);
    }

    function test_VerifierOutvoted_Both() public {
        _snap();
        bytes32[] memory l = _honest(N);
        uint256 id = _runVerified(A, l, _withWrong(I0, 1), _withWrong(I1, 1));
        address[] memory vs = _verifiers(id);
        address t = _job(id).tiebreaker;
        _shareTie(id);
        _submitTie(id, _honestAt(_job(id).mismatched));
        _assertClosed(id, JobMarket.Outcome.VerifierOutvoted);
        assertEq(_dBal(A), _i(PRICE));
        assertEq(_dStake(vs[0]), -_i(SLASH_WRONG));
        assertEq(_dStake(vs[1]), -_i(SLASH_WRONG));
        assertEq(_dBal(t), _i(TIEBREAK_FEE));
        // client: 0.04 + 0.6 - 0.02 - 0.002 = 0.618 back -> net +0.578
        assertEq(_dBal(client), _i(2 * SLASH_WRONG) - _i(PRICE + TIEBREAK_FEE));
    }

    function test_BothOutvoted() public {
        _snap();
        bytes32[] memory l = _honest(N);
        uint256 id = _runVerified(A, _withWrong(I0, 1), l, _withWrong(I1, 1));
        address[] memory vs = _verifiers(id);
        address t = _job(id).tiebreaker;
        _shareTie(id);
        _submitTie(id, _honestAt(_job(id).mismatched));
        _assertClosed(id, JobMarket.Outcome.BothOutvoted);
        assertEq(_dStake(A), -_i(SLASH_WRONG));
        assertEq(_dStake(vs[1]), -_i(SLASH_WRONG));
        assertEq(_dBal(vs[0]), _i(HALF_FEE)); // slot 0 was right
        assertEq(_dBal(t), _i(TIEBREAK_FEE));
        // client: 0.04 + 0.6 - 0.01 - 0.002 = 0.628 back -> net +0.588
        assertEq(_dBal(client), _i(2 * SLASH_WRONG) - _i(HALF_FEE + TIEBREAK_FEE));
    }

    function test_NoMajority_AllDifferent() public {
        _snap();
        uint256 id = _runVerified(A, _withWrong(I0, 1), _withWrong(I0, 2), _honest(N));
        address[] memory vs = _verifiers(id);
        address t = _job(id).tiebreaker;
        bytes32[] memory tl = new bytes32[](1);
        tl[0] = _wrong(I0, 3);
        _shareTie(id);
        _submitTie(id, tl);
        _assertClosed(id, JobMarket.Outcome.NoMajority);
        assertEq(_dBal(A), 0); // unresolved item: M unpaid, not slashed
        assertEq(_dStake(A), 0);
        assertEq(_dBal(vs[0]), 0); // owns the unresolved item
        assertEq(_dBal(vs[1]), _i(HALF_FEE)); // its range all matched
        assertEq(_dBal(t), _i(TIEBREAK_FEE));
        assertEq(_dBal(client), -_i(HALF_FEE + TIEBREAK_FEE));
    }

    function test_NoMajority_NoEligibleTiebreaker() public {
        _deactivateAllBut(A, B, C); // M = A, verifiers B and C, nobody left to break ties
        _snap();
        uint256 id = _runVerified(A, _withWrong(I1, 1), _honest(N), _honest(N));
        address[] memory vs = _verifiers(id);
        assertEq(_job(id).tiebreaker, address(0));
        _assertClosed(id, JobMarket.Outcome.NoMajority);
        assertEq(_dBal(A), 0);
        assertEq(_dBal(vs[0]), _i(HALF_FEE));
        assertEq(_dBal(vs[1]), 0);
        assertEq(_dBal(client), -_i(HALF_FEE));
    }

    function test_VerifierOutvoted_WithUnresolvedItem() public {
        _snap();
        // item I0: M, V0 and T all differ (unresolved); item I1: V1 wrong, T agrees with M
        uint256 id = _runVerified(A, _withWrong(I0, 1), _withWrong(I0, 2), _withWrong(I1, 1));
        address[] memory vs = _verifiers(id);
        address t = _job(id).tiebreaker;
        bytes32[] memory tl = new bytes32[](2);
        tl[0] = _wrong(I0, 3);
        tl[1] = _leaf(I1, _label(I1));
        _shareTie(id);
        _submitTie(id, tl);
        _assertClosed(id, JobMarket.Outcome.VerifierOutvoted);
        assertEq(_dBal(A), 0); // an unresolved item keeps M unpaid
        assertEq(_dBal(vs[0]), 0);
        assertEq(_dStake(vs[1]), -_i(SLASH_WRONG));
        assertEq(_dBal(t), _i(TIEBREAK_FEE));
        assertEq(_dBal(client), _i(SLASH_WRONG) - _i(TIEBREAK_FEE));
    }

    // ------------------------------------------------------------------
    // Missed deadlines
    // ------------------------------------------------------------------

    function test_MainMissed_InCommitting() public {
        _snap();
        uint256 id = _create(A, N, true);
        _accept(id);
        _pastDeadline(id);
        market.expire(id);
        _assertClosed(id, JobMarket.Outcome.MainMissed);
        assertEq(_dStake(A), -_i(SLASH_MISSED));
        assertEq(_dBal(client), _i(SLASH_MISSED));
        assertEq(_stat(A, ProviderRegistry.Stat.Missed), 1);
    }

    function test_MainMissed_InPublishing_Unverified() public {
        _snap();
        uint256 id = _toPublishingUnverified(A, _honest(N));
        _pastDeadline(id);
        market.expire(id);
        _assertClosed(id, JobMarket.Outcome.MainMissed);
        assertEq(_dStake(A), -_i(SLASH_MISSED));
        assertEq(_dBal(client), _i(SLASH_MISSED));
    }

    function test_MainMissed_InPublishing_AfterReveal() public {
        _snap();
        bytes32[] memory l = _honest(N);
        uint256 id = _toPublishingVerified(A, l, l, l);
        address[] memory vs = _verifiers(id);
        _pastDeadline(id);
        market.expire(id);
        _assertClosed(id, JobMarket.Outcome.MainMissed);
        assertEq(_dStake(A), -_i(SLASH_MISSED));
        assertEq(_dBal(vs[0]), _i(HALF_FEE)); // they did the work
        assertEq(_dBal(vs[1]), _i(HALF_FEE));
        assertEq(_dBal(client), _i(SLASH_MISSED) - _i(2 * HALF_FEE));
    }

    function test_TiebreakerMissed() public {
        _snap();
        uint256 id = _runVerified(A, _withWrong(I0, 1), _honest(N), _honest(N));
        address[] memory vs = _verifiers(id);
        address t = _job(id).tiebreaker;
        _shareTie(id);
        _pastDeadline(id);
        market.expire(id);
        _assertClosed(id, JobMarket.Outcome.TiebreakerMissed);
        assertEq(_dStake(t), -_i(SLASH_CHECK));
        assertEq(_dBal(A), 0);
        assertEq(_dBal(vs[0]), 0); // owns the unresolved item
        assertEq(_dBal(vs[1]), _i(HALF_FEE));
        assertEq(_dBal(client), _i(SLASH_CHECK) - _i(HALF_FEE));
        assertEq(_stat(t, ProviderRegistry.Stat.ChecksMissed), 1);
    }

    function test_TieClientNoShare_ClientNeverShares() public {
        _snap();
        uint256 id = _runVerified(A, _withWrong(I0, 1), _honest(N), _honest(N));
        address[] memory vs = _verifiers(id);
        address t = _job(id).tiebreaker;
        _pastDeadline(id);
        market.expire(id);
        _assertClosed(id, JobMarket.Outcome.TieClientNoShare);
        assertEq(_dBal(A), _i(PRICE));
        assertEq(_dBal(vs[0]), _i(HALF_FEE));
        assertEq(_dBal(vs[1]), _i(HALF_FEE));
        assertEq(_dBal(t), 0);
        assertEq(_dBal(client), -_i(DEPOSIT));
        assertEq(_stat(A, ProviderRegistry.Stat.UnverifiedCompleted), 1);
    }

    function test_TieClientNoShare_TiebreakerReportsBadInput() public {
        _snap();
        uint256 id = _runVerified(A, _withWrong(I0, 1), _honest(N), _honest(N));
        address t = _job(id).tiebreaker;
        _shareTie(id);
        vm.prank(t);
        market.reportBadInput(id);
        _assertClosed(id, JobMarket.Outcome.TieClientNoShare);
        assertEq(_dBal(A), _i(PRICE));
        assertEq(_dBal(t), 0);
        assertEq(_dBal(client), -_i(DEPOSIT));
    }

    // ------------------------------------------------------------------
    // Hidden decision, pricing, concurrency
    // ------------------------------------------------------------------

    /// A verified and an unverified job look the same on-chain until the reveal.
    function test_DecisionHiddenUntilReveal() public {
        bytes32[] memory l = _honest(N);
        uint256 yes = _create(A, N, true);
        uint256 no = _create(A, N, false);
        JobMarket.Job memory jy = _job(yes);
        JobMarket.Job memory jn = _job(no);
        assertEq(jy.price, jn.price);
        assertTrue(jy.verifyCommit != jn.verifyCommit); // only the opaque commitment differs
        assertFalse(jy.decided || jn.decided);

        // nobody has been drawn yet, even after M commits
        _accept(yes);
        _accept(no);
        _commitM(yes, l);
        _commitM(no, l);
        assertEq(_verifiers(yes).length, 0);
        assertEq(uint8(_job(yes).status), uint8(_job(no).status));

        // a wrong opening is refused: the client can't flip its decision
        vm.prank(client);
        vm.expectRevert(bytes("verifyCommit mismatch"));
        market.revealDecision(yes, VERIFY_SALT, false);
        assertEq(_decide(yes, true).length, 2);
        assertEq(_decide(no, false).length, 0);
    }

    /// The price is pinned at createJob: a later price change doesn't affect the job.
    function test_PricePinnedAtCreate() public {
        _snap();
        bytes32[] memory l = _honest(N);
        uint256 id = _create(A, N, false);
        vm.prank(A);
        registry.setPrice(1 ether);
        _accept(id);
        _commitM(id, l);
        _decide(id, false);
        _publish(id, l);
        _assertClosed(id, JobMarket.Outcome.Delivered);
        assertEq(_dBal(A), _i(PRICE));
    }

    /// Fees split the items as evenly as integer division allows (odd N).
    function test_RangesAndFees_OddN() public {
        uint256 id = _create(A, 7, true);
        (uint256 s0, uint256 e0) = market.rangeOf(id, 0);
        (uint256 s1, uint256 e1) = market.rangeOf(id, 1);
        assertEq(s0, 0);
        assertEq(e0, 3);
        assertEq(s1, 3);
        assertEq(e1, 7);
        assertEq(market.feeOf(id, 0) + market.feeOf(id, 1), 7 * PPI);
    }

    /// Overlapping jobs (one holding a verifier slash) leave the market empty once all close.
    function test_ConcurrentJobs_MarketEndsEmpty() public {
        bytes32[] memory l = _honest(N);
        uint256 j1 = _create(A, N, true);
        uint256 j2 = _create(B, N, false);
        _accept(j1);
        _accept(j2);
        _commitM(j1, l);
        _decide(j1, true);
        _shareAll(j1);
        _commitV(j1, 0, l);
        _pastDeadline(j1); // also past j2's deadline
        market.expire(j1); // slot 1 missed its commit -> slash held in the market
        assertGt(_job(j1).slashedPool, 0);
        market.expire(j2); // j2: MainMissed

        uint256 j3 = _runVerified(C, l, l, l); // Verified
        assertGt(address(market).balance, 0); // j1 still open
        _revealV(j1, 0, l);
        _publish(j1, l);
        assertEq(uint8(_job(j1).outcome), uint8(JobMarket.Outcome.Verified));
        assertEq(uint8(_job(j2).outcome), uint8(JobMarket.Outcome.MainMissed));
        assertEq(uint8(_job(j3).outcome), uint8(JobMarket.Outcome.Verified));
        assertEq(address(market).balance, 0);
        for (uint256 i = 0; i < providers.length; i++) {
            assertEq(_locks(providers[i]), 0);
        }
    }

    /// After a closed job the providers can withdraw again.
    function test_WithdrawAfterClose() public {
        bytes32[] memory l = _honest(N);
        uint256 id = _toPublishingUnverified(A, l);
        _publish(id, l);
        assertEq(address(market).balance, 0);
        uint256 before = A.balance;
        vm.prank(A);
        registry.withdrawStake(STAKE);
        assertEq(A.balance, before + STAKE);
        assertFalse(registry.isActive(A));
    }
}
