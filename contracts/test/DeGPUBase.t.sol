// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {ProviderRegistry} from "../src/ProviderRegistry.sol";
import {ReplicatedMarket} from "../src/ReplicatedMarket.sol";

/// @notice Shared fixture: registry + market with the demo parameters, six providers A-F with
///         1 ETH stake at 0.0001 ETH per item, and a funded client. Jobs default to the demo
///         size (200 items), so price = 0.02 ETH, deposit = 0.04 ETH, and each of the two
///         verifiers covers 100 items for 0.01 ETH.
abstract contract DeGPUBase is Test {
    ProviderRegistry internal registry;
    ReplicatedMarket internal market;

    address internal client;
    address internal stranger;
    address[] internal providers; // A..F
    address internal A;
    address internal B;
    address internal C;
    address internal D;
    address internal E;
    address internal F;

    uint256 internal constant MIN_STAKE = 0.8 ether;
    uint256 internal constant STAKE = 1 ether;
    uint256 internal constant PPI = 0.0001 ether; // price per item
    uint256 internal constant TASK = 1;
    bytes32 internal constant RUNNER_HASH = keccak256("runner.py");
    bytes32 internal constant DATA_HASH = keccak256("dataHash");
    bytes32 internal constant JOB_SALT = 0x1111111111111111111111111111111111111111111111111111111111111111;
    bytes32 internal constant V_SALT = 0x3333333333333333333333333333333333333333333333333333333333333333;
    bytes32 internal constant VERIFY_SALT = 0x8888888888888888888888888888888888888888888888888888888888888888;

    uint256 internal constant N = 200;
    uint256 internal constant PRICE = N * PPI; // 0.02 ETH
    uint256 internal constant DEPOSIT = 2 * PRICE; // 0.04 ETH
    uint256 internal constant HALF_FEE = (N / 2) * PPI; // 0.01 ETH per verifier

    // Expected slash amounts on a 1 ETH stake with the demo bps.
    uint256 internal constant SLASH_WRONG = 0.3 ether; // 3000 bps
    uint256 internal constant SLASH_MISSED = 0.1 ether; // 1000 bps
    uint256 internal constant SLASH_CHECK = 0.05 ether; // 500 bps
    uint256 internal constant TIEBREAK_FEE = 0.002 ether;

    // Balance / stake snapshots for exact payout assertions.
    address[] internal tracked;
    mapping(address => uint256) internal bal0;
    mapping(address => uint256) internal stake0;

    bytes32 internal constant PAYOUT_SIG = keccak256("Payout(uint256,address,uint256)");
    bytes32 internal constant SLASHED_SIG = keccak256("ProviderSlashed(uint256,address,uint256)");

    function demoParams() internal pure returns (ReplicatedMarket.Params memory) {
        return ReplicatedMarket.Params({
            acceptWindow: 300,
            computeWindow: 600,
            decideWindow: 300,
            checkWindow: 600,
            revealWindow: 300,
            publishWindow: 300,
            tiebreakWindow: 600,
            tiebreakFee: 0.002 ether,
            wrongSlashBps: 3000,
            missedSlashBps: 1000,
            checkMissedSlashBps: 500,
            maxMismatch: 0,
            numVerifiers: 2
        });
    }

    function setUp() public virtual {
        vm.warp(1_700_000_000);
        vm.roll(100);
        _deploy(demoParams());

        client = makeAddr("client");
        stranger = makeAddr("stranger");
        vm.deal(client, 100 ether);
        vm.deal(stranger, 10 ether);
        tracked.push(client);

        string[6] memory names = ["A", "B", "C", "D", "E", "F"];
        for (uint256 i = 0; i < 6; i++) {
            address p = makeAddr(names[i]);
            vm.deal(p, 10 ether);
            providers.push(p);
            tracked.push(p);
        }
        _registerAll();
        A = providers[0];
        B = providers[1];
        C = providers[2];
        D = providers[3];
        E = providers[4];
        F = providers[5];
    }

    /// Fresh registry + market. secondsPerItem = 0 keeps every deadline equal to the base window.
    function _deploy(ReplicatedMarket.Params memory p) internal {
        registry = new ProviderRegistry(MIN_STAKE);
        market = new ReplicatedMarket(address(registry), p);
        registry.addMarket(address(market));
        market.addTaskType(RUNNER_HASH, "image-classify-v1", 0);
    }

    /// Register every provider with 1 ETH and offer task type TASK at PPI.
    function _registerAll() internal {
        for (uint256 i = 0; i < providers.length; i++) {
            vm.startPrank(providers[i]);
            registry.register{value: STAKE}(bytes32(i + 1));
            registry.setPrice(address(market), TASK, PPI);
            vm.stopPrank();
        }
    }

    // ------------------------------------------------------------------
    // Encodings (INTERFACE.md section 2)
    // ------------------------------------------------------------------

    function _label(uint256 i) internal pure returns (uint256) {
        return (i * 37 + 5) % 1000;
    }

    function _leaf(uint256 i, uint256 label) internal pure returns (bytes32) {
        return keccak256(abi.encode(JOB_SALT, i, label));
    }

    /// A deliberately wrong leaf for item i (label shifted by `delta`, 1..999).
    function _wrong(uint256 i, uint256 delta) internal pure returns (bytes32) {
        return _leaf(i, (_label(i) + delta) % 1000);
    }

    function _honest(uint256 n) internal pure returns (bytes32[] memory l) {
        l = new bytes32[](n);
        for (uint256 i = 0; i < n; i++) {
            l[i] = _leaf(i, _label(i));
        }
    }

    function _copy(bytes32[] memory l) internal pure returns (bytes32[] memory c) {
        c = new bytes32[](l.length);
        for (uint256 i = 0; i < l.length; i++) {
            c[i] = l[i];
        }
    }

    function _slice(bytes32[] memory l, uint256 s, uint256 e) internal pure returns (bytes32[] memory out) {
        out = new bytes32[](e - s);
        for (uint256 i = s; i < e; i++) {
            out[i - s] = l[i];
        }
    }

    function _resultsCommit(bytes32[] memory l) internal pure returns (bytes32) {
        return keccak256(abi.encode(l));
    }

    function _checkCommit(bytes32[] memory l) internal pure returns (bytes32) {
        return keccak256(abi.encode(V_SALT, l));
    }

    function _verifyCommit(bool verify) internal pure returns (bytes32) {
        return keccak256(abi.encode(VERIFY_SALT, verify));
    }

    // ------------------------------------------------------------------
    // Job flow helpers
    // ------------------------------------------------------------------

    function _create(address main, uint256 n, bool verify) internal returns (uint256 id) {
        vm.prank(client);
        id = market.createJob{value: 2 * n * PPI}(
            main, TASK, n, DATA_HASH, "store:manifest", _verifyCommit(verify), hex"5ea1ed"
        );
    }

    function _job(uint256 id) internal view returns (ReplicatedMarket.Job memory) {
        return market.getJob(id);
    }

    function _verifiers(uint256 id) internal view returns (address[] memory) {
        return market.getJob(id).verifiers;
    }

    function _accept(uint256 id) internal {
        vm.prank(_job(id).main);
        market.accept(id);
    }

    function _commitM(uint256 id, bytes32[] memory leaves) internal {
        vm.prank(_job(id).main);
        market.commitResults(id, _resultsCommit(leaves));
    }

    /// The client reveals its decision; returns the drawn verifiers (empty if none).
    function _decide(uint256 id, bool verify) internal returns (address[] memory) {
        vm.prank(client);
        market.revealDecision(id, VERIFY_SALT, verify);
        return _verifiers(id);
    }

    function _share(uint256 id, uint256 slot) internal {
        vm.prank(client);
        market.shareRange(id, slot, hex"aa01");
    }

    function _shareAll(uint256 id) internal {
        uint256 nv = _verifiers(id).length;
        for (uint256 slot = 0; slot < nv; slot++) {
            _share(id, slot);
        }
    }

    /// Verifier `slot` commits to its range of `vLeaves` (a full-length array).
    function _commitV(uint256 id, uint256 slot, bytes32[] memory vLeaves) internal {
        (uint256 s, uint256 e) = market.rangeOf(id, slot);
        vm.prank(_verifiers(id)[slot]);
        market.commitCheck(id, _checkCommit(_slice(vLeaves, s, e)));
    }

    function _revealV(uint256 id, uint256 slot, bytes32[] memory vLeaves) internal {
        (uint256 s, uint256 e) = market.rangeOf(id, slot);
        vm.prank(_verifiers(id)[slot]);
        market.revealCheck(id, _slice(vLeaves, s, e), V_SALT);
    }

    function _publish(uint256 id, bytes32[] memory leaves) internal {
        vm.prank(_job(id).main);
        market.publishResults(id, leaves);
    }

    function _shareTie(uint256 id) internal {
        vm.prank(client);
        market.shareTiebreak(id, hex"bb02");
    }

    function _submitTie(uint256 id, bytes32[] memory leaves) internal {
        vm.prank(_job(id).tiebreaker);
        market.submitTiebreak(id, leaves);
    }

    /// Create, accept, commit and reveal "no": the job ends in Publishing.
    function _toPublishingUnverified(address main, bytes32[] memory mLeaves) internal returns (uint256 id) {
        id = _create(main, N, false);
        _accept(id);
        _commitM(id, mLeaves);
        _decide(id, false);
    }

    /// Create, accept, commit, reveal "yes", share, both verifiers commit and reveal: ends in Publishing.
    /// `v0` and `v1` are full-length arrays; each verifier uses its own range of its array.
    function _toPublishingVerified(address main, bytes32[] memory mLeaves, bytes32[] memory v0, bytes32[] memory v1)
        internal
        returns (uint256 id)
    {
        id = _create(main, N, true);
        _accept(id);
        _commitM(id, mLeaves);
        _decide(id, true);
        _shareAll(id);
        _commitV(id, 0, v0);
        _commitV(id, 1, v1);
        _revealV(id, 0, v0);
        _revealV(id, 1, v1);
    }

    /// Full verified flow up to and including M's publishResults.
    function _runVerified(address main, bytes32[] memory mLeaves, bytes32[] memory v0, bytes32[] memory v1)
        internal
        returns (uint256 id)
    {
        id = _toPublishingVerified(main, mLeaves, v0, v1);
        _publish(id, mLeaves);
    }

    /// Jump past the current phase deadline of job `id`.
    function _pastDeadline(uint256 id) internal {
        vm.warp(uint256(_job(id).deadline) + 1);
    }

    // ------------------------------------------------------------------
    // Accounting helpers
    // ------------------------------------------------------------------

    function _stake(address p) internal view returns (uint256 s) {
        (, s,,) = registry.getProvider(p);
    }

    function _locks(address p) internal view returns (uint256 l) {
        (,,, l) = registry.getProvider(p);
    }

    function _stat(address p, ReplicatedMarket.Stat s) internal view returns (uint256) {
        return registry.statOf(p, address(market), uint8(s));
    }

    /// Remember balances and stakes, and start recording logs.
    function _snap() internal {
        for (uint256 i = 0; i < tracked.length; i++) {
            bal0[tracked[i]] = tracked[i].balance;
            stake0[tracked[i]] = _stake(tracked[i]);
        }
        vm.recordLogs();
    }

    function _dBal(address a) internal view returns (int256) {
        return int256(a.balance) - int256(bal0[a]);
    }

    function _dStake(address a) internal view returns (int256) {
        return int256(_stake(a)) - int256(stake0[a]);
    }

    function _i(uint256 x) internal pure returns (int256) {
        return int256(x);
    }

    /// Checks shared by every closed job: status/outcome, nobody still locked, the market holds no ETH,
    /// value is conserved, and Payout events add up to the deposit plus all slashes.
    function _assertClosed(uint256 id, ReplicatedMarket.Outcome outcome) internal view {
        ReplicatedMarket.Job memory j = _job(id);
        assertEq(uint8(j.status), uint8(ReplicatedMarket.Status.Closed), "status");
        assertEq(uint8(j.outcome), uint8(outcome), "outcome");
        assertEq(address(market).balance, 0, "market balance");
        for (uint256 i = 0; i < providers.length; i++) {
            assertEq(_locks(providers[i]), 0, "still locked");
        }
        int256 total = 0;
        for (uint256 i = 0; i < tracked.length; i++) {
            total += _dBal(tracked[i]) + _dStake(tracked[i]);
        }
        assertEq(total, 0, "value not conserved");

        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 paid = 0;
        uint256 slashed = 0;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter != address(market) || logs[i].topics.length < 2) continue;
            if (uint256(logs[i].topics[1]) != id) continue;
            if (logs[i].topics[0] == PAYOUT_SIG) paid += abi.decode(logs[i].data, (uint256));
            if (logs[i].topics[0] == SLASHED_SIG) slashed += abi.decode(logs[i].data, (uint256));
        }
        assertEq(paid, 2 * j.price + slashed, "payout events");
    }

    /// Make every provider except the given ones inactive by withdrawing below minStake.
    function _deactivateAllBut(address keep1, address keep2, address keep3) internal {
        for (uint256 i = 0; i < providers.length; i++) {
            address p = providers[i];
            if (p == keep1 || p == keep2 || p == keep3) continue;
            vm.prank(p);
            registry.withdrawStake(0.5 ether);
            assertFalse(registry.isActive(p));
        }
    }
}
