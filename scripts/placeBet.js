// scripts/placeBet.js
// ─────────────────────────────────────────────────────────────────────────────
// Places a bet (binary) or takes a position (scalar) on a deployed market.
//
// What this script does step by step:
//   1. Loads the market contract + ABI from deployments/
//   2. Reads current market state — confirms it is OPEN and not expired
//   3. Checks your USDC ERC-20 balance (6 dec) is sufficient
//   4. Checks existing allowance — only calls approve() if needed (saves gas)
//   5. Calls bet() or takePosition() — pulls USDC from your wallet into market
//   6. Logs your updated position after the tx confirms
//
// Arc-specific:
//   - USDC ERC-20 decimals = 6. Amount arg is in HUMAN units (e.g. "10" = 10 USDC)
//   - Gas is paid in native USDC (18 dec) — handled automatically by wallet
//   - 1 confirmation = final on Arc (deterministic finality)
//   - approve() target is the market contract address, NOT the factory
//
// Usage — Binary market (YES or NO):
//   node scripts/placeBet.js binary <marketAddress> <YES|NO> <usdcAmount>
//
//   Examples:
//     node scripts/placeBet.js binary 0xABC... YES 10
//     node scripts/placeBet.js binary 0xABC... NO  25.5
//
// Usage — Scalar market (LONG or SHORT):
//   node scripts/placeBet.js scalar <marketAddress> <LONG|SHORT> <usdcAmount>
//
//   Examples:
//     node scripts/placeBet.js scalar 0xDEF... LONG  50
//     node scripts/placeBet.js scalar 0xDEF... SHORT 100
// ─────────────────────────────────────────────────────────────────────────────

import { ethers } from "ethers";
import {
  getProvider,
  getWallet,
  assertArcChain,
  getUSDC,
  loadABI,
} from "./utils/provider.js";
import {
  getGasOverrides,
  logGasReport,
  parseUSDC,
  formatUSDC,
  formatPrice,
} from "./utils/gas.js";

// ─────────────────────────────────────────────────────────────────────────────
// Step 0: Parse and validate CLI arguments
// ─────────────────────────────────────────────────────────────────────────────
function parseArgs() {
  const [,, marketType, marketAddress, sideStr, amountStr] = process.argv;

  const validTypes = ["binary", "scalar"];
  const validSides = {
    binary: ["YES", "NO"],
    scalar: ["LONG", "SHORT"],
  };

  if (!marketType || !validTypes.includes(marketType.toLowerCase())) {
    printUsageAndExit();
  }

  const type = marketType.toLowerCase();

  if (!marketAddress || !ethers.isAddress(marketAddress)) {
    console.error(`\n❌ Invalid market address: ${marketAddress}`);
    printUsageAndExit();
  }

  if (!sideStr || !validSides[type].includes(sideStr.toUpperCase())) {
    console.error(`\n❌ Invalid side "${sideStr}". For ${type}: ${validSides[type].join(" or ")}`);
    printUsageAndExit();
  }

  const amount = parseFloat(amountStr);
  if (isNaN(amount) || amount <= 0) {
    console.error(`\n❌ Invalid amount "${amountStr}". Must be a positive number (e.g. 10 or 25.5)`);
    printUsageAndExit();
  }

  return {
    type,
    marketAddress: ethers.getAddress(marketAddress), // checksum
    side: sideStr.toUpperCase(),
    amount,                    // human USDC amount e.g. 10.5
    amountRaw: parseUSDC(amount), // 6-decimal BigInt e.g. 10_500_000n
  };
}

