// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

// ─────────────────────────────────────────────────────────────────────────────
// IBinaryMarket — Interface for YES/NO prediction markets
// ─────────────────────────────────────────────────────────────────────────────

interface IBinaryMarket {

    // ── Enums ─────────────────────────────────────────────────────────────
    enum Outcome  { UNRESOLVED, YES, NO }
    enum Side     { YES, NO }
    enum Status   { OPEN, CLOSED, RESOLVED }

    // ── Structs ───────────────────────────────────────────────────────────
    struct MarketInfo {
        string  question;       // "Will BTC exceed $100k by Aug 1 2026?"
        bytes32 feedId;         // oracle feed ID
        uint256 strikePrice;    // price threshold (8 decimals)
        uint256 expiryTime;     // unix timestamp — market closes at this time
        uint256 resolutionTime; // unix timestamp — oracle read at/after this time
        uint256 totalYes;       // total USDC bet on YES (6 dec)
        uint256 totalNo;        // total USDC bet on NO  (6 dec)
        uint256 settledPrice;   // oracle price at resolution (8 dec)
        uint256 feeBps;         // protocol fee in basis points
        Outcome outcome;
        Status  status;
        address creator;
        address oracle;
    }

    // ── Events ────────────────────────────────────────────────────────────
    event BetPlaced   (address indexed user, Side side, uint256 amount, uint256 shares);
    event MarketClosed(uint256 timestamp);
    event MarketResolved(Outcome outcome, uint256 settledPrice);
    event WinningsClaimed(address indexed user, uint256 amount);
    event FeeCollected(address indexed treasury, uint256 amount);

    // ── Write ─────────────────────────────────────────────────────────────
    function bet(Side side, uint256 usdcAmount)  external;
    function resolve()                           external;
    function claim()                             external;

    // ── Read ──────────────────────────────────────────────────────────────
    function getInfo()                           external view returns (MarketInfo memory);
    function getPosition(address user)           external view returns (uint256 yesShares, uint256 noShares);
    function getClaimableAmount(address user)    external view returns (uint256);
    function hasClaimed(address user)            external view returns (bool);
}
