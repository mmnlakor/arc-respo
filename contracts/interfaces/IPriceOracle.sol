// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

// ─────────────────────────────────────────────────────────────────────────────
// IPriceOracle — Interface for the on-chain price oracle
//
// Feed IDs are bytes32 identifiers, e.g.:
//   bytes32 BTC_USD = keccak256("BTC_USD");
//   bytes32 ETH_USD = keccak256("ETH_USD");
//
// Prices are stored with 8 decimal places (same as Chainlink standard).
// Example: BTC at $65,432.10 → stored as 6_543_210_000_000 (8 dec)
// ─────────────────────────────────────────────────────────────────────────────

interface IPriceOracle {

    // ── Structs ───────────────────────────────────────────────────────────
    struct PriceFeed {
        uint256 price;        // price with 8 decimals
        uint256 updatedAt;    // block.timestamp of last update
        uint8   decimals;     // always 8
        bool    exists;       // feed has been initialized
    }

    // ── Events ────────────────────────────────────────────────────────────
    event PriceUpdated(bytes32 indexed feedId, uint256 price, uint256 updatedAt);
    event FeedRegistered(bytes32 indexed feedId, string description);
    event FeedRemoved(bytes32 indexed feedId);

    // ── Write ─────────────────────────────────────────────────────────────
    function registerFeed(bytes32 feedId, string calldata description) external;
    function updatePrice(bytes32 feedId, uint256 price)                external;
    function updatePriceBatch(bytes32[] calldata feedIds, uint256[] calldata prices) external;

    // ── Read ──────────────────────────────────────────────────────────────
    function getPrice(bytes32 feedId)
        external view
        returns (uint256 price, uint256 updatedAt, uint8 decimals);

    function getFeed(bytes32 feedId)
        external view
        returns (PriceFeed memory);

    function isFresh(bytes32 feedId, uint256 maxAgeSeconds)
        external view
        returns (bool);

    function feedExists(bytes32 feedId)
        external view
        returns (bool);
}