function printUsageAndExit() {
  console.error(`\nUsage:`);
  console.error(`  node scripts/placeBet.js binary <marketAddress> <YES|NO>   <usdcAmount>`);
  console.error(`  node scripts/placeBet.js scalar <marketAddress> <LONG|SHORT> <usdcAmount>`);
  console.error(`\nExamples:`);
  console.error(`  node scripts/placeBet.js binary 0xABC... YES  10`);
  console.error(`  node scripts/placeBet.js binary 0xABC... NO   25.5`);
  console.error(`  node scripts/placeBet.js scalar 0xDEF... LONG 50`);
  console.error(`  node scripts/placeBet.js scalar 0xDEF... SHORT 100`);
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 1: Load the market contract
// ─────────────────────────────────────────────────────────────────────────────
function loadMarketContract(type, marketAddress, wallet) {
  // BinaryMarket and ScalarMarket ABIs are saved to abis/ during deploy
  const contractName = type === "binary" ? "BinaryMarket" : "ScalarMarket";
  const abi = loadABI(contractName);
  return new ethers.Contract(marketAddress, abi, wallet);
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 2: Read and validate market state
// Returns the market info struct
// ─────────────────────────────────────────────────────────────────────────────
async function validateMarketState(market, type) {
  console.log(`\n📖 Reading market state...`);
  const info = await market.getInfo();

  const statusMap  = ["OPEN", "CLOSED", "RESOLVED"];
  const statusStr  = statusMap[Number(info.status)] ?? "UNKNOWN";
  const now        = Math.floor(Date.now() / 1000);
  const timeToExpiry = Number(info.expiryTime) - now;

  console.log(`\n${"─".repeat(55)}`);
  console.log(`Market Info`);
  console.log(`${"─".repeat(55)}`);
  console.log(`  Question:    ${info.question}`);

  if (type === "binary") {
    console.log(`  Strike:      $${formatPrice(info.strikePrice)}`);
    console.log(`  Total YES:   ${formatUSDC(info.totalYes)} USDC`);
    console.log(`  Total NO:    ${formatUSDC(info.totalNo)} USDC`);
  } else {
    console.log(`  Floor:       $${formatPrice(info.floorPrice)}`);
    console.log(`  Cap:         $${formatPrice(info.capPrice)}`);
    console.log(`  Total LONG:  ${formatUSDC(info.totalLong)} USDC`);
    console.log(`  Total SHORT: ${formatUSDC(info.totalShort)} USDC`);
  }

  console.log(`  Status:      ${statusStr}`);
  console.log(`  Expiry:      ${new Date(Number(info.expiryTime) * 1000).toISOString()}`);

  if (timeToExpiry > 0) {
    const h = Math.floor(timeToExpiry / 3600);
    const m = Math.floor((timeToExpiry % 3600) / 60);
    const s = timeToExpiry % 60;
    console.log(`  Time left:   ${h}h ${m}m ${s}s`);
  } else {
    console.log(`  Time left:   EXPIRED`);
  }

  console.log(`${"─".repeat(55)}`);

  // ── Guard: market must be OPEN ──────────────────────────────────────────
  if (Number(info.status) !== 0) {
    console.error(`\n❌ Market is ${statusStr}. Betting is only allowed when OPEN.`);
    process.exit(1);
  }

  // ── Guard: expiry must be in the future ─────────────────────────────────
  // Arc: block.timestamp is non-strictly increasing so we use Date.now()
  // as a pre-flight check — the contract enforces the hard check on-chain.
  if (timeToExpiry <= 0) {
    console.error(`\n❌ Market has expired. No more bets accepted.`);
    process.exit(1);
  }

  return info;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 3: Check USDC balance
// ─────────────────────────────────────────────────────────────────────────────
async function checkUSDCBalance(wallet, provider, amountRaw, amountHuman) {
  console.log(`\n💰 Checking USDC balance...`);

  const usdc    = getUSDC(provider);
  const balance = await usdc.balanceOf(wallet.address);

  console.log(`   Wallet:   ${wallet.address}`);
  console.log(`   Balance:  ${formatUSDC(balance)} USDC`);
  console.log(`   Needed:   ${amountHuman} USDC`);

  if (balance < amountRaw) {
    const shortfall = amountRaw - balance;
    console.error(`\n❌ Insufficient USDC balance.`);
    console.error(`   You have:  ${formatUSDC(balance)} USDC`);
    console.error(`   You need:  ${amountHuman} USDC`);
    console.error(`   Shortfall: ${formatUSDC(shortfall)} USDC`);
    console.error(`   Faucet:    https://faucet.circle.com/`);
    process.exit(1);
  }

  console.log(`   ✅ Balance sufficient.`);
  return usdc;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 4: Approve USDC spending
// Only sends approve() tx if existing allowance is insufficient.
// This avoids wasting gas (USDC) on redundant approvals.
// ─────────────────────────────────────────────────────────────────────────────
async function ensureApproval(usdc, wallet, provider, marketAddress, amountRaw) {
  console.log(`\n🔑 Checking USDC allowance...`);

  const allowance = await usdc.allowance(wallet.address, marketAddress);
  console.log(`   Current allowance: ${formatUSDC(allowance)} USDC`);
  console.log(`   Required:          ${formatUSDC(amountRaw)} USDC`);

  if (allowance >= amountRaw) {
    console.log(`   ✅ Allowance sufficient — skipping approve() tx.`);
    return;
  }

  // Approve exact amount needed (not unlimited — better security practice)
  // You can change this to ethers.MaxUint256 if you want a one-time unlimited approval
  const approveAmount = amountRaw;

  console.log(`\n📡 Sending approve() transaction...`);
  console.log(`   Approving ${formatUSDC(approveAmount)} USDC for market ${marketAddress}`);

  const gas    = await getGasOverrides(provider);
  const approveTx = await usdc.approve(marketAddress, approveAmount, gas);

  console.log(`⏳ Approve tx: ${approveTx.hash}`);
  const approveReceipt = await approveTx.wait(1); // Arc: 1 conf = final

  console.log(`✅ Approval confirmed. Block: ${approveReceipt.blockNumber}`);
  await logGasReport(provider, approveReceipt);
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 5: Place the bet
// Calls bet() for binary markets, takePosition() for scalar markets.
//
// Side encoding:
//   Binary:  YES = 0, NO = 1   (IBinaryMarket.Side enum)
//   Scalar:  LONG = 0, SHORT = 1 (IScalarMarket.Side enum)
// ─────────────────────────────────────────────────────────────────────────────
async function placeBet(market, provider, type, side, amountRaw, amountHuman) {
  // Encode the side as a uint (0 or 1) matching the Solidity enum
  const sideIndex = (type === "binary")
    ? (side === "YES" ? 0 : 1)
    : (side === "LONG" ? 0 : 1);

  const methodName = type === "binary" ? "bet" : "takePosition";
  const sideLabel  = side;

  console.log(`\n${"─".repeat(55)}`);
  console.log(`Placing ${type === "binary" ? "Bet" : "Position"}`);
  console.log(`${"─".repeat(55)}`);
  console.log(`  Method:  ${methodName}(${sideIndex} [${sideLabel}], ${amountRaw})`);
  console.log(`  Side:    ${sideLabel}`);
  console.log(`  Amount:  ${amountHuman} USDC (raw: ${amountRaw})`);
  console.log(`${"─".repeat(55)}`);

  const gas = await getGasOverrides(provider);
  console.log(`\n📡 Sending ${methodName}() transaction...`);

  const tx = await market[methodName](sideIndex, amountRaw, gas);

  console.log(`⏳ Tx hash: ${tx.hash}`);
  console.log(`   Waiting for confirmation (Arc = sub-second finality)...`);

  const receipt = await tx.wait(1);

  console.log(`\n✅ ${type === "binary" ? "Bet" : "Position"} confirmed!`);
  console.log(`   Block:    ${receipt.blockNumber}`);
  console.log(`   Explorer: https://testnet.arcscan.app/tx/${receipt.hash}`);

  await logGasReport(provider, receipt);

  // ── Parse emitted event ───────────────────────────────────────────────
  const iface     = market.interface;
  const eventName = type === "binary" ? "BetPlaced" : "PositionTaken";

  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed && parsed.name === eventName) {
        console.log(`\n📋 Event: ${eventName}`);
        console.log(`   User:   ${parsed.args.user}`);
        console.log(`   Side:   ${sideLabel} (${parsed.args.side})`);
        console.log(`   Amount: ${formatUSDC(parsed.args.amount)} USDC`);
        console.log(`   Shares: ${formatUSDC(parsed.args.shares)} shares`);
      }
    } catch { /* skip unknown events */ }
  }

  return receipt;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 6: Read back your updated position after the bet
// ─────────────────────────────────────────────────────────────────────────────
async function readPositionAfterBet(market, walletAddress, type) {
  console.log(`\n📊 Your updated position on this market:`);

  const [shares1, shares2] = await market.getPosition(walletAddress);

  if (type === "binary") {
    console.log(`   YES shares: ${formatUSDC(shares1)} (worth ${formatUSDC(shares1)} USDC if YES wins)`);
    console.log(`   NO shares:  ${formatUSDC(shares2)} (worth ${formatUSDC(shares2)} USDC if NO wins)`);
  } else {
    console.log(`   LONG shares:  ${formatUSDC(shares1)}`);
    console.log(`   SHORT shares: ${formatUSDC(shares2)}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main — orchestrates all 6 steps in order
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Arc Prediction Markets — Place Bet`);
  console.log(`${"═".repeat(60)}`);

  // Step 0: Parse args
  const { type, marketAddress, side, amount, amountRaw } = parseArgs();

  console.log(`\n  Market type: ${type}`);
  console.log(`  Address:     ${marketAddress}`);
  console.log(`  Side:        ${side}`);
  console.log(`  Amount:      ${amount} USDC`);

  // Connect
  const provider = getProvider();
  await assertArcChain(provider);
  const wallet = getWallet(provider);
  console.log(`  Wallet:      ${wallet.address}`);

  // Step 1: Load market
  const market = loadMarketContract(type, marketAddress, wallet);

  // Step 2: Validate market state
  await validateMarketState(market, type);

  // Step 3: Check USDC balance
  const usdc = await checkUSDCBalance(wallet, provider, amountRaw, amount);

  // Connect USDC with wallet signer for approve/transfer
  const usdcSigned = usdc.connect(wallet);

  // Step 4: Ensure USDC approval
  await ensureApproval(usdcSigned, wallet, provider, marketAddress, amountRaw);

  // Step 5: Place bet
  await placeBet(market, provider, type, side, amountRaw, amount);

  // Step 6: Read updated position
  await readPositionAfterBet(market, wallet.address, type);

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Done. Your USDC is now locked in the market.`);
  console.log(`  To claim winnings after resolution:`);
  console.log(`  node scripts/claimWinnings.js ${marketAddress} ${type}`);
  console.log(`${"═".repeat(60)}\n`);
}

main().catch((err) => {
  console.error(`\n💥 placeBet failed: ${err.message}`);
  if (err.data) console.error(`   Revert data: ${err.data}`);
  process.exit(1);
});
