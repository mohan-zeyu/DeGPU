// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title ProviderRegistry
/// @notice Keeps every compute provider's stake, X25519 encryption key, per-item price and
///         reputation counters. Only the JobMarket may lock, unlock, slash or bump stats.
/// @dev See docs/INTERFACE.md section 6.
contract ProviderRegistry {
    /// Reputation counters. Main providers use the first four, verifiers and tie-breakers the last three.
    enum Stat {
        VerifiedCompleted,
        UnverifiedCompleted,
        Missed,
        Outvoted,
        ChecksCompleted,
        ChecksMissed,
        ChecksOutvoted
    }

    struct Provider {
        bool registered;
        uint256 stake;
        bytes32 encPubKey; // X25519 public key used to seal job secrets to this provider
        uint256 pricePerItem; // wei per item
        uint256 locks; // number of open jobs this provider takes part in
    }

    address public immutable owner;
    uint256 public immutable minStake;
    address public market; // the JobMarket, set once by the owner

    mapping(address => Provider) internal providers;
    address[] internal providerList;
    mapping(address => mapping(Stat => uint256)) internal stats;

    event ProviderRegistered(address indexed provider, bytes32 encPubKey, uint256 pricePerItem, uint256 stake);
    event StakeChanged(address indexed provider, uint256 newStake);
    event Slashed(address indexed provider, uint256 amount);

    modifier onlyMarket() {
        require(msg.sender == market, "not market");
        _;
    }

    modifier onlyRegistered() {
        require(providers[msg.sender].registered, "not registered");
        _;
    }

    constructor(uint256 minStake_) {
        owner = msg.sender;
        minStake = minStake_;
    }

    /// @notice Owner only, once: tell the registry which JobMarket may lock/slash providers.
    function setMarket(address market_) external {
        require(msg.sender == owner, "not owner");
        require(market == address(0), "market already set");
        require(market_ != address(0), "zero market");
        market = market_;
    }

    // ------------------------------------------------------------------
    // Provider actions
    // ------------------------------------------------------------------

    /// @notice Join as a provider with at least `minStake` wei of stake.
    function register(bytes32 encPubKey, uint256 pricePerItem) external payable {
        Provider storage p = providers[msg.sender];
        require(!p.registered, "already registered");
        require(msg.value >= minStake, "stake too low");
        p.registered = true;
        p.stake = msg.value;
        p.encPubKey = encPubKey;
        p.pricePerItem = pricePerItem;
        providerList.push(msg.sender);
        emit ProviderRegistered(msg.sender, encPubKey, pricePerItem, msg.value);
    }

    function addStake() external payable onlyRegistered {
        Provider storage p = providers[msg.sender];
        p.stake += msg.value;
        emit StakeChanged(msg.sender, p.stake);
    }

    /// @notice Withdraw stake. Only allowed while the provider is not part of any open job.
    function withdrawStake(uint256 amount) external onlyRegistered {
        Provider storage p = providers[msg.sender];
        require(p.locks == 0, "locked");
        require(amount <= p.stake, "amount > stake");
        // effects before the interaction
        p.stake -= amount;
        emit StakeChanged(msg.sender, p.stake);
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "transfer failed");
    }

    function setPrice(uint256 pricePerItem) external onlyRegistered {
        providers[msg.sender].pricePerItem = pricePerItem;
    }

    function setEncPubKey(bytes32 encPubKey) external onlyRegistered {
        providers[msg.sender].encPubKey = encPubKey;
    }

    // ------------------------------------------------------------------
    // JobMarket only
    // ------------------------------------------------------------------

    function lock(address p) external onlyMarket {
        providers[p].locks++;
    }

    function unlock(address p) external onlyMarket {
        require(providers[p].locks > 0, "not locked");
        providers[p].locks--;
    }

    /// @notice Take `bps` basis points of `p`'s stake and send it to the market.
    function slash(address p, uint256 bps) external onlyMarket returns (uint256 amount) {
        require(bps <= 10000, "bps > 10000");
        Provider storage pr = providers[p];
        amount = (pr.stake * bps) / 10000;
        // effects before the interaction
        pr.stake -= amount;
        emit Slashed(p, amount);
        emit StakeChanged(p, pr.stake);
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "transfer failed");
    }

    function bump(address p, Stat s) external onlyMarket {
        stats[p][s]++;
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    /// @notice A provider can take jobs while it is registered and its stake is at least `minStake`.
    function isActive(address p) external view returns (bool) {
        Provider storage pr = providers[p];
        return pr.registered && pr.stake >= minStake;
    }

    function providerCount() external view returns (uint256) {
        return providerList.length;
    }

    function providerAt(uint256 i) external view returns (address) {
        return providerList[i];
    }

    function getProvider(address p)
        external
        view
        returns (bool registered, uint256 stake, bytes32 encPubKey, uint256 pricePerItem, uint256 locks)
    {
        Provider storage pr = providers[p];
        return (pr.registered, pr.stake, pr.encPubKey, pr.pricePerItem, pr.locks);
    }

    function statOf(address p, Stat s) external view returns (uint256) {
        return stats[p][s];
    }
}
