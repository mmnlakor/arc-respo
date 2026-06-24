// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "./interfaces/IUSDC.sol";
import "./interfaces/IPriceOracle.sol";
import "./interfaces/IScalarMarket.sol";

// ─────────────────────────────────────────────────────────────────────────────
// ScalarMarket — Continuous price-range prediction market
//
// Flow:
//   1. Factory deploys with [floorPrice, capPrice] range + oracle feed
//   2. Users call takePosition(Side.LONG, amount) or takePosition(Side.SHORT, amount)
//   3. After expiryTime → positions locked
//   4. After resolutionTime → anyone calls resolve()
//      → oracle price clamped to [floor, cap]
//      → longPayoutBps computed via linear interpolation
//   5. Both LONG and SHORT holders call claim()
//      → each receives proportional USDC based on payout ratio
//
// Payout math (all in basis points, 10_000 = 100%):
//   clampedPrice  = max(floor, min(cap, settledPrice))
//   longPayoutBps = (clampedPrice - floor) * 10_000 / (cap - floor)
//   shortPayoutBps = 10_000 - longPayoutBps
//
//   LONG user payout  = userLongShares  * longNetPool  / totalLong
//   SHORT user payout = userShortShares * shortNetPool / totalShort
//
//   where:
//     totalPool     = totalLong + totalShort
//     fee           = totalPool * feeBps / 10_000
//     netPool       = totalPool - fee
//     longNetPool   = netPool * longPayoutBps  / 10_000
//     shortNetPool  = netPool * shortPayoutBps / 10_000
//
// Arc-specific: same rules as BinaryMarket apply.
// ─────────────────────────────────────────────────────────────────────────────

