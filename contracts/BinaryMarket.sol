// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "./interfaces/IUSDC.sol";
import "./interfaces/IPriceOracle.sol";
import "./interfaces/IBinaryMarket.sol";

// ─────────────────────────────────────────────────────────────────────────────
// BinaryMarket — YES / NO prediction market
//
// Flow:
//   1. Factory deploys this contract with market parameters
//   2. Users call bet(Side.YES, amount) or bet(Side.NO, amount)
//      → USDC pulled from user → shares issued 1:1
//   3. After expiryTime → betting closes automatically
//   4. After resolutionTime → anyone calls resolve()
//      → oracle price read → compared to strikePrice
//      → outcome set to YES or NO
//   5. Winners call claim() → receive proportional USDC minus protocol fee
//
// Share model:
//   1 USDC deposited → 1 share issued
//   If YES wins: 1 YES share = (totalPool - fee) / totalYes USDC
//   If NO wins:  1 NO share  = (totalPool - fee) / totalNo  USDC
//
// Arc-specific:
//   - All USDC amounts in 6 decimals (ERC-20)
//   - Gas paid in native USDC (18 dec) — handled by wallet, not contract
//   - No PREVRANDAO, no SELFDESTRUCT, no zero-address transfers
//   - Checks-Effects-Interactions pattern on all state-changing functions
// ─────────────────────────────────────────────────────────────────────────────

