// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "./BinaryMarket.sol";
import "./ScalarMarket.sol";
import "./interfaces/IPriceOracle.sol";

// ─────────────────────────────────────────────────────────────────────────────
// MarketFactory — Creates and tracks all prediction markets
//
// This is the single entry point for the entire protocol.
// Deploy this once → use it to spawn unlimited markets.
//
// Design:
//   - Stores oracle address — all child markets inherit it
//   - Validates all market parameters before deployment
//   - Emits events for off-chain indexing
//   - Owner can pause factory to stop new market creation
//   - Treasury address receives all protocol fees from all markets
//   - Protocol fee and freshness window are configurable
// ─────────────────────────────────────────────────────────────────────────────

contract MarketFactory {

    // ── State ─────────────────────────────────────────────────────────────
    address public owner;
    address public treasury;
    address public oracle;
    address public usdc;

    uint256 public feeBps;            // protocol fee for all markets
    uint256 public freshnessWindow;   // max oracle age in seconds
    bool    public paused;            // emergency stop — no new markets

    // All deployed binary markets
    address[] public binaryMarkets;

    // All deployed scalar markets
    address[] public scalarMarkets;

    // marketAddress → true (quick lookup)
    mapping(address => bool) public isBinaryMarket;
    mapping(address => bool) public isScalarMarket;

    // creator → list of markets they created
    mapping(address => address[]) public creatorBinaryMarkets;
    mapping(address => address[]) public creatorScalarMarkets;

    // ── Events ────────────────────────────────────────────────────────────
    event BinaryMarketCreated(
        address indexed market,
        address indexed creator,
        bytes32 indexed feedId,
        string  question,
        uint256 strikePrice,
        uint256 expiryTime,
        uint256 resolutionTime
    );

    event ScalarMarketCreated(
        address indexed market,
        address indexed creator,
        bytes32 indexed feedId,
        string  question,
        uint256 floorPrice,
        uint256 capPrice,
        uint256 expiryTime,
        uint256 resolutionTime
    );

    event OracleUpdated  (address indexed oldOracle,   address indexed newOracle);
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event FeeUpdated     (uint256 oldFee, uint256 newFee);
    event FreshnessUpdated(uint256 oldWindow, uint256 newWindow);
    event Paused         (bool paused);

    // ── Errors ────────────────────────────────────────────────────────────
    error Unauthorized();
    error ZeroAddress();
    error FactoryPaused();
    error InvalidFee();
    error InvalidTimestamps();
    error InvalidPriceRange();
    error InvalidStrikePrice();
    error FeedNotRegistered(bytes32 feedId);
    error ExpiryMustBeBeforeResolution();
    error ExpiryMustBeInFuture();

    // ── Modifiers ─────────────────────────────────────────────────────────
    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier notPaused() {
        if (paused) revert FactoryPaused();
        _;
    }

    // ── Constructor ───────────────────────────────────────────────────────
    constructor(
        address _usdc,
        address _oracle,
        address _treasury,
        uint256 _feeBps,
        uint256 _freshnessWindow
    ) {
        if (_usdc     == address(0)) revert ZeroAddress();
        if (_oracle   == address(0)) revert ZeroAddress();
        if (_treasury == address(0)) revert ZeroAddress();
        if (_feeBps   >  1000)       revert InvalidFee(); // max 10%

        owner            = msg.sender;
        usdc             = _usdc;
        oracle           = _oracle;
        treasury         = _treasury;
        feeBps           = _feeBps;
        freshnessWindow  = _freshnessWindow;
    }

    // ─────────────────────────────────────────────────────────────────────
    // CREATE BINARY MARKET
    //
    // @param feedId         Oracle feed ID (e.g. keccak256("BTC_USD"))
    // @param question       Human-readable question string
    // @param strikePrice    Price threshold in 8 decimals
    // @param expiryTime     Unix timestamp — betting closes
    // @param resolutionTime Unix timestamp — oracle is read (must be > expiry)
    // ─────────────────────────────────────────────────────────────────────
    function createBinaryMarket(
        bytes32       feedId,
        string calldata question,
        uint256       strikePrice,
        uint256       expiryTime,
        uint256       resolutionTime
    )
        external
        notPaused
        returns (address market)
    {
        // ── Validate ──────────────────────────────────────────────────────
        if (!IPriceOracle(oracle).feedExists(feedId))
            revert FeedNotRegistered(feedId);

        if (strikePrice == 0)
            revert InvalidStrikePrice();

        if (expiryTime <= block.timestamp)
            revert ExpiryMustBeInFuture();

        if (resolutionTime <= expiryTime)
            revert ExpiryMustBeBeforeResolution();

        // ── Deploy ────────────────────────────────────────────────────────
        BinaryMarket m = new BinaryMarket(
            usdc,
            oracle,
            address(this),
            treasury,
            msg.sender,
            feedId,
            question,
            strikePrice,
            expiryTime,
            resolutionTime,
            feeBps,
            freshnessWindow
        );

        market = address(m);

        // ── Track ─────────────────────────────────────────────────────────
        binaryMarkets.push(market);
        isBinaryMarket[market] = true;
        creatorBinaryMarkets[msg.sender].push(market);

        emit BinaryMarketCreated(
            market,
            msg.sender,
            feedId,
            question,
            strikePrice,
            expiryTime,
            resolutionTime
        );
    }

    // ─────────────────────────────────────────────────────────────────────
    // CREATE SCALAR MARKET
    //
    // @param feedId         Oracle feed ID
    // @param question       Human-readable question string
    // @param floorPrice     Minimum price (8 dec) — below this = full SHORT win
    // @param capPrice       Maximum price (8 dec) — above this = full LONG win
    // @param expiryTime     Unix timestamp — positions lock
    // @param resolutionTime Unix timestamp — oracle is read
    // ─────────────────────────────────────────────────────────────────────
    function createScalarMarket(
        bytes32        feedId,
        string calldata question,
        uint256        floorPrice,
        uint256        capPrice,
        uint256        expiryTime,
        uint256        resolutionTime
    )
        external
        notPaused
        returns (address market)
    {
        // ── Validate ──────────────────────────────────────────────────────
        if (!IPriceOracle(oracle).feedExists(feedId))
            revert FeedNotRegistered(feedId);

        if (floorPrice == 0 || capPrice == 0)
            revert InvalidPriceRange();

        if (floorPrice >= capPrice)
            revert InvalidPriceRange();

        if (expiryTime <= block.timestamp)
            revert ExpiryMustBeInFuture();

        if (resolutionTime <= expiryTime)
            revert ExpiryMustBeBeforeResolution();

        // ── Deploy ────────────────────────────────────────────────────────
        ScalarMarket m = new ScalarMarket(
            usdc,
            oracle,
            address(this),
            treasury,
            msg.sender,
            feedId,
            question,
            floorPrice,
            capPrice,
            expiryTime,
            resolutionTime,
            feeBps,
            freshnessWindow
        );

        market = address(m);

        // ── Track ─────────────────────────────────────────────────────────
        scalarMarkets.push(market);
        isScalarMarket[market] = true;
        creatorScalarMarkets[msg.sender].push(market);

        emit ScalarMarketCreated(
            market,
            msg.sender,
            feedId,
            question,
            floorPrice,
            capPrice,
            expiryTime,
            resolutionTime
        );
    }

    // ─────────────────────────────────────────────────────────────────────
    // VIEWS
    // ─────────────────────────────────────────────────────────────────────

    function getBinaryMarketCount() external view returns (uint256) {
        return binaryMarkets.length;
    }

    function getScalarMarketCount() external view returns (uint256) {
        return scalarMarkets.length;
    }

    function getAllBinaryMarkets() external view returns (address[] memory) {
        return binaryMarkets;
    }

    function getAllScalarMarkets() external view returns (address[] memory) {
        return scalarMarkets;
    }

    function getCreatorBinaryMarkets(address creator)
        external view returns (address[] memory)
    {
        return creatorBinaryMarkets[creator];
    }

    function getCreatorScalarMarkets(address creator)
        external view returns (address[] memory)
    {
        return creatorScalarMarkets[creator];
    }

    // ─────────────────────────────────────────────────────────────────────
    // ADMIN
    // ─────────────────────────────────────────────────────────────────────

    function setOracle(address newOracle) external onlyOwner {
        if (newOracle == address(0)) revert ZeroAddress();
        emit OracleUpdated(oracle, newOracle);
        oracle = newOracle;
    }

    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        emit TreasuryUpdated(treasury, newTreasury);
        treasury = newTreasury;
    }

    function setFee(uint256 newFeeBps) external onlyOwner {
        if (newFeeBps > 1000) revert InvalidFee();
        emit FeeUpdated(feeBps, newFeeBps);
        feeBps = newFeeBps;
    }

    function setFreshnessWindow(uint256 newWindow) external onlyOwner {
        emit FreshnessUpdated(freshnessWindow, newWindow);
        freshnessWindow = newWindow;
    }

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit Paused(_paused);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        owner = newOwner;
    }

    // ── Safety ────────────────────────────────────────────────────────────
    receive()  external payable { revert("MarketFactory: no USDC accepted"); }
    fallback() external payable { revert("MarketFactory: unknown function"); }
}