contract ScalarMarket is IScalarMarket {

    // ── Immutables ────────────────────────────────────────────────────────
    IUSDC          public immutable usdc;
    IPriceOracle   public immutable oracle;
    address        public immutable factory;
    address        public immutable treasury;
    address        public immutable creator;
    bytes32        public immutable feedId;
    uint256        public immutable floorPrice;      // 8 decimals
    uint256        public immutable capPrice;        // 8 decimals
    uint256        public immutable expiryTime;
    uint256        public immutable resolutionTime;
    uint256        public immutable feeBps;
    uint256        public immutable freshnessWindow;

    // ── Storage ───────────────────────────────────────────────────────────
    string  private _question;

    uint256 public totalLong;         // total USDC on LONG  (6 dec)
    uint256 public totalShort;        // total USDC on SHORT (6 dec)
    uint256 public settledPrice;      // oracle price at resolution (8 dec)
    uint256 public longPayoutBps;     // LONG payout ratio 0–10_000
    uint256 public feeCollected;

    Status  public status = Status.OPEN;

    // user → LONG shares (1:1 with USDC deposited)
    mapping(address => uint256) public longShares;

    // user → SHORT shares
    mapping(address => uint256) public shortShares;

    // user → has claimed
    mapping(address => bool) public claimed;

    // ── Errors ────────────────────────────────────────────────────────────
    error MarketNotOpen();
    error MarketNotResolved();
    error AlreadyClaimed();
    error NothingToClaim();
    error ZeroAmount();
    error ZeroAddress();
    error BettingClosed();
    error ResolutionTooEarly();
    error OraclePriceStale();
    error OraclePriceZero();
    error TransferFailed();
    error InvalidFee();
    error InvalidPriceRange();

    // ── Constructor ───────────────────────────────────────────────────────
    constructor(
        address _usdc,
        address _oracle,
        address _factory,
        address _treasury,
        address _creator,
        bytes32 _feedId,
        string  memory _q,
        uint256 _floorPrice,
        uint256 _capPrice,
        uint256 _expiryTime,
        uint256 _resolutionTime,
        uint256 _feeBps,
        uint256 _freshnessWindow
    ) {
        if (_usdc     == address(0))     revert ZeroAddress();
        if (_oracle   == address(0))     revert ZeroAddress();
        if (_factory  == address(0))     revert ZeroAddress();
        if (_treasury == address(0))     revert ZeroAddress();
        if (_creator  == address(0))     revert ZeroAddress();
        if (_feeBps   > 1000)            revert InvalidFee();
        if (_floorPrice >= _capPrice)    revert InvalidPriceRange();

        usdc            = IUSDC(_usdc);
        oracle          = IPriceOracle(_oracle);
        factory         = _factory;
        treasury        = _treasury;
        creator         = _creator;
        feedId          = _feedId;
        _question       = _q;
        floorPrice      = _floorPrice;
        capPrice        = _capPrice;
        expiryTime      = _expiryTime;
        resolutionTime  = _resolutionTime;
        feeBps          = _feeBps;
        freshnessWindow = _freshnessWindow;
    }

    // ─────────────────────────────────────────────────────────────────────
    // TAKE POSITION
    // ─────────────────────────────────────────────────────────────────────
    function takePosition(Side side, uint256 usdcAmount) external {
        // ── Checks ────────────────────────────────────────────────────────
        if (usdcAmount == 0)               revert ZeroAmount();
        if (block.timestamp >= expiryTime) revert BettingClosed();
        if (status != Status.OPEN)         revert MarketNotOpen();

        // ── Effects ───────────────────────────────────────────────────────
        if (side == Side.LONG) {
            longShares[msg.sender]  += usdcAmount;
            totalLong               += usdcAmount;
        } else {
            shortShares[msg.sender] += usdcAmount;
            totalShort              += usdcAmount;
        }

        // ── Interactions ──────────────────────────────────────────────────
        bool ok = usdc.transferFrom(msg.sender, address(this), usdcAmount);
        if (!ok) revert TransferFailed();

        emit PositionTaken(msg.sender, side, usdcAmount, usdcAmount);
    }

    // ─────────────────────────────────────────────────────────────────────
    // RESOLVE
    // ─────────────────────────────────────────────────────────────────────
    function resolve() external {
        // ── Checks ────────────────────────────────────────────────────────
        if (status == Status.RESOLVED)         revert MarketNotResolved();
        if (block.timestamp < resolutionTime)  revert ResolutionTooEarly();

        bool fresh = oracle.isFresh(feedId, freshnessWindow);
        if (!fresh) revert OraclePriceStale();

        (uint256 price,,) = oracle.getPrice(feedId);
        if (price == 0) revert OraclePriceZero();

        // ── Effects ───────────────────────────────────────────────────────
        settledPrice = price;
        status       = Status.RESOLVED;

        // Clamp price to [floor, cap]
        uint256 clampedPrice = price;
        if (clampedPrice < floorPrice) clampedPrice = floorPrice;
        if (clampedPrice > capPrice)   clampedPrice = capPrice;

        // Linear interpolation → longPayoutBps
        // longPayoutBps = (clamped - floor) * 10_000 / (cap - floor)
        longPayoutBps = ((clampedPrice - floorPrice) * 10_000) / (capPrice - floorPrice);

        emit MarketResolved(settledPrice, longPayoutBps);
    }

    // ─────────────────────────────────────────────────────────────────────
    // CLAIM
    // Both LONG and SHORT holders can claim — they each get a slice of the
    // net pool proportional to their side's payout ratio.
    // ─────────────────────────────────────────────────────────────────────
    function claim() external {
        // ── Checks ────────────────────────────────────────────────────────
        if (status != Status.RESOLVED) revert MarketNotResolved();
        if (claimed[msg.sender])       revert AlreadyClaimed();

        uint256 payout = _calculatePayout(msg.sender);
        if (payout == 0) revert NothingToClaim();

        // ── Effects ───────────────────────────────────────────────────────
        claimed[msg.sender] = true;

        // ── Interactions ──────────────────────────────────────────────────
        uint256 totalPool = totalLong + totalShort;
        if (feeCollected == 0 && totalPool > 0) {
            uint256 fee = (totalPool * feeBps) / 10_000;
            feeCollected = fee;

            if (fee > 0) {
                bool feeOk = usdc.transfer(treasury, fee);
                if (!feeOk) revert TransferFailed();
                emit FeeCollected(treasury, fee);
            }
        }

        bool ok = usdc.transfer(msg.sender, payout);
        if (!ok) revert TransferFailed();

        emit WinningsClaimed(msg.sender, payout);
    }

    // ─────────────────────────────────────────────────────────────────────
    // VIEW: getInfo
    // ─────────────────────────────────────────────────────────────────────
    function getInfo() external view returns (MarketInfo memory) {
        return MarketInfo({
            question:       _question,
            feedId:         feedId,
            floorPrice:     floorPrice,
            capPrice:       capPrice,
            expiryTime:     expiryTime,
            resolutionTime: resolutionTime,
            totalLong:      totalLong,
            totalShort:     totalShort,
            settledPrice:   settledPrice,
            longPayoutBps:  longPayoutBps,
            feeBps:         feeBps,
            status:         _currentStatus(),
            creator:        creator,
            oracle:         address(oracle)
        });
    }

    // ─────────────────────────────────────────────────────────────────────
    // VIEW: getPosition
    // ─────────────────────────────────────────────────────────────────────
    function getPosition(address user)
        external
        view
        returns (uint256 _longShares, uint256 _shortShares)
    {
        return (longShares[user], shortShares[user]);
    }

    // ─────────────────────────────────────────────────────────────────────
    // VIEW: getClaimableAmount
    // ─────────────────────────────────────────────────────────────────────
    function getClaimableAmount(address user) external view returns (uint256) {
        if (status != Status.RESOLVED) return 0;
        if (claimed[user])             return 0;
        return _calculatePayout(user);
    }

    // ─────────────────────────────────────────────────────────────────────
    // VIEW: hasClaimed
    // ─────────────────────────────────────────────────────────────────────
    function hasClaimed(address user) external view returns (bool) {
        return claimed[user];
    }

    // ─────────────────────────────────────────────────────────────────────
    // INTERNAL: payout calculation
    // ─────────────────────────────────────────────────────────────────────
    function _calculatePayout(address user) internal view returns (uint256) {
        uint256 totalPool = totalLong + totalShort;
        if (totalPool == 0) return 0;

        uint256 fee          = (totalPool * feeBps) / 10_000;
        uint256 netPool      = totalPool - fee;
        uint256 shortPayBps  = 10_000 - longPayoutBps;

        uint256 longNetPool  = (netPool * longPayoutBps)  / 10_000;
        uint256 shortNetPool = (netPool * shortPayBps)    / 10_000;

        uint256 payout = 0;

        // LONG payout
        uint256 lShares = longShares[user];
        if (lShares > 0 && totalLong > 0) {
            payout += (lShares * longNetPool) / totalLong;
        }

        // SHORT payout (same user can hold both sides)
        uint256 sShares = shortShares[user];
        if (sShares > 0 && totalShort > 0) {
            payout += (sShares * shortNetPool) / totalShort;
        }

        return payout;
    }

    // ─────────────────────────────────────────────────────────────────────
    // INTERNAL: current status
    // ─────────────────────────────────────────────────────────────────────
    function _currentStatus() internal view returns (Status) {
        if (status == Status.RESOLVED)            return Status.RESOLVED;
        if (block.timestamp >= resolutionTime)    return Status.CLOSED;
        return Status.OPEN;
    }

    // ── Safety ────────────────────────────────────────────────────────────
    receive()  external payable { revert("ScalarMarket: no USDC accepted"); }
    fallback() external payable { revert("ScalarMarket: unknown function"); }
}
