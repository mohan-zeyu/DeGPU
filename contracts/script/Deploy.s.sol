// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ProviderRegistry} from "../src/ProviderRegistry.sol";
import {JobMarket} from "../src/JobMarket.sol";

/// @notice Deploys the registry and the market with the demo parameters and registers task type 1.
/// Usage (anvil account 0 as owner):
///   RUNNER_HASH=0x<keccak of runner.py> forge script script/Deploy.s.sol \
///     --rpc-url http://127.0.0.1:8545 --broadcast --private-key <anvil key 0>
contract Deploy is Script {
    uint256 public constant MIN_STAKE = 0.8 ether;

    /// The demo parameters of INTERFACE.md (v2) section 7.
    function demoParams() public pure returns (JobMarket.Params memory) {
        return JobMarket.Params({
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

    function run() external returns (ProviderRegistry registry, JobMarket market) {
        bytes32 runnerHash = vm.envBytes32("RUNNER_HASH");

        vm.startBroadcast();
        registry = new ProviderRegistry(MIN_STAKE);
        market = new JobMarket(address(registry), demoParams());
        registry.setMarket(address(market));
        market.addTaskType(runnerHash, "image-classify-v1");
        vm.stopBroadcast();

        console.log("ProviderRegistry:", address(registry));
        console.log("JobMarket:", address(market));
    }
}
