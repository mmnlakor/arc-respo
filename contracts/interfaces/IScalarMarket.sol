// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

// ─────────────────────────────────────────────────────────────────────────────
// IScalarMarket — Interface for price-range prediction markets
//
// Scalar markets resolve to a value on a continuous range [floor, cap].
// LONG positions profit when price is HIGH (near cap).
// SHORT positions profit when price is LOW (near floor).
//
// Payout formula:
//   longPayout  = (settledPrice - floor) / (cap - floor)
//   shortPayout = 1 - longPayout
//
// Example: floor=$2000, cap=$4000, settled=$3000
//   longPayout  = (3000 - 2000) / (4000 - 2000) = 0.5  → LONG gets 50% of pool
//   shortPayout = 0.5                                    → SHORT gets 50% of pool
// ─────────────────────────────────────────────────────────────────────────────

interface IScalarMarket {

    // ── Enums ─────────────────────────────────────────────────────────────
    enum Side   { LONG, SHORT }
    enum Status { OPEN, CLOSED, RESOLVED }

    // ── Structs ───────────────────────────────────────────────────────────
    struct MarketInfo {
        string  question;       // "What will ETH price be on Aug 1 2026?"
        bytes32 feedId;         // oracle feed ID
        uint256 floorPrice;     // minimum price (8 decimals) → full SHORT payout
        uint256 capPrice;       // maximum price (8 decimals) → full LONG payout
        uint256 expiryTime;     // unix timestamp — market closes
        uint256 resolutionTime; // unix timestamp — oracle is read
        uint256 totalLong;      // total USDC on LONG side (6 dec)
        uint256 totalShort;     // total USDC on SHORT side (6 dec)
        uint256 settledPrice;   // oracle price at resolution (8 dec)
        uint256 longPayoutBps;  // LONG payout ratio in bps (0–10000) after resolution
        uint256 feeBps;         // protocol fee in basis points
        Status  status;
        address creator;
        address oracle;
    }

    // ── Events ────────────────────────────────────────────────────────────
    event PositionTaken  (address indexed user, Side side, uint256 amount, uint256 shares);
    event MarketClosed   (uint256 timestamp);
    event MarketResolved (uint256 settledPrice, uint256 longPayoutBps);
    event WinningsClaimed(address indexed user, uint256 amount);
    event FeeCollected   (address indexed treasury, uint256 amount);

    // ── Write ─────────────────────────────────────────────────────────────
    function takePosition(Side side, uint256 usdcAmount) external;
    function resolve()                                   external;
    function claim()                                     external;

    // ── Read ──────────────────────────────────────────────────────────────
    function getInfo()                        external view returns (MarketInfo memory);
    function getPosition(address user)        external view returns (uint256 longShares, uint256 shortShares);
    function getClaimableAmount(address user) external view returns (uint256);
    function hasClaimed(address user)         external view returns (bool);
}
