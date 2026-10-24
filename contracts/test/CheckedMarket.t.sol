// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ProviderRegistry} from "../src/ProviderRegistry.sol";
import {CheckedMarket} from "../src/CheckedMarket.sol";
import {IChecker} from "../src/IChecker.sol";
import {KeySearchChecker} from "../src/checkers/KeySearchChecker.sol";

/// @notice The checked mode: answers verified on-chain by the task's checker (here KeySearchChecker),
///         pay per solved item, wrong answers rejected, missed deadlines slashed.
contract CheckedMarketTest is Test {
    ProviderRegistry internal registry;
    CheckedMarket internal market;
    KeySearchChecker internal checker;

    address internal client;
    address internal stranger;
    address internal A;
    address internal B;

    uint256 internal constant MIN_STAKE = 0.8 ether;
    uint256 internal constant STAKE = 1 ether;
    uint256 internal constant PPI = 0.0001 ether;
    uint256 internal constant TASK = 1;
    uint64 internal constant SECONDS_PER_ITEM = 2;
    uint256 internal constant N = 10;
    uint256 internal constant RANGE = 1000; // item i hides its key in [i * RANGE, (i + 1) * RANGE)

    function setUp() public {
        vm.warp(1_700_000_000);
        registry = new ProviderRegistry(MIN_STAKE);
        market = new CheckedMarket(
            address(registry), CheckedMarket.Params({acceptWindow: 300, workWindow: 300, missedSlashBps: 1000})
        );
        registry.addMarket(address(market));
        checker = new KeySearchChecker();
        market.addTaskType(checker, "key-search-v1", SECONDS_PER_ITEM);

        client = makeAddr("client");
        stranger = makeAddr("stranger");
        A = makeAddr("A");
        B = makeAddr("B");
        vm.deal(client, 10 ether);
        vm.deal(stranger, 10 ether);
        address[2] memory ps = [A, B];
        for (uint256 i = 0; i < 2; i++) {
            vm.deal(ps[i], 10 ether);
            vm.startPrank(ps[i]);
            registry.register{value: STAKE}(bytes32(i + 1));
            registry.setPrice(address(market), TASK, PPI);
            vm.stopPrank();
        }
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    /// The key hidden in item i.
    function _key(uint256 i) internal pure returns (uint256) {
        return i * RANGE + 7;
    }

    /// key-search-v1 item i: the hash of _key(i) and the range [i * RANGE, (i + 1) * RANGE).
    function _item(uint256 i) internal pure returns (bytes memory) {
        return abi.encode(keccak256(abi.encode(_key(i))), i * RANGE, (i + 1) * RANGE);
    }

    /// An item with no solution: its key lies just below its range.
    function _impossible(uint256 i) internal pure returns (bytes memory) {
        return abi.encode(keccak256(abi.encode(_key(i))), _key(i) + 1, (i + 1) * RANGE);
    }

    function _items(uint256 n) internal pure returns (bytes[] memory items) {
        items = new bytes[](n);
        for (uint256 i = 0; i < n; i++) {
            items[i] = _item(i);
        }
    }

    /// The right key for every found item (items built with _item, in order).
    function _answers(bool[] memory found) internal pure returns (bytes32[] memory a) {
        a = new bytes32[](found.length);
        for (uint256 i = 0; i < found.length; i++) {
            if (found[i]) a[i] = bytes32(_key(i));
        }
    }

    function _allFound(uint256 n) internal pure returns (bool[] memory f) {
        f = new bool[](n);
        for (uint256 i = 0; i < n; i++) {
            f[i] = true;
        }
    }

    function _create(bytes[] memory items) internal returns (uint256 id) {
        vm.prank(client);
        id = market.createJob{value: items.length * PPI}(A, TASK, items);
    }

    function _accept(uint256 id) internal {
        vm.prank(A);
        market.accept(id);
    }

    function _stake(address p) internal view returns (uint256 s) {
        (, s,,) = registry.getProvider(p);
    }

    function _locks(address p) internal view returns (uint256 l) {
        (,,, l) = registry.getProvider(p);
    }

    function _stat(address p, CheckedMarket.Stat s) internal view returns (uint256) {
        return registry.statOf(p, address(market), uint8(s));
    }

    // ------------------------------------------------------------------
    // Outcomes
    // ------------------------------------------------------------------

    function test_Delivered_AllSolved() public {
        bytes[] memory items = _items(N);
        uint256 c0 = client.balance;
        uint256 a0 = A.balance;
        uint256 id = _create(items);
        assertEq(address(market).balance, N * PPI);
        _accept(id);
        assertEq(_locks(A), 1);
        bool[] memory found = _allFound(N);
        vm.prank(A);
        market.submitResults(id, items, _answers(found), found);

        CheckedMarket.Job memory j = market.getJob(id);
        assertEq(uint8(j.status), uint8(CheckedMarket.Status.Closed));
        assertEq(uint8(j.outcome), uint8(CheckedMarket.Outcome.Delivered));
        assertEq(j.solved, N);
        assertEq(A.balance - a0, N * PPI);
        assertEq(c0 - client.balance, N * PPI);
        assertEq(address(market).balance, 0);
        assertEq(_locks(A), 0);
        assertEq(_stat(A, CheckedMarket.Stat.Completed), 1);
        assertEq(_stat(A, CheckedMarket.Stat.ItemsSolved), N);
        assertEq(_stat(A, CheckedMarket.Stat.ItemsNotFound), 0);
    }

    /// Unsolved items are refunded; "not found" is never slashed.
    function test_Delivered_PartlySolved() public {
        bytes[] memory items = _items(N);
        items[3] = _impossible(3);
        items[7] = _impossible(7);
        uint256 c0 = client.balance;
        uint256 a0 = A.balance;
        uint256 id = _create(items);
        _accept(id);
        bool[] memory found = _allFound(N);
        found[3] = false;
        found[7] = false;
        vm.prank(A);
        market.submitResults(id, items, _answers(found), found);

        assertEq(market.getJob(id).solved, N - 2);
        assertEq(A.balance - a0, (N - 2) * PPI);
        assertEq(c0 - client.balance, (N - 2) * PPI);
        assertEq(_stake(A), STAKE);
        assertEq(address(market).balance, 0);
        assertEq(_stat(A, CheckedMarket.Stat.ItemsNotFound), 2);
    }

    /// A single wrong answer rejects the whole submission; nothing is paid or recorded.
    function test_InvalidAnswerReverts() public {
        bytes[] memory items = _items(N);
        uint256 id = _create(items);
        _accept(id);
        bool[] memory found = _allFound(N);
        bytes32[] memory answers = _answers(found);
        answers[4] = bytes32(uint256(answers[4]) + 1); // a key in the range, but not the hidden one
        require(!checker.check(items[4], answers[4]), "test needs a wrong answer");
        vm.prank(A);
        vm.expectRevert(bytes("invalid answer"));
        market.submitResults(id, items, answers, found);
        assertEq(uint8(market.getJob(id).status), uint8(CheckedMarket.Status.Working));
        // claiming an impossible item as found is rejected too, even with the key that hashes right
        bytes[] memory items2 = new bytes[](1);
        items2[0] = _impossible(0);
        uint256 id2 = _create(items2);
        _accept(id2);
        bytes32[] memory a2 = new bytes32[](1);
        a2[0] = bytes32(_key(0));
        vm.prank(A);
        vm.expectRevert(bytes("invalid answer"));
        market.submitResults(id2, items2, a2, _allFound(1));
    }

    function test_MainMissed_SlashedClientRefunded() public {
        bytes[] memory items = _items(N);
        uint256 c0 = client.balance;
        uint256 id = _create(items);
        _accept(id);
        // the work deadline includes the task's time per item
        assertEq(market.getJob(id).deadline, block.timestamp + 300 + N * SECONDS_PER_ITEM);
        vm.warp(block.timestamp + 300 + N * SECONDS_PER_ITEM + 1);
        vm.prank(stranger);
        market.expire(id);

        assertEq(uint8(market.getJob(id).outcome), uint8(CheckedMarket.Outcome.MainMissed));
        assertEq(_stake(A), STAKE - 0.1 ether);
        assertEq(client.balance, c0 + 0.1 ether); // full refund plus A's slash
        assertEq(address(market).balance, 0);
        assertEq(_locks(A), 0);
        assertEq(_stat(A, CheckedMarket.Stat.Missed), 1);
    }

    function test_Cancelled_ByClientOrAfterAcceptDeadline() public {
        bytes[] memory items = _items(N);
        uint256 c0 = client.balance;
        uint256 id = _create(items);
        vm.prank(stranger);
        vm.expectRevert(bytes("not client"));
        market.cancel(id);
        vm.prank(client);
        market.cancel(id);
        assertEq(uint8(market.getJob(id).outcome), uint8(CheckedMarket.Outcome.Cancelled));
        assertEq(client.balance, c0);

        uint256 id2 = _create(items);
        vm.expectRevert(bytes("deadline not passed"));
        market.expire(id2);
        vm.warp(block.timestamp + 301);
        market.expire(id2);
        assertEq(uint8(market.getJob(id2).outcome), uint8(CheckedMarket.Outcome.Cancelled));
        assertEq(client.balance, c0);
        assertEq(_stake(A), STAKE); // never accepted: no slash
    }

    /// The price is pinned at createJob.
    function test_PricePinnedAtCreate() public {
        bytes[] memory items = _items(N);
        uint256 a0 = A.balance;
        uint256 id = _create(items);
        vm.prank(A);
        registry.setPrice(address(market), TASK, 1 ether);
        _accept(id);
        bool[] memory found = _allFound(N);
        vm.prank(A);
        market.submitResults(id, items, _answers(found), found);
        assertEq(A.balance - a0, N * PPI);
    }

    // ------------------------------------------------------------------
    // Reverts
    // ------------------------------------------------------------------

    function test_CreateJob_Reverts() public {
        bytes[] memory items = _items(N);
        vm.startPrank(client);
        vm.expectRevert(bytes("unknown task type"));
        market.createJob{value: N * PPI}(A, 2, items);
        vm.expectRevert(bytes("main not active"));
        market.createJob{value: N * PPI}(stranger, TASK, items);
        vm.expectRevert(bytes("bad numItems"));
        market.createJob{value: 0}(A, TASK, new bytes[](0));
        vm.expectRevert(bytes("wrong value"));
        market.createJob{value: N * PPI - 1}(A, TASK, items);
        vm.stopPrank();
        vm.prank(A);
        vm.expectRevert(bytes("main is client"));
        market.createJob{value: N * PPI}(A, TASK, items);
        vm.prank(B);
        registry.setPrice(address(market), TASK, 0);
        vm.prank(client);
        vm.expectRevert(bytes("main does not offer task"));
        market.createJob{value: N * PPI}(B, TASK, items);
    }

    function test_Submit_Reverts() public {
        bytes[] memory items = _items(N);
        uint256 id = _create(items);
        bool[] memory found = _allFound(N);
        bytes32[] memory answers = _answers(found);
        vm.prank(A);
        vm.expectRevert(bytes("wrong status"));
        market.submitResults(id, items, answers, found); // not accepted yet
        vm.prank(B);
        vm.expectRevert(bytes("not main"));
        market.accept(id);
        _accept(id);

        vm.prank(B);
        vm.expectRevert(bytes("not main"));
        market.submitResults(id, items, answers, found);
        vm.startPrank(A);
        vm.expectRevert(bytes("bad length"));
        market.submitResults(id, items, answers, new bool[](N - 1));
        bytes[] memory other = _items(N);
        other[0] = _item(99);
        vm.expectRevert(bytes("items mismatch"));
        market.submitResults(id, other, answers, found);
        vm.warp(block.timestamp + 300 + N * SECONDS_PER_ITEM + 1);
        vm.expectRevert(bytes("deadline passed"));
        market.submitResults(id, items, answers, found);
        vm.stopPrank();
    }

    function test_AddTaskType_Rules() public {
        vm.prank(stranger);
        vm.expectRevert(bytes("not owner"));
        market.addTaskType(checker, "x", 0);
        vm.expectRevert(bytes("zero checker"));
        market.addTaskType(IChecker(address(0)), "x", 0);
        uint256 id = market.addTaskType(checker, "key-search-v2", 7);
        assertEq(id, 2);
        (address c, string memory name, uint64 spi) = market.taskTypeOf(2);
        assertEq(c, address(checker));
        assertEq(name, "key-search-v2");
        assertEq(spi, 7);
    }

    function test_ReceiveOnlyFromRegistry() public {
        vm.prank(stranger);
        (bool ok,) = address(market).call{value: 1 ether}("");
        assertFalse(ok);
    }
}
