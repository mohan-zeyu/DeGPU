// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {DeGPUBase} from "./DeGPUBase.t.sol";
import {ReplicatedMarket} from "../src/ReplicatedMarket.sol";
import {CheckedMarket} from "../src/CheckedMarket.sol";
import {KeySearchChecker} from "../src/checkers/KeySearchChecker.sol";

/// @notice Several task types and several markets on one registry: offers and prices per
///         (market, task type), deadlines scaled by the task's secondsPerItem, stats per market.
contract TaskTypesTest is DeGPUBase {
    uint256 constant TASK2 = 2;
    uint64 constant SPI2 = 3; // seconds per item of task type 2
    uint256 constant PPI2 = 0.0005 ether;
    uint256 constant N2 = 10;

    function setUp() public override {
        super.setUp();
        market.addTaskType(keccak256("other runner"), "other-task-v1", SPI2, ReplicatedMarket.Compare.Exact);
        for (uint256 i = 0; i < providers.length; i++) {
            vm.prank(providers[i]);
            registry.setPrice(address(market), TASK2, PPI2);
        }
    }

    function _create2(address main, uint256 n, bool verify) internal returns (uint256 id) {
        vm.prank(client);
        id = market.createJob{value: 2 * n * PPI2}(main, TASK2, n, DATA_HASH, "uri", _verifyCommit(verify), "");
    }

    function test_PricePerTaskType() public {
        uint256 id = _create2(A, N2, false);
        assertEq(_job(id).price, N2 * PPI2);
        assertEq(_job(id).taskType, TASK2);
        // the deposit must match the task's own price, not another task's
        vm.prank(client);
        vm.expectRevert(bytes("wrong value"));
        market.createJob{value: 2 * N2 * PPI}(A, TASK2, N2, DATA_HASH, "uri", _verifyCommit(false), "");
    }

    function test_MainMustOfferTheTask() public {
        vm.prank(A);
        registry.setPrice(address(market), TASK2, 0);
        vm.prank(client);
        vm.expectRevert(bytes("main does not offer task"));
        market.createJob{value: 2 * N2 * PPI2}(A, TASK2, N2, DATA_HASH, "uri", _verifyCommit(false), "");
        // task type 1 is still offered
        _create(A, N, false);
    }

    /// Compute, check and tie-break deadlines grow with the items each phase must run.
    function test_DeadlinesScaleWithItems() public {
        ReplicatedMarket.Params memory p = demoParams();
        bytes32[] memory m = _honest(N2);
        m[0] = _wrong(0, 1);
        m[7] = _wrong(7, 1);
        bytes32[] memory h = _honest(N2);

        uint256 id = _create2(A, N2, true);
        _accept(id);
        assertEq(_job(id).deadline, block.timestamp + p.computeWindow + N2 * SPI2);
        _commitM(id, m);
        assertEq(_job(id).deadline, block.timestamp + p.decideWindow); // no compute in this phase
        _decide(id, true);
        assertEq(_job(id).deadline, block.timestamp + p.checkWindow + (N2 / 2) * SPI2);
        _shareAll(id);
        _commitV(id, 0, h);
        _commitV(id, 1, h);
        _revealV(id, 0, h);
        _revealV(id, 1, h);
        _publish(id, m);
        assertEq(uint8(_job(id).status), uint8(ReplicatedMarket.Status.TieBreak));
        assertEq(_job(id).deadline, block.timestamp + p.tiebreakWindow + 2 * SPI2); // 2 mismatched items
    }

    /// One registry serves several markets: each pins its own prices and files its own stats,
    /// and a slash from either market reduces the same stake.
    function test_TwoMarketsShareOneRegistry() public {
        CheckedMarket checked = new CheckedMarket(
            address(registry), CheckedMarket.Params({acceptWindow: 300, workWindow: 300, missedSlashBps: 1000})
        );
        registry.addMarket(address(checked));
        checked.addTaskType(new KeySearchChecker(), "key-search-v1", 0);
        vm.prank(A);
        registry.setPrice(address(checked), 1, 1 wei);
        assertEq(registry.priceOf(A, address(checked), 1), 1 wei);
        assertEq(registry.priceOf(A, address(market), 1), PPI); // unchanged in the other market

        // a missed checked job slashes A's shared stake and locks it meanwhile
        bytes[] memory items = new bytes[](1);
        items[0] = abi.encode(keccak256(abi.encode(uint256(5))), uint256(0), uint256(10));
        vm.prank(client);
        uint256 cid = checked.createJob{value: 1 wei}(A, 1, items);
        vm.prank(A);
        checked.accept(cid);
        assertEq(_locks(A), 1);
        vm.warp(block.timestamp + 301);
        checked.expire(cid);
        assertEq(_stake(A), STAKE - 0.1 ether);
        assertEq(registry.statOf(A, address(checked), uint8(CheckedMarket.Stat.Missed)), 1);
        assertEq(registry.statOf(A, address(market), uint8(ReplicatedMarket.Stat.Missed)), 0);
        assertEq(_locks(A), 0);
    }
}
