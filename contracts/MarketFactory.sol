// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "./BinaryMarket.sol";
import "./ScalarMarket.sol";
import "./interfaces/IPriceOracle.sol";

contract MarketFactory {

    // ── State ─────────────────────────────────────────────────────────────
    address public owner;
    address public treasury;
    address public oracle;
    address public usdc;
    uint256 public feeBps;
    uint256 public freshnessWindow;
    bool    public paused;

    address[] public binaryMarkets;
    address[] public scalarMarkets;

    mapping(address => bool)     public isBinaryMarket;
    mapping(address => bool)     public isScalarMarket;
    mapping(address => address[]) public creatorBinaryMarkets;
    mapping(address => address[]) public creatorScalarMarkets;

    // ── Structs — avoids stack too deep ───────────────────────────────────
    // All child constructor args packed into memory structs.
    // Solidity counts struct fields as ONE stack slot, not N slots.
    struct BinaryParams {
        bytes32 feedId;
        string  question;
        uint256 strikePrice;
        uint256 expiryTime;
        uint256 resolutionTime;
    }

    struct ScalarParams {
        bytes32 feedId;
        string  question;
        uint256 floorPrice;
        uint256 capPrice;
        uint256 expiryTime;
        uint256 resolutionTime;
    }

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

    event OracleUpdated   (address indexed oldOracle,   address indexed newOracle);
    event TreasuryUpdated (address indexed oldTreasury, address indexed newTreasury);
    event FeeUpdated      (uint256 oldFee, uint256 newFee);
    event FreshnessUpdated(uint256 oldWindow, uint256 newWindow);
    event Paused          (bool paused);

    // ── Errors ────────────────────────────────────────────────────────────
    error Unauthorized();
    error ZeroAddress();
    error FactoryPaused();
    error InvalidFee();
    error InvalidPriceRange();
    error InvalidStrikePrice();
    error FeedNotRegistered(bytes32 feedId);
    error ExpiryMustBeInFuture();
    error ExpiryMustBeBeforeResolution();

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
        if (_feeBps   >  1000)       revert InvalidFee();

        owner           = msg.sender;
        usdc            = _usdc;
        oracle          = _oracle;
        treasury        = _treasury;
        feeBps          = _feeBps;
        freshnessWindow = _freshnessWindow;
    }

    // ─────────────────────────────────────────────────────────────────────
    // CREATE BINARY MARKET
    // Parameters packed into BinaryParams struct to avoid stack too deep
    // ─────────────────────────────────────────────────────────────────────
    function createBinaryMarket(
        bytes32        feedId,
        string calldata question,
        uint256        strikePrice,
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
        if (strikePrice == 0)
            revert InvalidStrikePrice();
        if (expiryTime <= block.timestamp)
            revert ExpiryMustBeInFuture();
        if (resolutionTime <= expiryTime)
            revert ExpiryMustBeBeforeResolution();

        // ── Pack into struct → deploy ─────────────────────────────────────
        // Packing into memory struct keeps stack depth under 16 slots
        BinaryParams memory p = BinaryParams({
            feedId:         feedId,
            question:       question,
            strikePrice:    strikePrice,
            expiryTime:     expiryTime,
            resolutionTime: resolutionTime
        });

        market = _deployBinary(p);

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

        // ── Pack into struct → deploy ─────────────────────────────────────
        ScalarParams memory p = ScalarParams({
            feedId:         feedId,
            question:       question,
            floorPrice:     floorPrice,
            capPrice:       capPrice,
            expiryTime:     expiryTime,
            resolutionTime: resolutionTime
        });

        market = _deployScalar(p);

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
    // INTERNAL: deploy BinaryMarket
    // Separated into its own function — each function has its own stack frame.
    // This is the key fix: splitting the deployment into a separate internal
    // function resets the stack depth counter to 0 for that call frame.
    // ─────────────────────────────────────────────────────────────────────
    function _deployBinary(BinaryParams memory p)
        internal
        returns (address)
    {
        BinaryMarket m = new BinaryMarket(
            usdc,
            oracle,
            address(this),
            treasury,
            tx.origin,        // original caller (creator)
            p.feedId,
            p.question,
            p.strikePrice,
            p.expiryTime,
            p.resolutionTime,
            feeBps,
            freshnessWindow
        );
        return address(m);
    }

    // ─────────────────────────────────────────────────────────────────────
    // INTERNAL: deploy ScalarMarket
    // ─────────────────────────────────────────────────────────────────────
    function _deployScalar(ScalarParams memory p)
        internal
        returns (address)
    {
        ScalarMarket m = new ScalarMarket(
            usdc,
            oracle,
            address(this),
            treasury,
            tx.origin,        // original caller (creator)
            p.feedId,
            p.question,
            p.floorPrice,
            p.capPrice,
            p.expiryTime,
            p.resolutionTime,
            feeBps,
            freshnessWindow
        );
        return address(m);
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
