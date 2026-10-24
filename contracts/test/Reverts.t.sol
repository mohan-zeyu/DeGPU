// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {DeGPUBase} from "./DeGPUBase.t.sol";
import {JobMarket} from "../src/JobMarket.sol";
import {ProviderRegistry} from "../src/ProviderRegistry.sol";

/// @notice Wrong caller, wrong phase, wrong value, bad commitments/samples, wrong lengths,
///         locked stake and late actions all revert.
contract RevertsTest is DeGPUBase {
    bytes constant WRONG_STATUS = bytes("wrong status");
    bytes constant LATE = bytes("deadline passed");

    // ------------------------------------------------------------------
    // createJob
    // ------------------------------------------------------------------

    function test_Create_WrongValue() public {
        uint256[] memory idx = _indices(N, K);
        bytes32 sh = _sampleHash(idx);
        uint256 value = _value(N, K);
        vm.startPrank(client);
        vm.expectRevert(bytes("wrong value"));
        market.createJob{value: value - 1}(A, TASK, N, DATA_HASH, "uri", K, sh, "");
        vm.expectRevert(bytes("wrong value"));
        market.createJob{value: value + 1}(A, TASK, N, DATA_HASH, "uri", K, sh, "");
        vm.expectRevert(bytes("wrong value"));
        market.createJob{value: PRICE}(A, TASK, N, DATA_HASH, "uri", K, sh, ""); // fee missing
        vm.stopPrank();
    }

    function test_Create_BadArguments() public {
        vm.startPrank(client);
        vm.expectRevert(bytes("unknown task type"));
        market.createJob{value: PRICE}(A, 0, N, DATA_HASH, "uri", 0, 0, "");
        vm.expectRevert(bytes("unknown task type"));
        market.createJob{value: PRICE}(A, 2, N, DATA_HASH, "uri", 0, 0, "");
        vm.expectRevert(bytes("main not active"));
        market.createJob{value: PRICE}(stranger, TASK, N, DATA_HASH, "uri", 0, 0, "");
        vm.expectRevert(bytes("bad numItems"));
        market.createJob{value: 0}(A, TASK, 0, DATA_HASH, "uri", 0, 0, "");
        uint256 tooMany = market.MAX_ITEMS() + 1;
        vm.expectRevert(bytes("bad numItems"));
        market.createJob{value: tooMany * PPI}(A, TASK, tooMany, DATA_HASH, "uri", 0, 0, "");
        vm.expectRevert(bytes("sampleSize > numItems"));
        market.createJob{value: 21 * PPI}(A, TASK, 10, DATA_HASH, "uri", 11, 0, "");
        vm.stopPrank();
    }

    function test_Create_MainIsClient() public {
        vm.prank(A);
        vm.expectRevert(bytes("main is client"));
        market.createJob{value: PRICE}(A, TASK, N, DATA_HASH, "uri", 0, 0, "");
    }

    function test_Create_MaxItemsAllowed() public {
        uint256 maxItems = market.MAX_ITEMS();
        vm.prank(client);
        uint256 id = market.createJob{value: maxItems * PPI}(A, TASK, maxItems, DATA_HASH, "uri", 0, 0, "");
        assertEq(_job(id).numItems, maxItems);
        assertEq(_job(id).price, maxItems * PPI);
    }

    // ------------------------------------------------------------------
    // Open: accept / cancel
    // ------------------------------------------------------------------

    function test_Accept_WrongCaller() public {
        uint256 id = _create(A, N, K);
        vm.prank(B);
        vm.expectRevert(bytes("not main"));
        market.accept(id);
        vm.prank(client);
        vm.expectRevert(bytes("not main"));
        market.accept(id);
    }

    function test_Accept_AfterDeadline() public {
        uint256 id = _create(A, N, K);
        _pastDeadline(id);
        vm.prank(A);
        vm.expectRevert(LATE);
        market.accept(id);
    }

    function test_Accept_AtDeadlineIsAllowed() public {
        uint256 id = _create(A, N, K);
        vm.warp(_job(id).deadline);
        _accept(id);
        assertEq(uint8(_job(id).status), uint8(JobMarket.Status.Committing));
    }

    function test_Accept_Twice() public {
        uint256 id = _create(A, N, K);
        _accept(id);
        vm.prank(A);
        vm.expectRevert(WRONG_STATUS);
        market.accept(id);
    }

    function test_Accept_MainNoLongerActive() public {
        uint256 id = _create(A, N, K);
        vm.prank(A);
        registry.withdrawStake(0.5 ether);
        vm.prank(A);
        vm.expectRevert(bytes("main not active"));
        market.accept(id);
    }

    function test_Accept_NonexistentJob() public {
        vm.prank(A);
        vm.expectRevert(WRONG_STATUS);
        market.accept(99);
    }

    function test_Cancel_WrongCallerBeforeDeadline() public {
        uint256 id = _create(A, N, K);
        vm.prank(stranger);
        vm.expectRevert(bytes("not client"));
        market.cancel(id);
        vm.prank(A);
        vm.expectRevert(bytes("not client"));
        market.cancel(id);
    }

    function test_Cancel_AfterAccept() public {
        uint256 id = _create(A, N, K);
        _accept(id);
        vm.prank(client);
        vm.expectRevert(WRONG_STATUS);
        market.cancel(id);
    }

    // ------------------------------------------------------------------
    // Committing
    // ------------------------------------------------------------------

    function test_ShareSample_Reverts() public {
        uint256 id = _create(A, N, K);
        vm.prank(client);
        vm.expectRevert(WRONG_STATUS); // still Open
        market.shareSample(id, "");
        _accept(id);
        vm.prank(stranger);
        vm.expectRevert(bytes("not client"));
        market.shareSample(id, "");
        _share(id);
        vm.prank(client);
        vm.expectRevert(bytes("already shared"));
        market.shareSample(id, "");
    }

    function test_ShareSample_AfterDeadline() public {
        uint256 id = _create(A, N, K);
        _accept(id);
        _pastDeadline(id);
        vm.prank(client);
        vm.expectRevert(LATE);
        market.shareSample(id, "");
    }

    function test_ShareSample_UnverifiedJob() public {
        uint256 id = _create(A, N, 0);
        _accept(id); // goes straight to Publishing
        vm.prank(client);
        vm.expectRevert(WRONG_STATUS);
        market.shareSample(id, "");
    }

    function test_CommitResults_Reverts() public {
        bytes32 c = _resultsCommit(_honest(N));
        uint256 id = _create(A, N, K);
        vm.prank(A);
        vm.expectRevert(WRONG_STATUS); // Open
        market.commitResults(id, c);
        address v = _accept(id);
        vm.prank(v);
        vm.expectRevert(bytes("not main"));
        market.commitResults(id, c);
        vm.prank(A);
        vm.expectRevert(bytes("zero commit"));
        market.commitResults(id, bytes32(0));
        vm.prank(A);
        market.commitResults(id, c);
        vm.prank(A);
        vm.expectRevert(bytes("already committed"));
        market.commitResults(id, c);
    }

    function test_CommitResults_AfterDeadline() public {
        uint256 id = _create(A, N, K);
        _accept(id);
        _pastDeadline(id);
        vm.prank(A);
        vm.expectRevert(LATE);
        market.commitResults(id, keccak256("x"));
    }

    function test_CommitSample_Reverts() public {
        bytes32 c = _sampleCommit(_pick(_honest(N), _indices(N, K)));
        uint256 id = _create(A, N, K);
        address v = _accept(id);
        vm.prank(v);
        vm.expectRevert(bytes("sample not shared"));
        market.commitSample(id, c);
        _share(id);
        vm.prank(A);
        vm.expectRevert(bytes("not verifier"));
        market.commitSample(id, c);
        vm.prank(v);
        vm.expectRevert(bytes("zero commit"));
        market.commitSample(id, bytes32(0));
        vm.prank(v);
        market.commitSample(id, c);
        vm.prank(v);
        vm.expectRevert(bytes("already committed"));
        market.commitSample(id, c);
    }

    function test_CommitSample_AfterDeadline() public {
        uint256 id = _create(A, N, K);
        address v = _accept(id);
        _share(id);
        _pastDeadline(id);
        vm.prank(v);
        vm.expectRevert(LATE);
        market.commitSample(id, keccak256("x"));
    }

    function test_ReportBadInput_Reverts() public {
        uint256 id = _create(A, N, K);
        address v = _accept(id);
        vm.prank(v);
        vm.expectRevert(bytes("sample not shared"));
        market.reportBadInput(id);
        _share(id);
        vm.prank(A);
        vm.expectRevert(bytes("not allowed"));
        market.reportBadInput(id);
        vm.prank(client);
        vm.expectRevert(bytes("not allowed"));
        market.reportBadInput(id);
        _commitV(id, _pick(_honest(N), _indices(N, K)));
        vm.prank(v);
        vm.expectRevert(bytes("already committed"));
        market.reportBadInput(id);
    }

    function test_ReportBadInput_AfterDeadline() public {
        uint256 id = _create(A, N, K);
        address v = _accept(id);
        _share(id);
        _pastDeadline(id);
        vm.prank(v);
        vm.expectRevert(LATE);
        market.reportBadInput(id);
    }

    // ------------------------------------------------------------------
    // SampleReveal
    // ------------------------------------------------------------------

    /// Creates a job whose sampleHash commits to `idx` (which may be malformed on purpose),
    /// and runs it to SampleReveal with V's commitment over `vLeaves`.
    function _toReveal(uint256 n, uint256[] memory idx, bytes32[] memory vLeaves)
        internal
        returns (uint256 id, address v)
    {
        uint256 k = idx.length;
        vm.prank(client);
        id = market.createJob{value: _value(n, k)}(A, TASK, n, DATA_HASH, "uri", k, _sampleHash(idx), "");
        v = _accept(id);
        _share(id);
        _commitM(id, _honest(n));
        _commitV(id, vLeaves);
        assertEq(uint8(_job(id).status), uint8(JobMarket.Status.SampleReveal));
    }

    function _idx3(uint256 a, uint256 b, uint256 c) internal pure returns (uint256[] memory idx) {
        idx = new uint256[](3);
        idx[0] = a;
        idx[1] = b;
        idx[2] = c;
    }

    function test_Reveal_WrongCallerAndPhase() public {
        uint256[] memory idx = _indices(N, K);
        bytes32[] memory vLeaves = _pick(_honest(N), idx);
        uint256 id = _create(A, N, K);
        address v = _accept(id);
        _share(id);
        vm.prank(v);
        vm.expectRevert(WRONG_STATUS); // still Committing
        market.revealSample(id, idx, SAMPLE_SALT, vLeaves, V_SALT);
        _commitM(id, _honest(N));
        _commitV(id, vLeaves);
        vm.prank(A);
        vm.expectRevert(bytes("not verifier"));
        market.revealSample(id, idx, SAMPLE_SALT, vLeaves, V_SALT);
    }

    function test_Reveal_SampleHashMismatch() public {
        uint256[] memory idx = _indices(N, K);
        bytes32[] memory vLeaves = _pick(_honest(N), idx);
        (uint256 id, address v) = _toReveal(N, idx, vLeaves);
        vm.startPrank(v);
        // wrong salt
        vm.expectRevert(bytes("sampleHash mismatch"));
        market.revealSample(id, idx, bytes32(uint256(1)), vLeaves, V_SALT);
        // different indices (still strictly increasing)
        uint256[] memory other = _indices(N, K);
        other[K - 1] = other[K - 1] + 1;
        vm.expectRevert(bytes("sampleHash mismatch"));
        market.revealSample(id, other, SAMPLE_SALT, vLeaves, V_SALT);
        vm.stopPrank();
    }

    function test_Reveal_SampleCommitMismatch() public {
        uint256[] memory idx = _indices(N, K);
        bytes32[] memory vLeaves = _pick(_honest(N), idx);
        (uint256 id, address v) = _toReveal(N, idx, vLeaves);
        vm.startPrank(v);
        vm.expectRevert(bytes("sampleCommit mismatch"));
        market.revealSample(id, idx, SAMPLE_SALT, vLeaves, bytes32(uint256(1))); // wrong vSalt
        bytes32[] memory changed = _pick(_honest(N), idx);
        changed[0] = _wrong(0, 1);
        vm.expectRevert(bytes("sampleCommit mismatch"));
        market.revealSample(id, idx, SAMPLE_SALT, changed, V_SALT); // different leaves
        vm.stopPrank();
    }

    function test_Reveal_WrongLengths() public {
        uint256[] memory idx = _indices(N, K);
        bytes32[] memory vLeaves = _pick(_honest(N), idx);
        (uint256 id, address v) = _toReveal(N, idx, vLeaves);
        vm.startPrank(v);
        // too few leaves
        bytes32[] memory shortLeaves = new bytes32[](K - 1);
        vm.expectRevert(bytes("bad length"));
        market.revealSample(id, idx, SAMPLE_SALT, shortLeaves, V_SALT);
        // too many indices
        uint256[] memory longIdx = new uint256[](K + 1);
        vm.expectRevert(bytes("bad length"));
        market.revealSample(id, longIdx, SAMPLE_SALT, vLeaves, V_SALT);
        vm.stopPrank();
    }

    function test_Reveal_IndicesNotIncreasing_Duplicate() public {
        uint256[] memory idx = _idx3(1, 4, 4); // the client committed to a duplicate index
        bytes32[] memory vLeaves = _pick(_honest(10), idx);
        (uint256 id, address v) = _toReveal(10, idx, vLeaves);
        vm.prank(v);
        vm.expectRevert(bytes("indices not increasing"));
        market.revealSample(id, idx, SAMPLE_SALT, vLeaves, V_SALT);
    }

    function test_Reveal_IndicesNotIncreasing_Decreasing() public {
        uint256[] memory idx = _idx3(5, 3, 7);
        bytes32[] memory vLeaves = _pick(_honest(10), idx);
        (uint256 id, address v) = _toReveal(10, idx, vLeaves);
        vm.prank(v);
        vm.expectRevert(bytes("indices not increasing"));
        market.revealSample(id, idx, SAMPLE_SALT, vLeaves, V_SALT);
    }

    function test_Reveal_IndexOutOfRange() public {
        uint256[] memory idx = _idx3(1, 2, 10); // numItems = 10
        bytes32[] memory vLeaves = new bytes32[](3);
        (uint256 id, address v) = _toReveal(10, idx, vLeaves);
        vm.prank(v);
        vm.expectRevert(bytes("index out of range"));
        market.revealSample(id, idx, SAMPLE_SALT, vLeaves, V_SALT);
    }

    function test_Reveal_AfterDeadline() public {
        uint256[] memory idx = _indices(N, K);
        bytes32[] memory vLeaves = _pick(_honest(N), idx);
        (uint256 id, address v) = _toReveal(N, idx, vLeaves);
        _pastDeadline(id);
        vm.prank(v);
        vm.expectRevert(LATE);
        market.revealSample(id, idx, SAMPLE_SALT, vLeaves, V_SALT);
    }

    // ------------------------------------------------------------------
    // Publishing
    // ------------------------------------------------------------------

    function test_Publish_Reverts() public {
        bytes32[] memory leaves = _honest(N);
        bytes32[] memory vLeaves = _pick(leaves, _indices(N, K));
        uint256 id = _create(A, N, K);
        _accept(id);
        vm.prank(A);
        vm.expectRevert(WRONG_STATUS); // Committing
        market.publishResults(id, leaves);
        _share(id);
        _commitM(id, leaves);
        _commitV(id, vLeaves);
        _reveal(id, vLeaves);

        vm.prank(B);
        vm.expectRevert(bytes("not main"));
        market.publishResults(id, leaves);

        bytes32[] memory shortLeaves = new bytes32[](N - 1);
        vm.prank(A);
        vm.expectRevert(bytes("bad length"));
        market.publishResults(id, shortLeaves);

        bytes32[] memory changed = _honest(N);
        changed[199] = _wrong(199, 1);
        vm.prank(A);
        vm.expectRevert(bytes("resultsCommit mismatch"));
        market.publishResults(id, changed);
    }

    function test_Publish_AfterDeadline() public {
        uint256 id = _create(A, N, 0);
        _accept(id);
        _pastDeadline(id);
        vm.prank(A);
        vm.expectRevert(LATE);
        market.publishResults(id, _honest(N));
    }

    // ------------------------------------------------------------------
    // TieBreak
    // ------------------------------------------------------------------

    function _toTieBreak() internal returns (uint256 id, address t) {
        bytes32[] memory mLeaves = _honest(N);
        mLeaves[10] = _wrong(10, 1);
        id = _runVerified(A, mLeaves, _pick(_honest(N), _indices(N, K)));
        t = _job(id).tiebreaker;
        assertTrue(t != address(0));
    }

    function test_ShareTiebreak_Reverts() public {
        uint256 id = _create(A, N, 0);
        _accept(id);
        vm.prank(client);
        vm.expectRevert(WRONG_STATUS); // Publishing
        market.shareTiebreak(id, "");

        (uint256 tid,) = _toTieBreak();
        vm.prank(stranger);
        vm.expectRevert(bytes("not client"));
        market.shareTiebreak(tid, "");
        _shareTie(tid);
        vm.prank(client);
        vm.expectRevert(bytes("already shared"));
        market.shareTiebreak(tid, "");
    }

    function test_ShareTiebreak_AfterDeadline() public {
        (uint256 id,) = _toTieBreak();
        _pastDeadline(id);
        vm.prank(client);
        vm.expectRevert(LATE);
        market.shareTiebreak(id, "");
    }

    function test_SubmitTiebreak_Reverts() public {
        (uint256 id, address t) = _toTieBreak();
        bytes32[] memory one = new bytes32[](1);
        one[0] = _leaf(10, _label(10));
        vm.prank(t);
        vm.expectRevert(bytes("tie not shared"));
        market.submitTiebreak(id, one);
        vm.prank(t);
        vm.expectRevert(bytes("tie not shared"));
        market.reportBadInput(id);
        _shareTie(id);
        vm.prank(A);
        vm.expectRevert(bytes("not tiebreaker"));
        market.submitTiebreak(id, one);
        vm.prank(t);
        vm.expectRevert(bytes("bad length"));
        market.submitTiebreak(id, new bytes32[](2));
        vm.prank(t);
        vm.expectRevert(bytes("bad length"));
        market.submitTiebreak(id, new bytes32[](0));
    }

    function test_SubmitTiebreak_AfterDeadline() public {
        (uint256 id, address t) = _toTieBreak();
        _shareTie(id);
        _pastDeadline(id);
        bytes32[] memory one = new bytes32[](1);
        vm.prank(t);
        vm.expectRevert(LATE);
        market.submitTiebreak(id, one);
        vm.prank(t);
        vm.expectRevert(LATE);
        market.reportBadInput(id);
    }

    // ------------------------------------------------------------------
    // expire
    // ------------------------------------------------------------------

    function test_Expire_Reverts() public {
        vm.expectRevert(WRONG_STATUS);
        market.expire(42); // no such job

        uint256 id = _create(A, N, K);
        vm.expectRevert(bytes("deadline not passed"));
        market.expire(id);
        vm.warp(_job(id).deadline); // exactly at the deadline is still in time
        vm.expectRevert(bytes("deadline not passed"));
        market.expire(id);

        vm.prank(client);
        market.cancel(id);
        assertEq(address(market).balance, 0);
        _pastDeadline(id);
        vm.expectRevert(WRONG_STATUS); // Closed
        market.expire(id);
    }

    function test_ActionsOnClosedJob() public {
        uint256 id = _create(A, N, 0);
        _accept(id);
        _publish(id, _honest(N));
        assertEq(address(market).balance, 0);
        vm.prank(A);
        vm.expectRevert(WRONG_STATUS);
        market.publishResults(id, _honest(N));
        vm.prank(client);
        vm.expectRevert(WRONG_STATUS);
        market.cancel(id);
    }

    // ------------------------------------------------------------------
    // Stake locks
    // ------------------------------------------------------------------

    function test_WithdrawStake_WhileLocked() public {
        uint256 id = _create(A, N, K);
        address v = _accept(id);
        assertEq(_locks(A), 1);
        assertEq(_locks(v), 1);
        vm.prank(A);
        vm.expectRevert(bytes("locked"));
        registry.withdrawStake(1);
        vm.prank(v);
        vm.expectRevert(bytes("locked"));
        registry.withdrawStake(1);

        // tie-breaker is locked too
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
        registry.bump(A, ProviderRegistry.Stat.VerifiedCompleted);
        vm.stopPrank();
        // the owner isn't the market either
        vm.expectRevert(bytes("not market"));
        registry.slash(A, 10000);
    }

    function test_Registry_SetMarket() public {
        ProviderRegistry r = new ProviderRegistry(MIN_STAKE);
        vm.prank(stranger);
        vm.expectRevert(bytes("not owner"));
        r.setMarket(address(market));
        r.setMarket(address(market));
        vm.expectRevert(bytes("market already set"));
        r.setMarket(address(market));
        // the deployed registry's market is already set
        vm.expectRevert(bytes("market already set"));
        registry.setMarket(stranger);
    }

    function test_Registry_RegisterRules() public {
        vm.prank(A);
        vm.expectRevert(bytes("already registered"));
        registry.register{value: STAKE}(bytes32(0), PPI);
        vm.prank(stranger);
        vm.expectRevert(bytes("stake too low"));
        registry.register{value: MIN_STAKE - 1}(bytes32(0), PPI);
        vm.prank(stranger);
        vm.expectRevert(bytes("not registered"));
        registry.addStake{value: 1 ether}();
        vm.prank(stranger);
        vm.expectRevert(bytes("not registered"));
        registry.withdrawStake(0);
        vm.prank(stranger);
        vm.expectRevert(bytes("not registered"));
        registry.setPrice(1);
        vm.prank(stranger);
        vm.expectRevert(bytes("not registered"));
        registry.setEncPubKey(bytes32(uint256(1)));
        vm.prank(A);
        vm.expectRevert(bytes("amount > stake"));
        registry.withdrawStake(STAKE + 1);
    }

    function test_Registry_ProviderActions() public {
        vm.startPrank(stranger);
        registry.register{value: MIN_STAKE}(bytes32(uint256(7)), 5);
        assertTrue(registry.isActive(stranger));
        registry.addStake{value: 0.2 ether}();
        registry.setPrice(9);
        registry.setEncPubKey(bytes32(uint256(8)));
        (bool reg, uint256 stake, bytes32 key, uint256 price, uint256 locks) = registry.getProvider(stranger);
        assertTrue(reg);
        assertEq(stake, 1 ether);
        assertEq(key, bytes32(uint256(8)));
        assertEq(price, 9);
        assertEq(locks, 0);
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
        market.addTaskType(bytes32(0), "x");
        uint256 id = market.addTaskType(keccak256("v2"), "image-classify-v2");
        assertEq(id, 2);
        (bytes32 h, string memory name) = market.taskTypeOf(1);
        assertEq(h, RUNNER_HASH);
        assertEq(name, "image-classify-v1");
    }

    function test_Market_ReceiveOnlyFromRegistry() public {
        vm.prank(stranger);
        (bool ok,) = address(market).call{value: 1 ether}("");
        assertFalse(ok);
        assertEq(address(market).balance, 0);
    }
}
