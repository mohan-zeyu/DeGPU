// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ProviderRegistry} from "../src/ProviderRegistry.sol";
import {ReplicatedMarket} from "../src/ReplicatedMarket.sol";
import {CheckedMarket} from "../src/CheckedMarket.sol";
import {NonceChecker} from "../src/checkers/NonceChecker.sol";

/// @notice Deploys the registry and both markets with the demo parameters, and registers the
///         built-in task types: image-classify-v1 (replicated) and nonce-search-v1 (checked).
///         `Chain.deploy` in degpu/chain.py does the same and also registers every other task
///         installed under degpu/tasks/; this script is the standalone Foundry path.
/// Usage (anvil account 0 as owner):
///   RUNNER_HASH=0x<runner hash of image_classify_v1> forge script script/Deploy.s.sol \
///     --rpc-url http://127.0.0.1:8545 --broadcast --private-key <anvil key 0>
contract Deploy is Script {
    uint256 public constant MIN_STAKE = 0.8 ether;

    /// The demo parameters of INTERFACE.md section 7.
    function replicatedParams() public pure returns (ReplicatedMarket.Params memory) {
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

    /// The demo parameters of INTERFACE.md section 8.
    function checkedParams() public pure returns (CheckedMarket.Params memory) {
        return CheckedMarket.Params({acceptWindow: 300, workWindow: 300, missedSlashBps: 1000});
    }

    function run() external returns (ProviderRegistry registry, ReplicatedMarket replicated, CheckedMarket checked) {
        bytes32 runnerHash = vm.envBytes32("RUNNER_HASH");

        vm.startBroadcast();
        registry = new ProviderRegistry(MIN_STAKE);
        replicated = new ReplicatedMarket(address(registry), replicatedParams());
        checked = new CheckedMarket(address(registry), checkedParams());
        registry.addMarket(address(replicated));
        registry.addMarket(address(checked));
        replicated.addTaskType(runnerHash, "image-classify-v1", 1);
        checked.addTaskType(new NonceChecker(), "nonce-search-v1", 2);
        vm.stopBroadcast();

        console.log("ProviderRegistry:", address(registry));
        console.log("ReplicatedMarket:", address(replicated));
        console.log("CheckedMarket:", address(checked));
    }
}
