// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {DeGPUBase} from "./DeGPUBase.t.sol";
import {ReplicatedMarket} from "../src/ReplicatedMarket.sol";

/// @notice Compare.Similar task types: no on-chain comparison; the client accepts or disputes
///         during Disputing, and the tie-breaker submits a verdict per disputed item. Verifier
///         leaves deliberately differ from M's (similar results are not bit-identical).
contract SimilarityTest is DeGPUBase {
    uint256 constant SIM = 2; // the similar task type
    uint256 constant TF = TIEBREAK_FEE;

    uint8 constant M_OK = 1;
    uint8 constant V_OK = 2;

    function setUp() public override {
        super.setUp();
        market.addTaskType(keccak256("render runner"), "render-v1", 0, ReplicatedMarket.Compare.Similar);
        for (uint256 i = 0; i < providers.length; i++) {
            vm.prank(providers[i]);
            registry.setPrice(address(market), SIM, PPI);
        }
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    function _createS(address main, bool verify) internal returns (uint256 id) {
        vm.prank(client);
        id = market.createJob{value: DEPOSIT}(main, SIM, N, DATA_HASH, "store:manifest", _verifyCommit(verify), "");
    }

    /// Run a similar job to Disputing. Verifiers' leaves differ from M's on every item.
    function _toDisputing(address main, bool verify) internal returns (uint256 id) {
        bytes32[] memory m = _honest(N);
        bytes32[] memory v = new bytes32[](N);
        for (uint256 i = 0; i < N; i++) {
            v[i] = _wrong(i, 1);
        }
        id = _createS(main, verify);
        _accept(id);
        _commitM(id, m);
        _decide(id, verify);
        if (verify) {
            _shareAll(id);
            _commitV(id, 0, v);
            _commitV(id, 1, v);
            _revealV(id, 0, v);
            _revealV(id, 1, v);
        }
        vm.prank(main);
        market.publishResults(id, m, "store:results");
        assertEq(uint8(_job(id).status), uint8(ReplicatedMarket.Status.Disputing));
    }

    function _dispute(uint256 id, uint256[] memory items) internal returns (address t) {
        vm.prank(client);
        market.dispute{value: TF}(id, items);
        t = _job(id).tiebreaker;
        assertTrue(t != address(0), "no tie-breaker drawn");
        _shareTie(id);
    }

    function _judge(uint256 id, uint8[] memory verdicts) internal {
        vm.prank(_job(id).tiebreaker);
        market.submitJudgement(id, verdicts);
    }

    function _one(uint256 a) internal pure returns (uint256[] memory r) {
        r = new uint256[](1);
        r[0] = a;
    }

    function _two(uint256 a, uint256 b) internal pure returns (uint256[] memory r) {
        r = new uint256[](2);
        r[0] = a;
        r[1] = b;
    }

    function _v1(uint8 a) internal pure returns (uint8[] memory r) {
        r = new uint8[](1);
        r[0] = a;
    }

    function _v2(uint8 a, uint8 b) internal pure returns (uint8[] memory r) {
        r = new uint8[](2);
        r[0] = a;
        r[1] = b;
    }

    // ------------------------------------------------------------------
    // No dispute
    // ------------------------------------------------------------------

    function test_Similar_TaskTypeRecordsCompare() public view {
        (,,, ReplicatedMarket.Compare c) = market.taskTypeOf(SIM);
        assertEq(uint8(c), uint8(ReplicatedMarket.Compare.Similar));
    }

    function test_Similar_VerifiedAccepted() public {
        _snap();
        uint256 id = _toDisputing(A, true);
        address[] memory vs = _verifiers(id);
        vm.prank(client);
        market.acceptResults(id);
        _assertClosed(id, ReplicatedMarket.Outcome.Verified);
        assertEq(_dBal(client), -_i(DEPOSIT));
        assertEq(_dBal(A), _i(PRICE));
        assertEq(_dBal(vs[0]), _i(HALF_FEE));
        assertEq(_dBal(vs[1]), _i(HALF_FEE));
        assertEq(_stat(A, ReplicatedMarket.Stat.VerifiedCompleted), 1);
    }

    function test_Similar_DisputeWindowExpires_Verified() public {
        _snap();
        uint256 id = _toDisputing(A, true);
        vm.expectRevert(bytes("deadline not passed"));
        market.expire(id);
        _pastDeadline(id);
        market.expire(id);
        _assertClosed(id, ReplicatedMarket.Outcome.Verified);
        assertEq(_dBal(A), _i(PRICE));
    }

    function test_Similar_UnverifiedAccepted_Delivered() public {
        _snap();
        uint256 id = _toDisputing(A, false);
        vm.prank(client);
        market.acceptResults(id);
        _assertClosed(id, ReplicatedMarket.Outcome.Delivered);
        assertEq(_dBal(client), -_i(PRICE));
        assertEq(_dBal(A), _i(PRICE));
        assertEq(_stat(A, ReplicatedMarket.Stat.UnverifiedCompleted), 1);
    }

    // ------------------------------------------------------------------
    // Disputes on a verified job
    // ------------------------------------------------------------------

    function test_Similar_Dispute_MainBad() public {
        _snap();
        uint256 id = _toDisputing(A, true);
        address[] memory vs = _verifiers(id);
        address t = _dispute(id, _two(3, 150)); // one item in each verifier's range
        _judge(id, _v2(V_OK, V_OK));
        _assertClosed(id, ReplicatedMarket.Outcome.MainOutvoted);
        assertEq(_dStake(A), -_i(SLASH_WRONG));
        assertEq(_dBal(A), 0);
        assertEq(_dBal(vs[0]), _i(HALF_FEE));
        assertEq(_dBal(vs[1]), _i(HALF_FEE));
        assertEq(_dBal(t), _i(TF));
        assertEq(_dBal(client), _i(SLASH_WRONG) - _i(2 * HALF_FEE + TF)); // +0.278
        assertEq(_stat(A, ReplicatedMarket.Stat.Outvoted), 1);
    }

    function test_Similar_Dispute_VerifierBad() public {
        _snap();
        uint256 id = _toDisputing(A, true);
        address[] memory vs = _verifiers(id);
        address t = _dispute(id, _one(3)); // in slot 0's range
        _judge(id, _v1(M_OK));
        _assertClosed(id, ReplicatedMarket.Outcome.VerifierOutvoted);
        assertEq(_dBal(A), _i(PRICE));
        assertEq(_dStake(vs[0]), -_i(SLASH_WRONG));
        assertEq(_dBal(vs[0]), 0);
        assertEq(_dBal(vs[1]), _i(HALF_FEE));
        assertEq(_dBal(t), _i(TF));
        assertEq(_dBal(client), _i(SLASH_WRONG) - _i(PRICE + HALF_FEE + TF)); // +0.268
        assertEq(uint8(_job(id).vstate[0]), uint8(ReplicatedMarket.VState.Outvoted));
        assertEq(_stat(A, ReplicatedMarket.Stat.VerifiedCompleted), 1);
    }

    /// T finds both sides acceptable: nobody is slashed, and the client pays the tie-breaker.
    function test_Similar_Dispute_BothOk_Rejected() public {
        _snap();
        uint256 id = _toDisputing(A, true);
        address[] memory vs = _verifiers(id);
        address t = _dispute(id, _one(3));
        _judge(id, _v1(M_OK | V_OK));
        _assertClosed(id, ReplicatedMarket.Outcome.DisputeRejected);
        assertEq(_dBal(A), _i(PRICE));
        assertEq(_dBal(vs[0]), _i(HALF_FEE));
        assertEq(_dBal(vs[1]), _i(HALF_FEE));
        assertEq(_dBal(t), _i(TF));
        assertEq(_dBal(client), -_i(DEPOSIT + TF)); // the bond paid the tie-breaker
        assertEq(_stat(A, ReplicatedMarket.Stat.VerifiedCompleted), 1);
    }

    function test_Similar_Dispute_NeitherOk_NoMajority() public {
        _snap();
        uint256 id = _toDisputing(A, true);
        address[] memory vs = _verifiers(id);
        address t = _dispute(id, _one(3));
        _judge(id, _v1(0));
        _assertClosed(id, ReplicatedMarket.Outcome.NoMajority);
        assertEq(_dBal(A), 0); // unpaid, not slashed
        assertEq(_dStake(A), 0);
        assertEq(_dBal(vs[0]), 0); // its item is unresolved
        assertEq(_dBal(vs[1]), _i(HALF_FEE));
        assertEq(_dBal(t), _i(TF));
        assertEq(_dBal(client), -_i(HALF_FEE + TF));
    }

    // ------------------------------------------------------------------
    // Disputes on an unverified job: T judges M alone
    // ------------------------------------------------------------------

    function test_Similar_Unverified_Dispute_MainBad() public {
        _snap();
        uint256 id = _toDisputing(A, false);
        address t = _dispute(id, _two(5, 6));
        _judge(id, _v2(0, M_OK)); // item 5 bad: enough to outvote M
        _assertClosed(id, ReplicatedMarket.Outcome.MainOutvoted);
        assertEq(_dStake(A), -_i(SLASH_WRONG));
        assertEq(_dBal(t), _i(TF));
        assertEq(_dBal(client), _i(SLASH_WRONG) - _i(TF)); // +0.298
    }

    function test_Similar_Unverified_Dispute_MainOk() public {
        _snap();
        uint256 id = _toDisputing(A, false);
        address t = _dispute(id, _one(5));
        _judge(id, _v1(M_OK));
        _assertClosed(id, ReplicatedMarket.Outcome.DisputeRejected);
        assertEq(_dBal(A), _i(PRICE));
        assertEq(_dBal(t), _i(TF));
        assertEq(_dBal(client), -_i(PRICE + TF));
        assertEq(_stat(A, ReplicatedMarket.Stat.UnverifiedCompleted), 1);
    }

    /// With no tie-breaker left, the disputed items stay unresolved and M isn't paid.
    function test_Similar_Dispute_NoTiebreaker() public {
        _deactivateAllBut(A, address(0), address(0));
        _snap();
        uint256 id = _toDisputing(A, false);
        vm.prank(client);
        market.dispute{value: TF}(id, _one(5));
        _assertClosed(id, ReplicatedMarket.Outcome.NoMajority);
        assertEq(_dBal(A), 0);
        assertEq(_dBal(client), 0);
    }

    // ------------------------------------------------------------------
    // Reverts
    // ------------------------------------------------------------------

    function test_Similar_DisputeReverts() public {
        uint256 id = _toDisputing(A, true);
        vm.prank(stranger);
        vm.expectRevert(bytes("not client"));
        market.dispute(id, _one(3));
        vm.startPrank(client);
        vm.expectRevert(bytes("wrong bond"));
        market.dispute{value: TF - 1}(id, _one(3));
        vm.expectRevert(bytes("no items"));
        market.dispute{value: TF}(id, new uint256[](0));
        vm.expectRevert(bytes("bad items"));
        market.dispute{value: TF}(id, _two(5, 3)); // not increasing
        vm.expectRevert(bytes("bad items"));
        market.dispute{value: TF}(id, _two(3, 3)); // duplicate
        vm.expectRevert(bytes("bad items"));
        market.dispute{value: TF}(id, _one(N)); // out of range
        vm.stopPrank();
        vm.prank(stranger);
        vm.expectRevert(bytes("not client"));
        market.acceptResults(id);
        _pastDeadline(id);
        vm.prank(client);
        vm.expectRevert(bytes("deadline passed"));
        market.dispute{value: TF}(id, _one(3));
    }

    function test_Similar_JudgementReverts() public {
        uint256 id = _toDisputing(A, true);
        vm.prank(client);
        market.dispute{value: TF}(id, _two(3, 150));
        address t = _job(id).tiebreaker;
        vm.prank(t);
        vm.expectRevert(bytes("tie not shared"));
        market.submitJudgement(id, _v2(M_OK, M_OK));
        _shareTie(id);
        vm.prank(stranger);
        vm.expectRevert(bytes("not tiebreaker"));
        market.submitJudgement(id, _v2(M_OK, M_OK));
        vm.startPrank(t);
        vm.expectRevert(bytes("bad length"));
        market.submitJudgement(id, _v1(M_OK));
        vm.expectRevert(bytes("wrong compare"));
        market.submitTiebreak(id, new bytes32[](2)); // leaves are for Compare.Exact tasks only
        vm.stopPrank();
    }

    /// Exact tasks never enter Disputing, and their tie-breaker can't submit verdicts.
    function test_Exact_HasNoDisputesOrJudgements() public {
        bytes32[] memory l = _honest(N);
        uint256 done = _runVerified(A, l, l, l);
        vm.prank(client);
        vm.expectRevert(bytes("wrong status"));
        market.dispute{value: TF}(done, _one(3));

        bytes32[] memory m = _honest(N);
        m[3] = _wrong(3, 1);
        uint256 id = _toPublishingVerified(A, m, l, l);
        _publish(id, m);
        assertEq(uint8(_job(id).status), uint8(ReplicatedMarket.Status.TieBreak));
        _shareTie(id);
        vm.prank(_job(id).tiebreaker);
        vm.expectRevert(bytes("wrong compare"));
        market.submitJudgement(id, _v1(M_OK));
    }
}
