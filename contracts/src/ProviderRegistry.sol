// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title ProviderRegistry
/// @notice Keeps every compute provider's stake, X25519 encryption key, the task types it offers
///         (with a price per item for each) and its reputation counters. Several markets can use
///         one registry: each market the owner adds may lock, unlock and slash providers and bump
///         its own counters.
/// @dev See docs/INTERFACE.md section 6.
contract ProviderRegistry {
    struct Provider {
        bool registered;
        uint256 stake;
        bytes32 encPubKey; // X25519 public key used to seal job secrets to this provider
        uint256 locks; // number of open jobs this provider takes part in, across all markets
    }

    address public immutable owner;
    uint256 public immutable minStake;

    mapping(address => bool) public isMarket;
    address[] internal marketList;

    mapping(address => Provider) internal providers;
    address[] internal providerList;
    // provider => market => task type => wei per item (0 = not offered)
    mapping(address => mapping(address => mapping(uint256 => uint256))) internal prices;
    // provider => market => stat id (defined by each market) => count
    mapping(address => mapping(address => mapping(uint8 => uint256))) internal stats;

    event MarketAdded(address indexed market);
    event ProviderRegistered(address indexed provider, bytes32 encPubKey, uint256 stake);
    event PriceSet(address indexed provider, address indexed market, uint256 indexed taskType, uint256 pricePerItem);
    event StakeChanged(address indexed provider, uint256 newStake);
    event Slashed(address indexed provider, uint256 amount);

    modifier onlyMarket() {
        require(isMarket[msg.sender], "not market");
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

    /// @notice Owner only: allow `market_` to lock, unlock and slash providers.
    function addMarket(address market_) external {
        require(msg.sender == owner, "not owner");
        require(market_ != address(0), "zero market");
        require(!isMarket[market_], "market already added");
        isMarket[market_] = true;
        marketList.push(market_);
        emit MarketAdded(market_);
    }

    // ------------------------------------------------------------------
    // Provider actions
    // ------------------------------------------------------------------

    /// @notice Join as a provider with at least `minStake` wei of stake. Offer task types with setPrice.
    function register(bytes32 encPubKey) external payable {
        Provider storage p = providers[msg.sender];
        require(!p.registered, "already registered");
        require(msg.value >= minStake, "stake too low");
        p.registered = true;
        p.stake = msg.value;
        p.encPubKey = encPubKey;
        providerList.push(msg.sender);
        emit ProviderRegistered(msg.sender, encPubKey, msg.value);
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

    /// @notice Offer task type `taskType` of `market` at `pricePerItem` wei per item; 0 stops offering it.
    function setPrice(address market, uint256 taskType, uint256 pricePerItem) external onlyRegistered {
        require(isMarket[market], "unknown market");
        prices[msg.sender][market][taskType] = pricePerItem;
        emit PriceSet(msg.sender, market, taskType, pricePerItem);
    }

    function setEncPubKey(bytes32 encPubKey) external onlyRegistered {
        providers[msg.sender].encPubKey = encPubKey;
    }

    // ------------------------------------------------------------------
    // Markets only
    // ------------------------------------------------------------------

    function lock(address p) external onlyMarket {
        providers[p].locks++;
    }

    function unlock(address p) external onlyMarket {
        require(providers[p].locks > 0, "not locked");
        providers[p].locks--;
    }

    /// @notice Take `bps` basis points of `p`'s stake and send it to the calling market.
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

    /// @notice Add `amount` to the calling market's counter `stat` for provider `p`.
    function bump(address p, uint8 stat, uint256 amount) external onlyMarket {
        stats[p][msg.sender][stat] += amount;
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    /// @notice A provider can take jobs while it is registered and its stake is at least `minStake`.
    function isActive(address p) external view returns (bool) {
        Provider storage pr = providers[p];
        return pr.registered && pr.stake >= minStake;
    }

    /// @notice Wei per item `p` charges for `market`'s task type `taskType` (0 = not offered).
    function priceOf(address p, address market, uint256 taskType) external view returns (uint256) {
        return prices[p][market][taskType];
    }

    function providerCount() external view returns (uint256) {
        return providerList.length;
    }

    function providerAt(uint256 i) external view returns (address) {
        return providerList[i];
    }

    function marketCount() external view returns (uint256) {
        return marketList.length;
    }

    function marketAt(uint256 i) external view returns (address) {
        return marketList[i];
    }

    function getProvider(address p)
        external
        view
        returns (bool registered, uint256 stake, bytes32 encPubKey, uint256 locks)
    {
        Provider storage pr = providers[p];
        return (pr.registered, pr.stake, pr.encPubKey, pr.locks);
    }

    function statOf(address p, address market, uint8 stat) external view returns (uint256) {
        return stats[p][market][stat];
    }
}
