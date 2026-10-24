// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {DeGPUBase} from "./DeGPUBase.t.sol";
import {JobMarket} from "../src/JobMarket.sol";
import {ProviderRegistry} from "../src/ProviderRegistry.sol";

/// @notice One test per row of the "Settlement on close" table (INTERFACE.md section 7).
///         Every job uses N = 200, k = 20 (price 0.02 ETH, fee 0.002 ETH) unless noted.
///         Balance deltas are measured from just before createJob, so the client's delta includes
///         what it paid in.
contract SettlementTest is DeGPUBase {
    // Stats shorthands
    ProviderRegistry.Stat constant VERIFIED = ProviderRegistry.Stat.VerifiedCompleted;
    ProviderRegistry.Stat constant UNVERIFIED = ProviderRegistry.Stat.UnverifiedCompleted;
    ProviderRegistry.Stat constant MISSED = ProviderRegistry.Stat.Missed;
    ProviderRegistry.Stat constant OUTVOTED = ProviderRegistry.Stat.Outvoted;
    ProviderRegistry.Stat constant CHECKS_DONE = ProviderRegistry.Stat.ChecksCompleted;
    ProviderRegistry.Stat constant CHECKS_MISSED = ProviderRegistry.Stat.ChecksMissed;
    ProviderRegistry.Stat constant CHECKS_OUTVOTED = ProviderRegistry.Stat.ChecksOutvoted;

    function _allStats(address p) internal view returns (uint256 sum) {
        for (uint8 s = 0; s < 7; s++) {
            sum += registry.statOf(p, ProviderRegistry.Stat(s));
        }
    }

    /// Everybody not listed must be untouched (balance, stake, stats).
    function _assertUntouched(address p) internal view {
        assertEq(_dBal(p), 0, "untouched balance");
        assertEq(_dStake(p), 0, "untouched stake");
        assertEq(_allStats(p), 0, "untouched stats");
    }

    // ------------------------------------------------------------------
    // Cancelled
    // ------------------------------------------------------------------

    function test_Cancelled_ByClient() public {
        _snap();
        uint256 id = _create(A, N, K);
        assertEq(address(market).balance, PRICE + FEE);

        vm.expectEmit(true, true, false, true, address(market));
        emit JobMarket.Payout(id, client, PRICE + FEE);
        vm.expectEmit(true, false, false, true, address(market));
        emit JobMarket.JobClosed(id, JobMarket.Outcome.Cancelled);
        vm.prank(client);
        market.cancel(id);

        _assertClosed(id, JobMarket.Outcome.Cancelled);
        assertEq(_dBal(client), 0);
        _assertUntouched(A);
    }

    function test_Cancelled_ByExpire() public {
        _snap();
        uint256 id = _create(A, N, K);
        _pastDeadline(id);
        vm.prank(stranger);
        market.expire(id);
        _assertClosed(id, JobMarket.Outcome.Cancelled);
        assertEq(_dBal(client), 0);
        _assertUntouched(A);
    }

    function test_Cancelled_ByAnyoneAfterDeadline() public {
        _snap();
        uint256 id = _create(A, N, K);
        _pastDeadline(id);
        vm.prank(stranger);
        market.cancel(id);
        _assertClosed(id, JobMarket.Outcome.Cancelled);
        assertEq(_dBal(client), 0);
    }

    // ------------------------------------------------------------------
    // Delivered
    // ------------------------------------------------------------------

    function test_Delivered_NoSample() public {
        _snap();
        uint256 id = _create(A, N, 0);
        address v = _accept(id);
        assertEq(v, address(0));
        assertEq(_locks(A), 1);
        JobMarket.Job memory j = _job(id);
        assertEq(uint8(j.status), uint8(JobMarket.Status.Publishing));
        assertEq(j.deadline, block.timestamp + 600); // computeWindow
        assertEq(j.fee, 0);

        _publish(id, _honest(N));

        _assertClosed(id, JobMarket.Outcome.Delivered);
        assertEq(uint8(_job(id).drop), uint8(JobMarket.Drop.None));
        assertEq(_dBal(client), -_i(PRICE));
        assertEq(_dBal(A), _i(PRICE));
        assertEq(_stat(A, UNVERIFIED), 1);
        assertEq(_allStats(A), 1);
    }

    function test_Delivered_NoEligibleVerifier() public {
        _deactivateAllBut(A, address(0));
        _snap();
        uint256 id = _create(A, N, K);

        vm.expectEmit(true, false, false, true, address(market));
        emit JobMarket.VerificationDropped(id, JobMarket.Drop.NoEligibleVerifier);
        address v = _accept(id);

        assertEq(v, address(0));
        JobMarket.Job memory j = _job(id);
        assertEq(uint8(j.drop), uint8(JobMarket.Drop.NoEligibleVerifier));
        assertEq(uint8(j.status), uint8(JobMarket.Status.Publishing));
        assertEq(j.deadline, block.timestamp + 600); // computeWindow

        _publish(id, _honest(N));

        _assertClosed(id, JobMarket.Outcome.Delivered);
        assertEq(_dBal(client), -_i(PRICE)); // fee refunded
        assertEq(_dBal(A), _i(PRICE));
        assertEq(_stat(A, UNVERIFIED), 1);
    }

    function test_Delivered_ClientNoShare() public {
        bytes32[] memory leaves = _honest(N);
        _snap();
        uint256 id = _create(A, N, K);
        address v = _accept(id);
        _commitM(id, leaves);
        // the client never shares the sample
        _pastDeadline(id);
        market.expire(id);

        JobMarket.Job memory j = _job(id);
        assertEq(uint8(j.drop), uint8(JobMarket.Drop.ClientNoShare));
        assertEq(uint8(j.status), uint8(JobMarket.Status.Publishing));
        assertEq(j.deadline, block.timestamp + 300); // publishWindow
        assertEq(_locks(v), 1); // V stays locked until close

        _publish(id, leaves);

        _assertClosed(id, JobMarket.Outcome.Delivered);
        assertEq(_dBal(client), -_i(PRICE + FEE)); // fee forfeited to V
        assertEq(_dBal(A), _i(PRICE));
        assertEq(_dBal(v), _i(FEE));
        assertEq(_stat(A, UNVERIFIED), 1);
        assertEq(_allStats(v), 0);
    }

    function test_Delivered_BadInput() public {
        _snap();
        uint256 id = _create(A, N, K);
        address v = _accept(id);
        _share(id);

        vm.prank(v);
        market.reportBadInput(id);

        JobMarket.Job memory j = _job(id);
        assertEq(uint8(j.drop), uint8(JobMarket.Drop.BadInput));
        assertEq(uint8(j.status), uint8(JobMarket.Status.Publishing));
        assertEq(j.deadline, block.timestamp + 600); // computeWindow
        assertEq(_locks(v), 0); // V unlocked right away

        _publish(id, _honest(N)); // M had not committed: no commitment to check

        _assertClosed(id, JobMarket.Outcome.Delivered);
        assertEq(_dBal(client), -_i(PRICE)); // fee refunded
        assertEq(_dBal(A), _i(PRICE));
        assertEq(_stat(A, UNVERIFIED), 1);
        _assertUntouched(v);
    }

    function test_Delivered_BadInput_AfterMainCommitted() public {
        bytes32[] memory leaves = _honest(N);
        _snap();
        uint256 id = _create(A, N, K);
        address v = _accept(id);
        _commitM(id, leaves);
        _share(id);
        vm.prank(v);
        market.reportBadInput(id);
        // M's commitment still binds its published leaves
        bytes32[] memory other = _honest(N);
        other[5] = _wrong(5, 1);
        vm.prank(A);
        vm.expectRevert(bytes("resultsCommit mismatch"));
        market.publishResults(id, other);

        _publish(id, leaves);
        _assertClosed(id, JobMarket.Outcome.Delivered);
        assertEq(_dBal(client), -_i(PRICE));
        assertEq(_dBal(A), _i(PRICE));
        _assertUntouched(v);
    }

    function test_Delivered_VerifierMissed_InCommitting() public {
        bytes32[] memory leaves = _honest(N);
        _snap();
        uint256 id = _create(A, N, K);
        address v = _accept(id);
        _share(id);
        _commitM(id, leaves);
        // V never commits
        _pastDeadline(id);

        vm.expectEmit(true, true, false, true, address(market));
        emit JobMarket.ProviderSlashed(id, v, SLASH_CHECK);
        market.expire(id);

        JobMarket.Job memory j = _job(id);
        assertEq(uint8(j.drop), uint8(JobMarket.Drop.VerifierMissed));
        assertEq(uint8(j.status), uint8(JobMarket.Status.Publishing));
        assertEq(j.deadline, block.timestamp + 300); // publishWindow
        assertEq(j.verifierSlash, SLASH_CHECK);
        assertEq(address(market).balance, PRICE + FEE + SLASH_CHECK);
        assertEq(_locks(v), 0);

        _publish(id, leaves);

        _assertClosed(id, JobMarket.Outcome.Delivered);
        assertEq(_dBal(client), -_i(PRICE) + _i(SLASH_CHECK)); // fee + V's slash back
        assertEq(_dBal(A), _i(PRICE));
        assertEq(_dBal(v), 0);
        assertEq(_dStake(v), -_i(SLASH_CHECK));
        assertEq(_stat(A, UNVERIFIED), 1);
        assertEq(_stat(v, CHECKS_MISSED), 1);
        assertEq(_allStats(v), 1);
    }

    function test_Delivered_VerifierMissed_InSampleReveal() public {
        bytes32[] memory leaves = _honest(N);
        bytes32[] memory vLeaves = _pick(leaves, _indices(N, K));
        _snap();
        uint256 id = _create(A, N, K);
        address v = _accept(id);
        _share(id);
        _commitM(id, leaves);
        _commitV(id, vLeaves);
        assertEq(uint8(_job(id).status), uint8(JobMarket.Status.SampleReveal));
        assertEq(_job(id).deadline, block.timestamp + 300); // revealWindow
        // V never reveals
        _pastDeadline(id);
        market.expire(id);

        JobMarket.Job memory j = _job(id);
        assertEq(uint8(j.drop), uint8(JobMarket.Drop.VerifierMissed));
        assertEq(uint8(j.status), uint8(JobMarket.Status.Publishing));
        assertEq(j.verifierSlash, SLASH_CHECK);

        _publish(id, leaves);

        _assertClosed(id, JobMarket.Outcome.Delivered);
        assertEq(_dBal(client), -_i(PRICE) + _i(SLASH_CHECK));
        assertEq(_dBal(A), _i(PRICE));
        assertEq(_dBal(v), 0);
        assertEq(_dStake(v), -_i(SLASH_CHECK));
        assertEq(_stat(A, UNVERIFIED), 1);
        assertEq(_stat(v, CHECKS_MISSED), 1);
    }

    // ------------------------------------------------------------------
    // Verified
    // ------------------------------------------------------------------

    function test_Verified() public {
        bytes32[] memory leaves = _honest(N);
        bytes32[] memory vLeaves = _pick(leaves, _indices(N, K));
        _snap();
        uint256 id = _toPublishing(A, leaves, vLeaves);
        address v = _job(id).verifier;

        vm.expectEmit(true, true, false, true, address(market));
        emit JobMarket.Payout(id, A, PRICE);
        vm.expectEmit(true, true, false, true, address(market));
        emit JobMarket.Payout(id, v, FEE);
        vm.expectEmit(true, false, false, true, address(market));
        emit JobMarket.JobClosed(id, JobMarket.Outcome.Verified);
        _publish(id, leaves);

        _assertClosed(id, JobMarket.Outcome.Verified);
        assertEq(_dBal(client), -_i(PRICE + FEE));
        assertEq(_dBal(A), _i(PRICE));
        assertEq(_dBal(v), _i(FEE));
        assertEq(_stat(A, VERIFIED), 1);
        assertEq(_stat(v, CHECKS_DONE), 1);
        assertEq(_allStats(A) + _allStats(v), 2);
        // revealSample stored the sample
        assertEq(_job(id).sampleIndices.length, K);
        assertEq(_job(id).verifierLeaves.length, K);
    }

    /// With maxMismatch = 1, a single disagreement still counts as Verified.
    function test_Verified_WithinMaxMismatch() public {
        JobMarket.Params memory p = demoParams();
        p.maxMismatch = 1;
        _deploy(p);
        for (uint256 i = 0; i < providers.length; i++) {
            vm.prank(providers[i]);
            registry.register{value: STAKE}(bytes32(i + 1), PPI);
        }
        bytes32[] memory leaves = _honest(N);
        bytes32[] memory vLeaves = _pick(leaves, _indices(N, K));
        vLeaves[3] = _wrong(30, 1);
        _snap();
        uint256 id = _runVerified(A, leaves, vLeaves);
        _assertClosed(id, JobMarket.Outcome.Verified);
        assertEq(_dBal(A), _i(PRICE));
        assertEq(_dBal(_job(id).verifier), _i(FEE));
    }

    // ------------------------------------------------------------------
    // Tie-break outcomes
    // ------------------------------------------------------------------

    function test_MainOutvoted() public {
        bytes32[] memory honest = _honest(N);
        bytes32[] memory mLeaves = _honest(N);
        mLeaves[10] = _wrong(10, 1); // M cheats on a sampled item
        bytes32[] memory vLeaves = _pick(honest, _indices(N, K));
        _snap();
        uint256 id = _runVerified(A, mLeaves, vLeaves);

        JobMarket.Job memory j = _job(id);
        address v = j.verifier;
        address t = j.tiebreaker;
        assertEq(uint8(j.status), uint8(JobMarket.Status.TieBreak));
        assertEq(j.deadline, block.timestamp + 600); // tiebreakWindow
        assertEq(j.mismatched.length, 1);
        assertEq(j.mismatched[0], 10);
        assertEq(j.mainMismatchLeaves[0], mLeaves[10]);
        assertEq(j.verifierMismatchLeaves[0], honest[10]);
        assertEq(_locks(t), 1);

        _shareTie(id);
        bytes32[] memory tLeaves = new bytes32[](1);
        tLeaves[0] = honest[10];
        _submitTie(id, tLeaves);

        _assertClosed(id, JobMarket.Outcome.MainOutvoted);
        assertEq(_dStake(A), -_i(SLASH_WRONG));
        assertEq(_dBal(A), 0);
        // client: paid 0.022, gets price + S_M - tf = 0.02 + 0.3 - 0.002 -> net +0.296
        assertEq(_dBal(client), _i(PRICE + SLASH_WRONG - TIEBREAK_FEE) - _i(PRICE + FEE));
        assertEq(_dBal(client), 0.296 ether);
        assertEq(_dBal(v), _i(FEE));
        assertEq(_dBal(t), _i(TIEBREAK_FEE));
        assertEq(_stat(A, OUTVOTED), 1);
        assertEq(_stat(v, CHECKS_DONE), 1);
        assertEq(_stat(t, CHECKS_DONE), 1);
        assertEq(_allStats(A) + _allStats(v) + _allStats(t), 3);
    }

    function test_VerifierOutvoted() public {
        bytes32[] memory honest = _honest(N);
        bytes32[] memory vLeaves = _pick(honest, _indices(N, K));
        vLeaves[2] = _wrong(20, 7); // V lies about item 20
        _snap();
        uint256 id = _runVerified(A, honest, vLeaves);

        JobMarket.Job memory j = _job(id);
        address v = j.verifier;
        address t = j.tiebreaker;
        assertEq(j.mismatched.length, 1);
        assertEq(j.mismatched[0], 20);

        _shareTie(id);
        bytes32[] memory tLeaves = new bytes32[](1);
        tLeaves[0] = honest[20];
        _submitTie(id, tLeaves);

        _assertClosed(id, JobMarket.Outcome.VerifierOutvoted);
        assertEq(_dStake(v), -_i(SLASH_WRONG));
        assertEq(_dBal(v), 0);
        // main: price + S_V - tf = 0.02 + 0.3 - 0.002 = 0.318
        assertEq(_dBal(A), 0.318 ether);
        assertEq(_dBal(client), -_i(PRICE)); // fee refunded
        assertEq(_dBal(t), _i(TIEBREAK_FEE));
        assertEq(_stat(A, VERIFIED), 1);
        assertEq(_stat(v, CHECKS_OUTVOTED), 1);
        assertEq(_stat(t, CHECKS_DONE), 1);
        assertEq(_allStats(A) + _allStats(v) + _allStats(t), 3);
    }

    function test_BothOutvoted() public {
        bytes32[] memory honest = _honest(N);
        bytes32[] memory mLeaves = _honest(N);
        mLeaves[10] = _wrong(10, 1); // M wrong on item 10
        bytes32[] memory vLeaves = _pick(honest, _indices(N, K));
        vLeaves[2] = _wrong(20, 2); // V wrong on item 20
        _snap();
        uint256 id = _runVerified(A, mLeaves, vLeaves);

        JobMarket.Job memory j = _job(id);
        address v = j.verifier;
        address t = j.tiebreaker;
        assertEq(j.mismatched.length, 2);
        assertEq(j.mismatched[0], 10);
        assertEq(j.mismatched[1], 20);

        _shareTie(id);
        bytes32[] memory tLeaves = new bytes32[](2);
        tLeaves[0] = honest[10];
        tLeaves[1] = honest[20];
        _submitTie(id, tLeaves);

        _assertClosed(id, JobMarket.Outcome.BothOutvoted);
        assertEq(_dStake(A), -_i(SLASH_WRONG));
        assertEq(_dStake(v), -_i(SLASH_WRONG));
        assertEq(_dBal(A), 0);
        assertEq(_dBal(v), 0);
        // client: full refund + both slashes - tf
        assertEq(_dBal(client), _i(2 * SLASH_WRONG - TIEBREAK_FEE));
        assertEq(_dBal(t), _i(TIEBREAK_FEE));
        assertEq(_stat(A, OUTVOTED), 1);
        assertEq(_stat(v, CHECKS_OUTVOTED), 1);
        assertEq(_stat(t, CHECKS_DONE), 1);
    }

    /// One item with no majority and one where V is outvoted -> VerifierOutvoted ("any V outvoted").
    function test_VerifierOutvoted_MixedWithNoMajorityItem() public {
        bytes32[] memory honest = _honest(N);
        bytes32[] memory mLeaves = _honest(N);
        mLeaves[10] = _wrong(10, 1);
        bytes32[] memory vLeaves = _pick(honest, _indices(N, K));
        vLeaves[1] = _wrong(10, 2); // item 10: M, V and T all differ
        vLeaves[2] = _wrong(20, 3); // item 20: V alone is wrong
        _snap();
        uint256 id = _runVerified(A, mLeaves, vLeaves);
        _shareTie(id);
        bytes32[] memory tLeaves = new bytes32[](2);
        tLeaves[0] = honest[10];
        tLeaves[1] = honest[20];
        _submitTie(id, tLeaves);
        _assertClosed(id, JobMarket.Outcome.VerifierOutvoted);
        assertEq(_dBal(A), 0.318 ether);
    }

    function test_NoMajority_AllDifferent() public {
        bytes32[] memory honest = _honest(N);
        bytes32[] memory mLeaves = _honest(N);
        mLeaves[10] = _wrong(10, 1);
        bytes32[] memory vLeaves = _pick(honest, _indices(N, K));
        vLeaves[1] = _wrong(10, 2);
        _snap();
        uint256 id = _runVerified(A, mLeaves, vLeaves);
        JobMarket.Job memory j = _job(id);
        address v = j.verifier;
        address t = j.tiebreaker;

        _shareTie(id);
        bytes32[] memory tLeaves = new bytes32[](1);
        tLeaves[0] = honest[10]; // a third, different answer
        _submitTie(id, tLeaves);

        _assertClosed(id, JobMarket.Outcome.NoMajority);
        // tf = min(fee, tiebreakFee) = 0.002; client gets price + fee - tf back
        assertEq(_dBal(client), -_i(TIEBREAK_FEE));
        assertEq(_dBal(t), _i(TIEBREAK_FEE));
        assertEq(_stat(t, CHECKS_DONE), 1);
        _assertUntouched(A);
        _assertUntouched(v);
    }

    function test_NoMajority_NoEligibleTiebreaker() public {
        bytes32[] memory honest = _honest(N);
        bytes32[] memory mLeaves = _honest(N);
        mLeaves[10] = _wrong(10, 1);
        bytes32[] memory vLeaves = _pick(honest, _indices(N, K));
        _snap();
        uint256 id = _create(A, N, K);
        address v = _accept(id);
        _deactivateAllBut(A, v); // nobody left to break the tie
        _share(id);
        _commitM(id, mLeaves);
        _commitV(id, vLeaves);
        _reveal(id, vLeaves);
        _publish(id, mLeaves);

        JobMarket.Job memory j = _job(id);
        assertEq(j.tiebreaker, address(0));
        assertEq(j.mismatched.length, 1);
        _assertClosed(id, JobMarket.Outcome.NoMajority);
        assertEq(_dBal(client), 0); // tf = 0: full refund
        _assertUntouched(A);
        _assertUntouched(v);
    }

    // ------------------------------------------------------------------
    // MainMissed
    // ------------------------------------------------------------------

    function test_MainMissed_InCommitting_VerifierNotCommitted() public {
        _snap();
        uint256 id = _create(A, N, K);
        address v = _accept(id);
        _share(id);
        // neither commits
        _pastDeadline(id);
        market.expire(id);

        _assertClosed(id, JobMarket.Outcome.MainMissed);
        assertEq(_dStake(A), -_i(SLASH_MISSED));
        assertEq(_dBal(client), _i(SLASH_MISSED)); // full refund + S_M
        assertEq(_stat(A, MISSED), 1);
        assertEq(_allStats(A), 1);
        _assertUntouched(v);
    }

    function test_MainMissed_InCommitting_VerifierCommitted() public {
        bytes32[] memory vLeaves = _pick(_honest(N), _indices(N, K));
        _snap();
        uint256 id = _create(A, N, K);
        address v = _accept(id);
        _share(id);
        _commitV(id, vLeaves);
        // M never commits
        _pastDeadline(id);
        market.expire(id);

        _assertClosed(id, JobMarket.Outcome.MainMissed);
        // vPay = min(S_M, fee) = 0.002
        assertEq(_dStake(A), -_i(SLASH_MISSED));
        assertEq(_dBal(v), _i(FEE));
        assertEq(_dBal(client), _i(SLASH_MISSED - FEE));
        assertEq(_stat(A, MISSED), 1);
        assertEq(_stat(v, CHECKS_DONE), 1);
    }

    /// Demo scenario 5: unverified job, main never publishes.
    function test_MainMissed_InPublishing_NoSample() public {
        _snap();
        uint256 id = _create(F, N, 0);
        _accept(id);
        _pastDeadline(id);
        market.expire(id);

        _assertClosed(id, JobMarket.Outcome.MainMissed);
        assertEq(_dStake(F), -_i(SLASH_MISSED));
        assertEq(_dBal(client), 0.1 ether);
        assertEq(_stat(F, MISSED), 1);
    }

    function test_MainMissed_InPublishing_AfterReveal() public {
        bytes32[] memory leaves = _honest(N);
        bytes32[] memory vLeaves = _pick(leaves, _indices(N, K));
        _snap();
        uint256 id = _toPublishing(A, leaves, vLeaves);
        address v = _job(id).verifier;
        // M never publishes
        _pastDeadline(id);
        market.expire(id);

        _assertClosed(id, JobMarket.Outcome.MainMissed);
        assertEq(_dStake(A), -_i(SLASH_MISSED));
        assertEq(_dBal(v), _i(FEE));
        assertEq(_dBal(client), _i(SLASH_MISSED - FEE));
        assertEq(_stat(A, MISSED), 1);
        assertEq(_stat(v, CHECKS_DONE), 1);
    }

    /// V committed but missed the reveal (slashed, dropped); then M also misses publishing.
    /// V is not paid from M's slash, and V's slash goes to the client.
    function test_MainMissed_InPublishing_AfterVerifierMissed() public {
        bytes32[] memory leaves = _honest(N);
        bytes32[] memory vLeaves = _pick(leaves, _indices(N, K));
        _snap();
        uint256 id = _create(A, N, K);
        address v = _accept(id);
        _share(id);
        _commitM(id, leaves);
        _commitV(id, vLeaves);
        _pastDeadline(id);
        market.expire(id); // VerifierMissed drop
        _pastDeadline(id);
        market.expire(id); // MainMissed

        _assertClosed(id, JobMarket.Outcome.MainMissed);
        assertEq(_dStake(A), -_i(SLASH_MISSED));
        assertEq(_dStake(v), -_i(SLASH_CHECK));
        assertEq(_dBal(v), 0);
        assertEq(_dBal(client), _i(SLASH_MISSED + SLASH_CHECK));
        assertEq(_stat(A, MISSED), 1);
        assertEq(_stat(v, CHECKS_MISSED), 1);
        assertEq(_stat(v, CHECKS_DONE), 0);
    }

    // ------------------------------------------------------------------
    // TiebreakerMissed and TieClientNoShare
    // ------------------------------------------------------------------

    function _toTieBreak() internal returns (uint256 id) {
        bytes32[] memory mLeaves = _honest(N);
        mLeaves[10] = _wrong(10, 1);
        bytes32[] memory vLeaves = _pick(_honest(N), _indices(N, K));
        id = _runVerified(A, mLeaves, vLeaves);
        assertEq(uint8(_job(id).status), uint8(JobMarket.Status.TieBreak));
    }

    function test_TiebreakerMissed() public {
        _snap();
        uint256 id = _toTieBreak();
        address v = _job(id).verifier;
        address t = _job(id).tiebreaker;
        _shareTie(id);
        // T never submits
        _pastDeadline(id);
        market.expire(id);

        _assertClosed(id, JobMarket.Outcome.TiebreakerMissed);
        assertEq(_dStake(t), -_i(SLASH_CHECK));
        assertEq(_dBal(t), 0);
        assertEq(_dBal(client), _i(SLASH_CHECK)); // full refund + S_T
        assertEq(_stat(t, CHECKS_MISSED), 1);
        assertEq(_allStats(t), 1);
        _assertUntouched(A);
        _assertUntouched(v);
    }

    function test_TieClientNoShare_ClientNeverShares() public {
        _snap();
        uint256 id = _toTieBreak();
        address v = _job(id).verifier;
        address t = _job(id).tiebreaker;
        // the client never shares the tie items
        _pastDeadline(id);
        market.expire(id);

        _assertClosed(id, JobMarket.Outcome.TieClientNoShare);
        assertEq(_dBal(A), _i(PRICE));
        assertEq(_dBal(v), _i(FEE));
        assertEq(_dBal(client), -_i(PRICE + FEE));
        assertEq(_stat(A, UNVERIFIED), 1);
        assertEq(_stat(v, CHECKS_DONE), 1);
        _assertUntouched(t);
    }

    function test_TieClientNoShare_TiebreakerReportsBadInput() public {
        _snap();
        uint256 id = _toTieBreak();
        address v = _job(id).verifier;
        address t = _job(id).tiebreaker;
        _shareTie(id);
        vm.prank(t);
        market.reportBadInput(id);

        _assertClosed(id, JobMarket.Outcome.TieClientNoShare);
        assertEq(_dBal(A), _i(PRICE));
        assertEq(_dBal(v), _i(FEE));
        assertEq(_dBal(client), -_i(PRICE + FEE));
        assertEq(_stat(A, UNVERIFIED), 1);
        assertEq(_stat(v, CHECKS_DONE), 1);
        _assertUntouched(t);
    }

    // ------------------------------------------------------------------
    // Misc
    // ------------------------------------------------------------------

    /// Price and fee are pinned at createJob: a later price change doesn't affect the job.
    function test_PricePinnedAtCreate() public {
        _snap();
        uint256 id = _create(A, N, 0);
        vm.prank(A);
        registry.setPrice(1 ether);
        _accept(id);
        _publish(id, _honest(N));
        _assertClosed(id, JobMarket.Outcome.Delivered);
        assertEq(_dBal(A), _i(PRICE));
    }

    /// Several overlapping jobs (one holding a verifier slash) leave the market empty once all close.
    function test_ConcurrentJobs_MarketEndsEmpty() public {
        bytes32[] memory leaves = _honest(N);
        bytes32[] memory vLeaves = _pick(leaves, _indices(N, K));
        uint256 j1 = _create(A, N, K);
        uint256 j2 = _create(B, N, 0);
        _accept(j1);
        _accept(j2);
        _share(j1);
        _commitM(j1, leaves);
        _pastDeadline(j1); // also past j2's deadline
        market.expire(j1); // j1: verifier missed its commit -> slash held in the market
        assertGt(_job(j1).verifierSlash, 0);
        market.expire(j2); // j2: MainMissed

        uint256 j3 = _create(C, N, K);
        _accept(j3);
        _share(j3);
        _commitM(j3, leaves);
        _commitV(j3, vLeaves);
        _reveal(j3, vLeaves);
        _publish(j3, leaves); // j3: Verified
        assertGt(address(market).balance, 0); // j1 still open, holding price + fee + V's slash
        _publish(j1, leaves); // j1: Delivered
        assertEq(uint8(_job(j1).outcome), uint8(JobMarket.Outcome.Delivered));
        assertEq(uint8(_job(j2).outcome), uint8(JobMarket.Outcome.MainMissed));
        assertEq(uint8(_job(j3).outcome), uint8(JobMarket.Outcome.Verified));
        assertEq(address(market).balance, 0);
        for (uint256 i = 0; i < providers.length; i++) {
            assertEq(_locks(providers[i]), 0);
        }
    }

    /// After a closed job the providers can withdraw again.
    function test_WithdrawAfterClose() public {
        uint256 id = _create(A, N, 0);
        _accept(id);
        _publish(id, _honest(N));
        assertEq(address(market).balance, 0);
        uint256 before = A.balance;
        vm.prank(A);
        registry.withdrawStake(STAKE);
        assertEq(A.balance, before + STAKE);
        assertFalse(registry.isActive(A));
    }
}