contract BinaryMarket is IBinaryMarket {

    // ── Immutables (set once at construction, stored in bytecode) ─────────
    IUSDC          public immutable usdc;
    IPriceOracle   public immutable oracle;
    address        public immutable factory;
    address        public immutable treasury;   // protocol fee recipient
    address        public immutable creator;
    bytes32        public immutable feedId;
    uint256        public immutable strikePrice;    // 8 decimals
    uint256        public immutable expiryTime;     // unix timestamp
    uint256        public immutable resolutionTime; // unix timestamp
    uint256        public immutable feeBps;         // e.g. 200 = 2%
    uint256        public immutable freshnessWindow; // max oracle age in seconds

    // ── Storage ───────────────────────────────────────────────────────────
    string  private _question;

    uint256 public totalYes;        // total USDC on YES side (6 dec)
    uint256 public totalNo;         // total USDC on NO side  (6 dec)
    uint256 public settledPrice;    // oracle price at resolution (8 dec)
    uint256 public feeCollected;    // protocol fee taken (6 dec)

    Outcome public outcome = Outcome.UNRESOLVED;
    Status  public status  = Status.OPEN;

    // user → YES shares (6 dec, 1:1 with USDC deposited)
    mapping(address => uint256) public yesShares;

    // user → NO shares
    mapping(address => uint256) public noShares;

    // user → has already claimed winnings
    mapping(address => bool)    public claimed;

    // ── Errors ────────────────────────────────────────────────────────────
    error MarketNotOpen();
    error MarketNotClosed();
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

    // ── Constructor ───────────────────────────────────────────────────────
    constructor(
        address _usdc,
        address _oracle,
        address _factory,
        address _treasury,
        address _creator,
        bytes32 _feedId,
        string  memory _q,
        uint256 _strikePrice,
        uint256 _expiryTime,
        uint256 _resolutionTime,
        uint256 _feeBps,
        uint256 _freshnessWindow
    ) {
        if (_usdc     == address(0)) revert ZeroAddress();
        if (_oracle   == address(0)) revert ZeroAddress();
        if (_factory  == address(0)) revert ZeroAddress();
        if (_treasury == address(0)) revert ZeroAddress();
        if (_creator  == address(0)) revert ZeroAddress();
        if (_feeBps   >  1000)       revert InvalidFee(); // max 10%

        usdc             = IUSDC(_usdc);
        oracle           = IPriceOracle(_oracle);
        factory          = _factory;
        treasury         = _treasury;
        creator          = _creator;
        feedId           = _feedId;
        _question        = _q;
        strikePrice      = _strikePrice;
        expiryTime       = _expiryTime;
        resolutionTime   = _resolutionTime;
        feeBps           = _feeBps;
        freshnessWindow  = _freshnessWindow;
    }

    // ─────────────────────────────────────────────────────────────────────
    // BET
    // Users deposit USDC and receive shares 1:1 on their chosen side.
    // Must call USDC.approve(marketAddress, amount) first.
    // ─────────────────────────────────────────────────────────────────────
    function bet(Side side, uint256 usdcAmount) external {
        // ── Checks ────────────────────────────────────────────────────────
        if (usdcAmount == 0)              revert ZeroAmount();
        if (block.timestamp >= expiryTime) revert BettingClosed();

        // Auto-update status to OPEN (sanity — factory sets this)
        if (status != Status.OPEN) revert MarketNotOpen();

        // ── Effects ───────────────────────────────────────────────────────
        // Shares are issued 1:1 with USDC deposited (6 dec both)
        if (side == Side.YES) {
            yesShares[msg.sender] += usdcAmount;
            totalYes              += usdcAmount;
        } else {
            noShares[msg.sender]  += usdcAmount;
            totalNo               += usdcAmount;
        }

        // ── Interactions ──────────────────────────────────────────────────
        // Pull USDC from bettor → this contract
        // Will revert if:
        //   - bettor has not approved this contract
        //   - bettor has insufficient USDC balance
        //   - bettor is blocklisted (Arc protocol enforces this)
        bool ok = usdc.transferFrom(msg.sender, address(this), usdcAmount);
        if (!ok) revert TransferFailed();

        emit BetPlaced(msg.sender, side, usdcAmount, usdcAmount);
    }

    // ─────────────────────────────────────────────────────────────────────
    // RESOLVE
    // Anyone can call this after resolutionTime.
    // Reads oracle price, compares to strikePrice, sets outcome.
    // ─────────────────────────────────────────────────────────────────────
    function resolve() external {
        // ── Checks ────────────────────────────────────────────────────────
        if (status == Status.RESOLVED)            revert MarketNotClosed();
        if (block.timestamp < resolutionTime)     revert ResolutionTooEarly();

        // Check oracle freshness — price must be recent
        bool fresh = oracle.isFresh(feedId, freshnessWindow);
        if (!fresh) revert OraclePriceStale();

        // Read oracle price
        (uint256 price,,) = oracle.getPrice(feedId);
        if (price == 0) revert OraclePriceZero();

        // ── Effects ───────────────────────────────────────────────────────
        settledPrice = price;
        status       = Status.RESOLVED;

        // Compare oracle price to strike price → determine outcome
        // If price strictly greater than strike → YES wins
        // Otherwise (equal or below) → NO wins
        outcome = price > strikePrice ? Outcome.YES : Outcome.NO;

        // Update status
        if (status != Status.RESOLVED) {
            status = Status.CLOSED;
        }

        emit MarketResolved(outcome, settledPrice);
    }

    // ─────────────────────────────────────────────────────────────────────
    // CLAIM
    // Winners call this after resolution to receive USDC.
    // Losers get nothing. Ties go to NO (price did not exceed strike).
    //
    // Payout formula:
    //   totalPool    = totalYes + totalNo
    //   fee          = totalPool * feeBps / 10_000
    //   netPool      = totalPool - fee
    //
    //   If YES wins:
    //     payout = userYesShares * netPool / totalYes
    //   If NO wins:
    //     payout = userNoShares  * netPool / totalNo
    // ─────────────────────────────────────────────────────────────────────
    function claim() external {
        // ── Checks ────────────────────────────────────────────────────────
        if (status  != Status.RESOLVED)  revert MarketNotResolved();
        if (claimed[msg.sender])         revert AlreadyClaimed();

        uint256 payout = _calculatePayout(msg.sender);
        if (payout == 0) revert NothingToClaim();

        // ── Effects (before interactions — reentrancy guard) ──────────────
        claimed[msg.sender] = true;

        // ── Interactions ──────────────────────────────────────────────────
        // Send fee to treasury on FIRST claim only
        // (we track feeCollected to avoid double-sending)
        uint256 totalPool = totalYes + totalNo;
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
    // VIEW: getInfo — returns full market state
    // ─────────────────────────────────────────────────────────────────────
    function getInfo() external view returns (MarketInfo memory) {
        return MarketInfo({
            question:       _question,
            feedId:         feedId,
            strikePrice:    strikePrice,
            expiryTime:     expiryTime,
            resolutionTime: resolutionTime,
            totalYes:       totalYes,
            totalNo:        totalNo,
            settledPrice:   settledPrice,
            feeBps:         feeBps,
            outcome:        outcome,
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
        returns (uint256 _yesShares, uint256 _noShares)
    {
        return (yesShares[user], noShares[user]);
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
    // INTERNAL: calculate payout for a user
    // ─────────────────────────────────────────────────────────────────────
    function _calculatePayout(address user) internal view returns (uint256) {
        uint256 totalPool = totalYes + totalNo;
        if (totalPool == 0) return 0;

        uint256 fee     = (totalPool * feeBps) / 10_000;
        uint256 netPool = totalPool - fee;

        if (outcome == Outcome.YES) {
            uint256 shares = yesShares[user];
            if (shares == 0 || totalYes == 0) return 0;
            // shares * netPool / totalYes
            return (shares * netPool) / totalYes;

        } else if (outcome == Outcome.NO) {
            uint256 shares = noShares[user];
            if (shares == 0 || totalNo == 0) return 0;
            return (shares * netPool) / totalNo;
        }

        return 0;
    }

    // ─────────────────────────────────────────────────────────────────────
    // INTERNAL: derive current status dynamically from timestamps
    // This ensures status reflects reality even if resolve() hasn't been called
    // ─────────────────────────────────────────────────────────────────────
    function _currentStatus() internal view returns (Status) {
        if (status == Status.RESOLVED)             return Status.RESOLVED;
        if (block.timestamp >= resolutionTime)     return Status.CLOSED;
        return Status.OPEN;
    }

    // ── Safety ────────────────────────────────────────────────────────────
    receive()  external payable { revert("BinaryMarket: no USDC accepted"); }
    fallback() external payable { revert("BinaryMarket: unknown function"); }
}
