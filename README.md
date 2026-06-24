# Arc Prediction Markets

Capital-efficient prediction markets for economic and financial outcomes,
built on **Arc Testnet** — Circle's L1 blockchain.

- **Oracle-resolved** — fully automatic, no human intervention
- **USDC-settled** — instant deterministic stablecoin payouts
- **Two market types** — Binary (YES/NO) and Scalar (price range)
- **Chain:** Arc Testnet (Chain ID: 5042002)
- **Gas token:** USDC (not ETH)
- **Explorer:** https://testnet.arcscan.app
- **Faucet:** https://faucet.circle.com

---

## Architecture

```
PriceOracle        ← you push prices here (simulates Chainlink on testnet)
     │
MarketFactory      ← creates and tracks all markets
     │
     ├── BinaryMarket  ← YES/NO markets (Will BTC > $100k?)
     └── ScalarMarket  ← Range markets  (What will ETH price be?)
```

---

## Contract System

| Contract | Purpose |
|---|---|
| `PriceOracle.sol` | Stores price feeds. Owner pushes prices. Markets read from here at resolution. |
| `MarketFactory.sol` | Deploys new markets. Tracks all markets. Holds oracle + fee config. |
| `BinaryMarket.sol` | YES/NO market. Users bet USDC. Oracle price vs strike = winner. |
| `ScalarMarket.sol` | Range market. LONG/SHORT positions. Payout = linear interpolation. |

---

## Market Lifecycle

```
OPEN → betting accepted
CLOSED → past expiry, no more bets
RESOLVED → oracle price read, outcome set
SETTLED → winners claimed USDC
```

---

## Project Structure

```
arc-prediction-markets/
├── contracts/
│   ├── interfaces/
│   │   ├── IUSDC.sol
│   │   ├── IPriceOracle.sol
│   │   ├── IBinaryMarket.sol
│   │   └── IScalarMarket.sol
│   ├── PriceOracle.sol
│   ├── MarketFactory.sol
│   ├── BinaryMarket.sol
│   └── ScalarMarket.sol
├── scripts/
│   ├── utils/
│   │   ├── provider.js
│   │   ├── gas.js
│   │   └── compiler.js
│   ├── deploy.js          ← deploy oracle + factory
│   ├── updateOracle.js    ← push prices to oracle
│   ├── createMarket.js    ← create binary or scalar market
│   ├── placeBet.js        ← place bet / take position
│   ├── resolveMarket.js   ← push price + resolve market
│   ├── claimWinnings.js   ← claim USDC after resolution
│   └── marketInfo.js      ← read full market state
├── abis/                  ← auto-generated after deploy
├── deployments/           ← auto-generated after deploy
├── .env.example
├── railway.json
└── package.json
```

---

## Local Setup

```bash
npm install
cp .env.example .env
# Edit .env — add your PRIVATE_KEY
```

Get testnet USDC for gas: https://faucet.circle.com → select Arc Testnet

---

## Full End-to-End Flow

### Step 1 — Deploy

```bash
node scripts/deploy.js
```

Output:
```
✅ PriceOracle   → 0xAAA...
✅ MarketFactory → 0xBBB...

Add to Railway Variables:
  ORACLE_ADDRESS=0xAAA...
  FACTORY_ADDRESS=0xBBB...
  SKIP_DEPLOY=true
```

---

### Step 2 — Push initial oracle prices

Price format: 8 decimals
- $105,000 BTC → `10500000000000`
- $3,200   ETH → `320000000000`
- $150     SOL → `15000000000`

```bash
# Single feed
node scripts/updateOracle.js single BTC_USD 10500000000000

# Multiple feeds in one tx (saves gas)
node scripts/updateOracle.js batch \
  BTC_USD:10500000000000 \
  ETH_USD:320000000000 \
  SOL_USD:15000000000

# Infinite loop — keeps oracle always fresh (use on Railway)
node scripts/updateOracle.js loop \
  BTC_USD:10500000000000 \
  ETH_USD:320000000000
```

---

### Step 3 — Create markets

**Binary market** — YES/NO outcome

```bash
node scripts/createMarket.js binary \
  "Will BTC exceed $100k by Aug 1 2026?" \
  BTC_USD \
  10000000000000 \
  1753920000 \
  1753920600
```

Arguments:
1. Question string
2. Feed name (`BTC_USD`, `ETH_USD`, `SOL_USD` etc.)
3. Strike price (8 decimals) — `$100,000 = 10000000000000`
4. Expiry timestamp — betting closes
5. Resolution timestamp — oracle is read (must be after expiry)

**Scalar market** — price range outcome

```bash
node scripts/createMarket.js scalar \
  "What will ETH price be on Aug 1 2026?" \
  ETH_USD \
  200000000000 \
  500000000000 \
  1753920000 \
  1753920600
```

Arguments:
1. Question string
2. Feed name
3. Floor price (8 dec) — `$2,000 = 200000000000`
4. Cap price (8 dec) — `$5,000 = 500000000000`
5. Expiry timestamp
6. Resolution timestamp

---

### Step 4 — Place bets

```bash
# Binary — bet YES (10 USDC)
node scripts/placeBet.js binary 0xMarketAddr YES 10

# Binary — bet NO (25.5 USDC)
node scripts/placeBet.js binary 0xMarketAddr NO 25.5

# Scalar — go LONG (50 USDC)
node scripts/placeBet.js scalar 0xMarketAddr LONG 50

# Scalar — go SHORT (100 USDC)
node scripts/placeBet.js scalar 0xMarketAddr SHORT 100
```

