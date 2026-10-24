// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {ProviderRegistry} from "../src/ProviderRegistry.sol";
import {ReplicatedMarket} from "../src/ReplicatedMarket.sol";
import {CheckedMarket} from "../src/CheckedMarket.sol";
import {IChecker} from "../src/IChecker.sol";

/// @notice The deploy script wires everything up with the demo parameters.
contract DeployTest is Test {
    function test_DeployScript() public {
        bytes32 runnerHash = keccak256("runner bytes");
        vm.setEnv("RUNNER_HASH", vm.toString(runnerHash));

        Deploy d = new Deploy();
        (ProviderRegistry registry, ReplicatedMarket market, CheckedMarket checked) = d.run();

        assertTrue(registry.isMarket(address(market)));
        assertTrue(registry.isMarket(address(checked)));
        assertEq(registry.marketCount(), 2);
        assertEq(address(market.registry()), address(registry));
        assertEq(address(checked.registry()), address(registry));
        assertEq(registry.minStake(), 0.8 ether);
        assertEq(registry.owner(), market.owner());
        assertEq(registry.owner(), checked.owner());
        assertEq(market.mode(), "replicated");
        assertEq(checked.mode(), "checked");

        (bytes32 h, string memory name, uint64 spi, ReplicatedMarket.Compare c) = market.taskTypeOf(1);
        assertEq(uint8(c), uint8(ReplicatedMarket.Compare.Exact));
        assertEq(h, runnerHash);
        assertEq(name, "image-classify-v1");
        assertEq(spi, 1);
        assertEq(market.taskTypeCount(), 1);
        assertEq(market.jobCount(), 0);

        address checker;
        (checker, name, spi) = checked.taskTypeOf(1);
        assertEq(name, "key-search-v1");
        assertEq(spi, 2);
        assertEq(checked.taskTypeCount(), 1);
        // the registered checker is a KeySearchChecker: it finds 42 in [0, 100) from its hash
        bytes memory item = abi.encode(keccak256(abi.encode(uint256(42))), uint256(0), uint256(100));
        assertTrue(IChecker(checker).check(item, bytes32(uint256(42))));
        assertFalse(IChecker(checker).check(item, bytes32(uint256(41))));

        ReplicatedMarket.Params memory p = market.params();
        assertEq(p.acceptWindow, 300);
        assertEq(p.computeWindow, 600);
        assertEq(p.decideWindow, 300);
        assertEq(p.checkWindow, 600);
        assertEq(p.revealWindow, 300);
        assertEq(p.publishWindow, 300);
        assertEq(p.disputeWindow, 300);
        assertEq(p.tiebreakWindow, 600);
        assertEq(p.tiebreakFee, 0.002 ether);
        assertEq(p.wrongSlashBps, 3000);
        assertEq(p.missedSlashBps, 1000);
        assertEq(p.checkMissedSlashBps, 500);
        assertEq(p.maxMismatch, 0);
        assertEq(p.numVerifiers, 2);

        CheckedMarket.Params memory cp = checked.params();
        assertEq(cp.acceptWindow, 300);
        assertEq(cp.workWindow, 300);
        assertEq(cp.missedSlashBps, 1000);
    }
}
