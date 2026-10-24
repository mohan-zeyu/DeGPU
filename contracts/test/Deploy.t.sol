// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {ProviderRegistry} from "../src/ProviderRegistry.sol";
import {JobMarket} from "../src/JobMarket.sol";

/// @notice The deploy script wires everything up with the demo parameters.
contract DeployTest is Test {
    function test_DeployScript() public {
        bytes32 runnerHash = keccak256("runner.py bytes");
        vm.setEnv("RUNNER_HASH", vm.toString(runnerHash));

        Deploy d = new Deploy();
        (ProviderRegistry registry, JobMarket market) = d.run();

        assertEq(registry.market(), address(market));
        assertEq(address(market.registry()), address(registry));
        assertEq(registry.minStake(), 0.8 ether);
        assertEq(registry.owner(), market.owner());

        (bytes32 h, string memory name) = market.taskTypeOf(1);
        assertEq(h, runnerHash);
        assertEq(name, "image-classify-v1");
        assertEq(market.taskTypeCount(), 1);
        assertEq(market.jobCount(), 0);

        JobMarket.Params memory p = market.params();
        assertEq(p.acceptWindow, 300);
        assertEq(p.computeWindow, 600);
        assertEq(p.decideWindow, 300);
        assertEq(p.checkWindow, 600);
        assertEq(p.revealWindow, 300);
        assertEq(p.publishWindow, 300);
        assertEq(p.tiebreakWindow, 600);
        assertEq(p.tiebreakFee, 0.002 ether);
        assertEq(p.wrongSlashBps, 3000);
        assertEq(p.missedSlashBps, 1000);
        assertEq(p.checkMissedSlashBps, 500);
        assertEq(p.maxMismatch, 0);
        assertEq(p.numVerifiers, 2);
    }
}