The script automatically:
- Checks your USDC balance
- Approves USDC spending (only if needed)
- Places the bet in one tx
- Shows your updated position

---

### Step 5 — Check market state anytime

```bash
# Market overview
node scripts/marketInfo.js 0xMarketAddr binary

# Market + your position
node scripts/marketInfo.js 0xMarketAddr binary 0xYourWallet
node scripts/marketInfo.js 0xMarketAddr scalar 0xYourWallet
```

---

### Step 6 — Resolve market

After `resolutionTime` passes, push the settlement price and resolve:

```bash
# BTC settled at $105,000 — strike was $100k → YES wins
node scripts/resolveMarket.js 0xMarketAddr binary 10500000000000

# ETH settled at $3,200 — floor $2k, cap $5k → LONG 40%, SHORT 60%
node scripts/resolveMarket.js 0xMarketAddr scalar 320000000000
```

The script:
1. Pushes the settlement price to oracle
2. Calls `resolve()` on the market
3. Prints the outcome and payout ratios

---

### Step 7 — Claim winnings

```bash
node scripts/claimWinnings.js 0xMarketAddr binary
node scripts/claimWinnings.js 0xMarketAddr scalar
```

The script:
- Confirms market is resolved
- Checks if you already claimed
- Shows your claimable amount
- Sends claim tx
- Shows your final USDC balance

---

## Deploy on Railway

### Step 1 — Push to GitHub

```bash
git init
git add .
git commit -m "feat: Arc prediction markets"
git remote add origin https://github.com/YOUR_USERNAME/arc-prediction-markets.git
git push -u origin main
```

### Step 2 — Create Railway project

Railway → New Project → Deploy from GitHub repo → select repo

### Step 3 — Set Variables in Railway

| Variable | Value |
|---|---|
| `PRIVATE_KEY` | your private key (never commit this) |
| `ARC_RPC_URL` | `https://rpc.testnet.arc.network` |
| `ARC_CHAIN_ID` | `5042002` |
| `USDC_ADDRESS` | `0x3600000000000000000000000000000000000000` |
| `PROTOCOL_FEE_BPS` | `200` (2%) |
| `ORACLE_FRESHNESS_SECONDS` | `3600` (1 hour) |
| `SKIP_DEPLOY` | `false` (set to `true` after first deploy) |

### Step 4 — Deploy

Click Deploy → watch logs → copy addresses → set:
```
ORACLE_ADDRESS=0x...
FACTORY_ADDRESS=0x...
SKIP_DEPLOY=true
```

### Step 5 — Keep oracle fresh on Railway

Create a second Railway service from the same repo, with start command:

```
node scripts/updateOracle.js loop BTC_USD:10500000000000 ETH_USD:320000000000
```

Set `LOOP_INTERVAL_SECONDS=300` (update every 5 minutes).

---

## Price Format Reference

| Asset | Human Price | 8-decimal raw |
|---|---|---|
| BTC | $105,000 | `10500000000000` |
| ETH | $3,200 | `320000000000` |
| SOL | $150 | `15000000000` |
| BNB | $600 | `60000000000` |
| ADA | $0.50 | `50000000` |
| DOGE | $0.15 | `15000000` |
| XRP | $2.50 | `250000000` |

---

## Payout Examples

### Binary Market

```
Question:    "Will BTC exceed $100k by Aug 1 2026?"
Strike:      $100,000
Settlement:  $105,000  → YES wins

Pool:        1000 USDC (600 YES, 400 NO)
Fee (2%):    20 USDC
Net pool:    980 USDC

YES holder with 60 shares:
  payout = 60 * 980 / 600 = 98 USDC
```

### Scalar Market

```
Question:    "What will ETH price be on Aug 1 2026?"
Floor:       $2,000
Cap:         $5,000
Settlement:  $3,500

longPayoutBps = (3500 - 2000) / (5000 - 2000) * 10000 = 5000 (50%)

Pool:        1000 USDC (500 LONG, 500 SHORT)
Fee (2%):    20 USDC
Net pool:    980 USDC

longNetPool  = 980 * 50% = 490 USDC
shortNetPool = 980 * 50% = 490 USDC

LONG holder with 100 shares out of 500 total LONG:
  payout = 100 * 490 / 500 = 98 USDC

SHORT holder with 100 shares out of 500 total SHORT:
  payout = 100 * 490 / 500 = 98 USDC
```

---

## Arc-Specific Rules

| Rule | Detail |
|---|---|
| Gas = USDC | Need USDC to pay gas. Get from faucet. |
| Min gas fee | `maxFeePerGas` ≥ 20 Gwei |
| USDC decimals | Native = 18 dec · ERC-20 = 6 dec · Same asset |
| No address(0) sends | Protocol reverts zero-address transfers |
| No PREVRANDAO | Always returns 0 — not used in this project |
| 1 confirmation = final | Sub-second deterministic finality |
| Block timestamps | Non-strictly increasing — markets use >= checks |
| Blocklist | USDC.transferFrom reverts if user is blocklisted |

---

## Official Arc Testnet Addresses

| Contract | Address |
|---|---|
| USDC | `0x3600000000000000000000000000000000000000` |
| EURC | `0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a` |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` |

Source: https://docs.arc.io/arc/references/contract-addresses

---

## Resources

- Arc Docs: https://docs.arc.io
- Testnet Explorer: https://testnet.arcscan.app
- Faucet: https://faucet.circle.com
- Gas Tracker: https://testnet.arcscan.app/gas-tracker
- EVM Differences: https://docs.arc.io/arc/references/evm-differences
