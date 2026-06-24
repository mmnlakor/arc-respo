// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "./interfaces/IPriceOracle.sol";

// ─────────────────────────────────────────────────────────────────────────────
// PriceOracle — Mock price oracle for Arc Testnet
//
// On testnet there is no live Chainlink. This contract simulates it.
// The owner pushes prices for any registered feed.
// In production you would replace this with a Chainlink AggregatorV3
// adapter that reads from an actual price feed.
//
// Arc-specific notes:
//   - No PREVRANDAO (not needed here, no randomness)
//   - Uses block.timestamp for price freshness — Arc timestamps are
//     non-strictly increasing, so freshness checks use >= not ==
//   - Owner can update prices in a single batch tx to save gas (USDC)
// ─────────────────────────────────────────────────────────────────────────────

contract PriceOracle is IPriceOracle {

    // ── State ─────────────────────────────────────────────────────────────
    address public owner;
    address public pendingOwner;

    // feedId → PriceFeed
    mapping(bytes32 => PriceFeed)  private _feeds;

    // feedId → human-readable description (e.g. "BTC / USD")
    mapping(bytes32 => string)     private _descriptions;

    // ordered list of all registered feed IDs
    bytes32[] private _feedIds;

    // ── Errors ────────────────────────────────────────────────────────────
    error Unauthorized();
    error FeedNotFound(bytes32 feedId);
    error FeedAlreadyExists(bytes32 feedId);
    error ZeroPrice();
    error ZeroAddress();
    error ArrayLengthMismatch();
    error NoPendingOwner();

    // ── Modifiers ─────────────────────────────────────────────────────────
    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier feedMustExist(bytes32 feedId) {
        if (!_feeds[feedId].exists) revert FeedNotFound(feedId);
        _;
    }

    // ── Constructor ───────────────────────────────────────────────────────
    constructor() {
        owner = msg.sender;

        // Pre-register common feeds used in prediction markets
        // Prices start at 0 — owner must call updatePrice before markets use them
        _registerFeed(keccak256("BTC_USD"),  "BTC / USD");
        _registerFeed(keccak256("ETH_USD"),  "ETH / USD");
        _registerFeed(keccak256("SOL_USD"),  "SOL / USD");
        _registerFeed(keccak256("BNB_USD"),  "BNB / USD");
        _registerFeed(keccak256("USDT_USD"), "USDT / USD");
        _registerFeed(keccak256("XRP_USD"),  "XRP / USD");
        _registerFeed(keccak256("ADA_USD"),  "ADA / USD");
        _registerFeed(keccak256("DOGE_USD"), "DOGE / USD");
        _registerFeed(keccak256("CPI_US"),   "US CPI Index");
        _registerFeed(keccak256("FED_RATE"), "US Fed Funds Rate");
    }

    // ── External: register a new feed ────────────────────────────────────
    function registerFeed(bytes32 feedId, string calldata description)
        external
        onlyOwner
    {
        if (_feeds[feedId].exists) revert FeedAlreadyExists(feedId);
        _registerFeed(feedId, description);
    }

    // ── External: push a single price update ─────────────────────────────
    // price must have 8 decimal places
    // Example: BTC at $65,432.10 → price = 6_543_210_000_000
    function updatePrice(bytes32 feedId, uint256 price)
        external
        onlyOwner
        feedMustExist(feedId)
    {
        if (price == 0) revert ZeroPrice();

        _feeds[feedId].price     = price;
        _feeds[feedId].updatedAt = block.timestamp;

        emit PriceUpdated(feedId, price, block.timestamp);
    }

    // ── External: batch price update (saves gas / USDC on Arc) ───────────
    function updatePriceBatch(
        bytes32[] calldata feedIds,
        uint256[] calldata prices
    )
        external
        onlyOwner
    {
        if (feedIds.length != prices.length) revert ArrayLengthMismatch();

        uint256 len = feedIds.length;
        for (uint256 i = 0; i < len; ) {
            bytes32 fid   = feedIds[i];
            uint256 price = prices[i];

            if (!_feeds[fid].exists) revert FeedNotFound(fid);
            if (price == 0)          revert ZeroPrice();

            _feeds[fid].price     = price;
            _feeds[fid].updatedAt = block.timestamp;

            emit PriceUpdated(fid, price, block.timestamp);

            unchecked { ++i; }
        }
    }

    // ── External: read a price (used by markets at resolution) ───────────
    // Returns (price, updatedAt, decimals)
    // Callers must check freshness themselves via isFresh()
    function getPrice(bytes32 feedId)
        external
        view
        feedMustExist(feedId)
        returns (uint256 price, uint256 updatedAt, uint8 decimals)
    {
        PriceFeed storage feed = _feeds[feedId];
        return (feed.price, feed.updatedAt, feed.decimals);
    }

    // ── External: get full feed struct ───────────────────────────────────
    function getFeed(bytes32 feedId)
        external
        view
        feedMustExist(feedId)
        returns (PriceFeed memory)
    {
        return _feeds[feedId];
    }

    // ── External: check if price is fresh enough ─────────────────────────
    // Arc: block.timestamp is non-strictly increasing.
    // A price updated in the same block as the freshness check will pass.
    function isFresh(bytes32 feedId, uint256 maxAgeSeconds)
        external
        view
        feedMustExist(feedId)
        returns (bool)
    {
        return (block.timestamp - _feeds[feedId].updatedAt) <= maxAgeSeconds;
    }

    // ── External: check if feed is registered ────────────────────────────
    function feedExists(bytes32 feedId) external view returns (bool) {
        return _feeds[feedId].exists;
    }

    // ── External: get description of a feed ──────────────────────────────
    function getDescription(bytes32 feedId)
        external
        view
        feedMustExist(feedId)
        returns (string memory)
    {
        return _descriptions[feedId];
    }

    // ── External: list all registered feed IDs ───────────────────────────
    function getAllFeedIds() external view returns (bytes32[] memory) {
        return _feedIds;
    }

    // ── Ownership: two-step transfer ──────────────────────────────────────
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        pendingOwner = newOwner;
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NoPendingOwner();
        owner        = pendingOwner;
        pendingOwner = address(0);
    }

    // ── Internal ──────────────────────────────────────────────────────────
    function _registerFeed(bytes32 feedId, string memory description) internal {
        _feeds[feedId] = PriceFeed({
            price:     0,
            updatedAt: 0,
            decimals:  8,
            exists:    true
        });
        _descriptions[feedId] = description;
        _feedIds.push(feedId);

        emit FeedRegistered(feedId, description);
    }

    // ── Safety ────────────────────────────────────────────────────────────
    receive()  external payable { revert("PriceOracle: no USDC accepted"); }
    fallback() external payable { revert("PriceOracle: unknown function"); }
}
