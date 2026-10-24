// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {DeGPUBase} from "./DeGPUBase.t.sol";
import {ReplicatedMarket} from "../src/ReplicatedMarket.sol";
import {ProviderRegistry} from "../src/ProviderRegistry.sol";

/// @notice Wrong caller, wrong phase, wrong value, bad commitments, wrong lengths, locked stake and
///         late actions all revert.
contract RevertsTest is DeGPUBase {
    bytes constant WRONG_STATUS = bytes("wrong status");
    bytes constant LATE = bytes("deadline passed");

    /// A verified job in Checking with both ranges shared; returns its verifiers.
    function _toChecking() internal returns (uint256 id, address[] memory vs) {
        id = _create(A, N, true);
        _accept(id);
        _commitM(id, _honest(N));
        vs = _decide(id, true);
        _shareAll(id);
    }

    /// A verified job where M is wrong on item 0, now in TieBreak; returns the tie-breaker.
    function _toTieBreak() internal returns (uint256 id, address t) {
        bytes32[] memory m = _honest(N);
        m[0] = _wrong(0, 1);
        id = _runVerified(A, m, _honest(N), _honest(N));
        t = _job(id).tiebreaker;
        assertEq(uint8(_job(id).status), uint8(ReplicatedMarket.Status.TieBreak));
    }

    // ------------------------------------------------------------------
    // createJob / cancel / accept
    // ------------------------------------------------------------------

    function test_Create_WrongValue() public {
        bytes32 c = _verifyCommit(true);
        vm.startPrank(client);
        vm.expectRevert(bytes("wrong value"));
        market.createJob{value: PRICE}(A, TASK, N, DATA_HASH, "u", c, ""); // price only: would leak "no"
        vm.expectRevert(bytes("wrong value"));
        market.createJob{value: DEPOSIT + 1}(A, TASK, N, DATA_HASH, "u", c, "");
        vm.stopPrank();
    }

    function test_Create_BadArguments() public {
        bytes32 c = _verifyCommit(true);
        vm.startPrank(client);
        vm.expectRevert(bytes("unknown task type"));
        market.createJob{value: DEPOSIT}(A, 2, N, DATA_HASH, "u", c, "");
        vm.expectRevert(bytes("main not active"));
        market.createJob{value: DEPOSIT}(stranger, TASK, N, DATA_HASH, "u", c, "");
        vm.expectRevert(bytes("bad numItems"));
        market.createJob{value: 0}(A, TASK, 0, DATA_HASH, "u", c, "");
        vm.expectRevert(bytes("bad numItems"));
        market.createJob{value: 2 * 1001 * PPI}(A, TASK, 1001, DATA_HASH, "u", c, "");
        vm.expectRevert(bytes("zero verifyCommit"));
        market.createJob{value: DEPOSIT}(A, TASK, N, DATA_HASH, "u", bytes32(0), "");
        vm.stopPrank();
        vm.prank(A);
        vm.expectRevert(bytes("main is client"));
        market.createJob{value: DEPOSIT}(A, TASK, N, DATA_HASH, "u", c, "");
    }

    function test_Cancel_Reverts() public {
        uint256 id = _create(A, N, false);
        vm.prank(stranger);
        vm.expectRevert(bytes("not client"));
        market.cancel(id);
        _accept(id);
        vm.prank(client);
        vm.expectRevert(WRONG_STATUS);
        market.cancel(id);
    }

    function test_Accept_Reverts() public {
        uint256 id = _create(A, N, false);
        vm.prank(B);
        vm.expectRevert(bytes("not main"));
        market.accept(id);
        vm.prank(A);
        vm.expectRevert(WRONG_STATUS);
        market.accept(id + 1); // nonexistent
        _accept(id);
        vm.prank(A);
        vm.expectRevert(WRONG_STATUS);
        market.accept(id);

        uint256 late = _create(A, N, false);
        _pastDeadline(late);
        vm.prank(A);
        vm.expectRevert(LATE);
        market.accept(late);

        uint256 inactive = _create(B, N, false);
        vm.prank(B);
        registry.withdrawStake(0.5 ether);
        vm.prank(B);
        vm.expectRevert(bytes("main not active"));
        market.accept(inactive);
    }

    // ------------------------------------------------------------------
    // commitResults / revealDecision
    // ------------------------------------------------------------------

    function test_CommitResults_Reverts() public {
        uint256 id = _create(A, N, true);
        vm.prank(A);
        vm.expectRevert(WRONG_STATUS); // not accepted yet
        market.commitResults(id, keccak256("x"));
        _accept(id);
        vm.prank(B);
        vm.expectRevert(bytes("not main"));
        market.commitResults(id, keccak256("x"));
        vm.prank(A);
        vm.expectRevert(bytes("zero commit"));
        market.commitResults(id, bytes32(0));
        _commitM(id, _honest(N));
        vm.prank(A);
        vm.expectRevert(WRONG_STATUS); // already moved on to Deciding
        market.commitResults(id, keccak256("y"));

        uint256 late = _create(A, N, true);
        _accept(late);
        _pastDeadline(late);
        vm.prank(A);
        vm.expectRevert(LATE);
        market.commitResults(late, keccak256("x"));
    }

    function test_RevealDecision_Reverts() public {
        uint256 id = _create(A, N, true);
        _accept(id);
        vm.prank(client);
        vm.expectRevert(WRONG_STATUS); // M hasn't committed: too early to reveal
        market.revealDecision(id, VERIFY_SALT, true);
        _commitM(id, _honest(N));
        vm.prank(stranger);
        vm.expectRevert(bytes("not client"));
        market.revealDecision(id, VERIFY_SALT, true);
        vm.startPrank(client);
        vm.expectRevert(bytes("verifyCommit mismatch"));
        market.revealDecision(id, VERIFY_SALT, false);
        vm.expectRevert(bytes("verifyCommit mismatch"));
        market.revealDecision(id, keccak256("other salt"), true);
        vm.stopPrank();
        _pastDeadline(id);
        vm.prank(client);
        vm.expectRevert(LATE);
        market.revealDecision(id, VERIFY_SALT, true);
    }

    // ------------------------------------------------------------------
    // Checking / CheckReveal
    // ------------------------------------------------------------------

    function test_ShareRange_Reverts() public {
        uint256 id = _create(A, N, true);
        _accept(id);
        _commitM(id, _honest(N));
        vm.prank(client);
        vm.expectRevert(WRONG_STATUS);
        market.shareRange(id, 0, hex"aa");
        _decide(id, true);
        vm.prank(stranger);
        vm.expectRevert(bytes("not client"));
        market.shareRange(id, 0, hex"aa");
        vm.prank(client);
        vm.expectRevert(bytes("bad slot"));
        market.shareRange(id, 2, hex"aa");
        _share(id, 0);
        vm.prank(client);
        vm.expectRevert(bytes("already shared"));
        market.shareRange(id, 0, hex"aa");
        _pastDeadline(id);
        vm.prank(client);
        vm.expectRevert(LATE);
        market.shareRange(id, 1, hex"aa");
    }

    function test_CommitCheck_Reverts() public {
        uint256 id = _create(A, N, true);
        _accept(id);
        _commitM(id, _honest(N));
        address[] memory vs = _decide(id, true);
        vm.prank(vs[0]);
        vm.expectRevert(bytes("not shared"));
        market.commitCheck(id, keccak256("c"));
        _shareAll(id);
        vm.prank(stranger);
        vm.expectRevert(bytes("not verifier"));
        market.commitCheck(id, keccak256("c"));
        vm.prank(A);
        vm.expectRevert(bytes("not verifier"));
        market.commitCheck(id, keccak256("c"));
        vm.prank(vs[0]);
        vm.expectRevert(bytes("zero commit"));
        market.commitCheck(id, bytes32(0));
        _commitV(id, 0, _honest(N));
        vm.prank(vs[0]);
        vm.expectRevert(bytes("not shared")); // already committed
        market.commitCheck(id, keccak256("c"));
        _pastDeadline(id);
        vm.prank(vs[1]);
        vm.expectRevert(LATE);
        market.commitCheck(id, keccak256("c"));
    }

    function test_ReportBadInput_Reverts() public {
        (uint256 id, address[] memory vs) = _toChecking();
        vm.prank(stranger);
        vm.expectRevert(bytes("not verifier"));
        market.reportBadInput(id);
        _commitV(id, 0, _honest(N));
        vm.prank(vs[0]);
        vm.expectRevert(bytes("not shared")); // committed already
        market.reportBadInput(id);
        uint256 open = _create(A, N, false);
        vm.prank(A);
        vm.expectRevert(bytes("not allowed"));
        market.reportBadInput(open);
        (uint256 tid,) = _toTieBreak();
        vm.prank(stranger);
        vm.expectRevert(bytes("not allowed"));
        market.reportBadInput(tid);
        vm.prank(_job(tid).tiebreaker);
        vm.expectRevert(bytes("tie not shared"));
        market.reportBadInput(tid);
    }

    function test_RevealCheck_Reverts() public {
        bytes32[] memory l = _honest(N);
        (uint256 id, address[] memory vs) = _toChecking();
        vm.prank(vs[0]);
        vm.expectRevert(WRONG_STATUS); // still Checking
        market.revealCheck(id, _slice(l, 0, 100), V_SALT);
        _commitV(id, 0, l);
        _commitV(id, 1, l);
        vm.startPrank(vs[0]);
        vm.expectRevert(bytes("bad length"));
        market.revealCheck(id, _slice(l, 0, 99), V_SALT);
        vm.expectRevert(bytes("bad length"));
        market.revealCheck(id, _slice(l, 0, 101), V_SALT);
        vm.stopPrank();
    }

    function test_RevealCheck_CommitMismatch() public {
        bytes32[] memory l = _honest(N);
        (uint256 id, address[] memory vs) = _toChecking();
        _commitV(id, 0, l);
        _commitV(id, 1, l);
        vm.startPrank(vs[0]);
        vm.expectRevert(bytes("checkCommit mismatch"));
        market.revealCheck(id, _slice(l, 100, 200), V_SALT); // someone else's range
        vm.expectRevert(bytes("checkCommit mismatch"));
        market.revealCheck(id, _slice(l, 0, 100), keccak256("other salt"));
        market.revealCheck(id, _slice(l, 0, 100), V_SALT);
        vm.expectRevert(bytes("not committed")); // twice
        market.revealCheck(id, _slice(l, 0, 100), V_SALT);
        vm.stopPrank();
        vm.prank(stranger);
        vm.expectRevert(bytes("not verifier"));
        market.revealCheck(id, _slice(l, 0, 100), V_SALT);
        _pastDeadline(id);
        vm.prank(vs[1]);
        vm.expectRevert(LATE);
        market.revealCheck(id, _slice(l, 100, 200), V_SALT);
    }

    // ------------------------------------------------------------------
    // publishResults / tie-break
    // ------------------------------------------------------------------

    function test_Publish_Reverts() public {
        bytes32[] memory l = _honest(N);
        (uint256 id,) = _toChecking();
        vm.prank(A);
        vm.expectRevert(WRONG_STATUS); // verifiers haven't finished
        market.publishResults(id, l);

        uint256 u = _toPublishingUnverified(A, l);
        vm.prank(B);
        vm.expectRevert(bytes("not main"));
        market.publishResults(u, l);
        vm.startPrank(A);
        vm.expectRevert(bytes("bad length"));
        market.publishResults(u, _slice(l, 0, N - 1));
        bytes32[] memory other = _copy(l);
        other[7] = _wrong(7, 1);
        vm.expectRevert(bytes("resultsCommit mismatch")); // can't change results after the reveal
        market.publishResults(u, other);
        vm.stopPrank();
        _pastDeadline(u);
        vm.prank(A);
        vm.expectRevert(LATE);
        market.publishResults(u, l);
    }

    function test_Tiebreak_Reverts() public {
        (uint256 id, address t) = _toTieBreak();
        vm.prank(stranger);
        vm.expectRevert(bytes("not client"));
        market.shareTiebreak(id, hex"bb");
        bytes32[] memory one = new bytes32[](1);
        one[0] = _leaf(0, _label(0));
        vm.prank(t);
        vm.expectRevert(bytes("tie not shared"));
        market.submitTiebreak(id, one);
        _shareTie(id);
        vm.prank(client);
        vm.expectRevert(bytes("already shared"));
        market.shareTiebreak(id, hex"bb");
        vm.prank(stranger);
        vm.expectRevert(bytes("not tiebreaker"));
        market.submitTiebreak(id, one);
        vm.prank(t);
        vm.expectRevert(bytes("bad length"));
        market.submitTiebreak(id, new bytes32[](2));
        _pastDeadline(id);
        vm.prank(t);
        vm.expectRevert(LATE);
        market.submitTiebreak(id, one);
    }

    // ------------------------------------------------------------------
    // expire and closed jobs
    // ------------------------------------------------------------------

    function test_Expire_Reverts() public {
        vm.expectRevert(WRONG_STATUS);
        market.expire(42);
        uint256 id = _create(A, N, false);
        vm.expectRevert(bytes("deadline not passed"));
        market.expire(id);
        vm.prank(client);
        market.cancel(id);
        vm.expectRevert(WRONG_STATUS);
        market.expire(id);
    }

    function test_ActionsOnClosedJob() public {
        bytes32[] memory l = _honest(N);
        uint256 id = _toPublishingUnverified(A, l);
        _publish(id, l);
        vm.prank(A);
        vm.expectRevert(WRONG_STATUS);
        market.publishResults(id, l);
        vm.prank(client);
        vm.expectRevert(WRONG_STATUS);
        market.revealDecision(id, VERIFY_SALT, false);
        vm.prank(client);
        vm.expectRevert(WRONG_STATUS);
        market.cancel(id);
    }

    function test_WithdrawStake_WhileLocked() public {
        (, address[] memory vs) = _toChecking();
        assertEq(_locks(A), 1);
        vm.prank(A);
        vm.expectRevert(bytes("locked"));
        registry.withdrawStake(1);
        vm.prank(vs[0]);
        vm.expectRevert(bytes("locked"));
        registry.withdrawStake(1);

        (, address t) = _toTieBreak();
        vm.prank(t);
        vm.expectRevert(bytes("locked"));
        registry.withdrawStake(1);
    }

    // ------------------------------------------------------------------
    // Access control and registry rules
    // ------------------------------------------------------------------

    function test_Registry_OnlyMarket() public {
        vm.startPrank(stranger);
        vm.expectRevert(bytes("not market"));
        registry.lock(A);
        vm.expectRevert(bytes("not market"));
        registry.unlock(A);
        vm.expectRevert(bytes("not market"));
        registry.slash(A, 10000);
        vm.expectRevert(bytes("not market"));
        registry.bump(A, uint8(ReplicatedMarket.Stat.VerifiedCompleted), 1);
        vm.stopPrank();
        // the owner isn't a market either
        vm.expectRevert(bytes("not market"));
        registry.slash(A, 10000);
    }

    function test_Registry_AddMarket() public {
        ProviderRegistry r = new ProviderRegistry(MIN_STAKE);
        vm.prank(stranger);
        vm.expectRevert(bytes("not owner"));
        r.addMarket(address(market));
        vm.expectRevert(bytes("zero market"));
        r.addMarket(address(0));
        r.addMarket(address(market));
        vm.expectRevert(bytes("market already added"));
        r.addMarket(address(market));
        r.addMarket(stranger); // several markets may share one registry
        assertTrue(r.isMarket(address(market)));
        assertTrue(r.isMarket(stranger));
        assertEq(r.marketCount(), 2);
        assertEq(r.marketAt(1), stranger);
    }

    function test_Registry_RegisterRules() public {
        vm.prank(A);
        vm.expectRevert(bytes("already registered"));
        registry.register{value: STAKE}(bytes32(0));
        vm.prank(stranger);
        vm.expectRevert(bytes("stake too low"));
        registry.register{value: MIN_STAKE - 1}(bytes32(0));
        vm.prank(stranger);
        vm.expectRevert(bytes("not registered"));
        registry.addStake{value: 1 ether}();
        vm.prank(stranger);
        vm.expectRevert(bytes("not registered"));
        registry.withdrawStake(0);
        vm.prank(stranger);
        vm.expectRevert(bytes("not registered"));
        registry.setPrice(address(market), TASK, 1);
        vm.prank(stranger);
        vm.expectRevert(bytes("not registered"));
        registry.setEncPubKey(bytes32(uint256(1)));
        vm.prank(A);
        vm.expectRevert(bytes("amount > stake"));
        registry.withdrawStake(STAKE + 1);
        vm.prank(A);
        vm.expectRevert(bytes("unknown market"));
        registry.setPrice(stranger, TASK, 1);
    }

    function test_Registry_ProviderActions() public {
        vm.startPrank(stranger);
        registry.register{value: MIN_STAKE}(bytes32(uint256(7)));
        assertTrue(registry.isActive(stranger));
        assertEq(registry.priceOf(stranger, address(market), TASK), 0); // offers nothing yet
        registry.addStake{value: 0.2 ether}();
        registry.setPrice(address(market), TASK, 9);
        registry.setEncPubKey(bytes32(uint256(8)));
        (bool reg, uint256 stake, bytes32 key, uint256 locks) = registry.getProvider(stranger);
        assertTrue(reg);
        assertEq(stake, 1 ether);
        assertEq(key, bytes32(uint256(8)));
        assertEq(locks, 0);
        assertEq(registry.priceOf(stranger, address(market), TASK), 9);
        assertEq(registry.priceOf(stranger, address(market), TASK + 1), 0); // per task type
        registry.withdrawStake(0.3 ether);
        assertFalse(registry.isActive(stranger)); // 0.7 < minStake
        vm.stopPrank();
        assertEq(registry.providerCount(), 7);
        assertEq(registry.providerAt(6), stranger);
        assertEq(registry.minStake(), MIN_STAKE);
    }

    function test_Market_OnlyOwnerAddsTaskType() public {
        vm.prank(stranger);
        vm.expectRevert(bytes("not owner"));
        market.addTaskType(bytes32(0), "x", 0);
        uint256 id = market.addTaskType(keccak256("v2"), "image-classify-v2", 5);
        assertEq(id, 2);
        assertEq(market.taskTypeCount(), 2);
        (bytes32 h, string memory name, uint64 spi) = market.taskTypeOf(1);
        assertEq(h, RUNNER_HASH);
        assertEq(name, "image-classify-v1");
        assertEq(spi, 0);
        (h, name, spi) = market.taskTypeOf(2);
        assertEq(h, keccak256("v2"));
        assertEq(spi, 5);
    }

    function test_Market_ReceiveOnlyFromRegistry() public {
        vm.prank(stranger);
        (bool ok,) = address(market).call{value: 1 ether}("");
        assertFalse(ok);
        assertEq(address(market).balance, 0);
    }

    function test_Market_NeedsAVerifier() public {
        ReplicatedMarket.Params memory p = demoParams();
        p.numVerifiers = 0;
        vm.expectRevert(bytes("need a verifier"));
        new ReplicatedMarket(address(registry), p);
    }
}
