// scripts/claimWinnings.js
// ─────────────────────────────────────────────────────────────────────────────
// Claims USDC winnings from a resolved prediction market.
//
// What this script does step by step:
//   1. Loads the market contract from the given address
//   2. Reads market status — confirms it is RESOLVED
//   3. Checks if your wallet already claimed — exits early if so
//   4. Reads your claimable amount — exits if zero (you lost or had no position)
//   5. Calls claim() — contract transfers your USDC winnings to your wallet
//   6. Logs your final balance after claim
//
// Arc-specific:
//   - claim() on BinaryMarket: full pool * your share / winning side total
//   - claim() on ScalarMarket: split pool based on longPayoutBps ratio
//   - Protocol fee (2%) is deducted from the pool before payout
//   - USDC transfer: 6 decimals ERC-20 (contract handles this internally)
//   - No approval needed — contract SENDS to you, not pulls from you
//
// Usage:
//   node scripts/claimWinnings.js <marketAddress> <binary|scalar>
//
// Examples:
//   node scripts/claimWinnings.js 0xABC... binary
//   node scripts/claimWinnings.js 0xDEF... scalar
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
  formatUSDC,
  formatPrice,
} from "./utils/gas.js";

// ─────────────────────────────────────────────────────────────────────────────
// Step 0: Parse CLI arguments
// ─────────────────────────────────────────────────────────────────────────────
function parseArgs() {
  const [,, marketAddress, marketType] = process.argv;

  if (!marketAddress || !ethers.isAddress(marketAddress)) {
    console.error(`\n❌ Invalid market address: ${marketAddress}`);
    printUsageAndExit();
  }

  const type = (marketType || "").toLowerCase();
  if (!["binary", "scalar"].includes(type)) {
    console.error(`\n❌ Invalid market type. Must be "binary" or "scalar".`);
    printUsageAndExit();
  }

  return {
    marketAddress: ethers.getAddress(marketAddress),
    type,
  };
}

function printUsageAndExit() {
  console.error(`\nUsage: node scripts/claimWinnings.js <marketAddress> <binary|scalar>`);
  console.error(`Examples:`);
  console.error(`  node scripts/claimWinnings.js 0xABC... binary`);
  console.error(`  node scripts/claimWinnings.js 0xDEF... scalar`);
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 1: Load market contract
// ─────────────────────────────────────────────────────────────────────────────
function loadMarketContract(type, marketAddress, wallet) {
  const contractName = type === "binary" ? "BinaryMarket" : "ScalarMarket";
  const abi          = loadABI(contractName);
  return new ethers.Contract(marketAddress, abi, wallet);
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 2: Read and validate market status
// ─────────────────────────────────────────────────────────────────────────────
async function validateResolved(market, type) {
  console.log(`\n📖 Reading market state...`);
  const info      = await market.getInfo();
  const statusMap = ["OPEN", "CLOSED", "RESOLVED"];
  const statusStr = statusMap[Number(info.status)] ?? "UNKNOWN";

  console.log(`\n${"─".repeat(55)}`);
  console.log(`Market State`);
  console.log(`${"─".repeat(55)}`);
  console.log(`  Question:  ${info.question}`);
  console.log(`  Status:    ${statusStr}`);

  if (type === "binary") {
    const outcomes = ["UNRESOLVED", "YES", "NO"];
    console.log(`  Outcome:   ${outcomes[Number(info.outcome)] ?? "UNKNOWN"}`);
    console.log(`  Settled:   $${formatPrice(info.settledPrice)}`);
    console.log(`  Strike:    $${formatPrice(info.strikePrice)}`);
    console.log(`  Total YES: ${formatUSDC(info.totalYes)} USDC`);
    console.log(`  Total NO:  ${formatUSDC(info.totalNo)} USDC`);
    const totalPool = BigInt(info.totalYes) + BigInt(info.totalNo);
    console.log(`  Pool:      ${formatUSDC(totalPool)} USDC`);
  } else {
    console.log(`  Settled:      $${formatPrice(info.settledPrice)}`);
    console.log(`  Floor:        $${formatPrice(info.floorPrice)}`);
    console.log(`  Cap:          $${formatPrice(info.capPrice)}`);
    console.log(`  LONG payout:  ${(Number(info.longPayoutBps) / 100).toFixed(2)}%`);
    console.log(`  SHORT payout: ${((10000 - Number(info.longPayoutBps)) / 100).toFixed(2)}%`);
    const totalPool = BigInt(info.totalLong) + BigInt(info.totalShort);
    console.log(`  Total LONG:   ${formatUSDC(info.totalLong)} USDC`);
    console.log(`  Total SHORT:  ${formatUSDC(info.totalShort)} USDC`);
    console.log(`  Pool:         ${formatUSDC(totalPool)} USDC`);
  }

  console.log(`  Fee:       ${Number(info.feeBps) / 100}%`);
  console.log(`${"─".repeat(55)}`);

  if (Number(info.status) !== 2) {
    console.error(`\n❌ Market is ${statusStr}. Claims are only available after RESOLVED.`);
    if (Number(info.status) === 0) {
      console.error(`   Market is still OPEN. Wait for expiry + resolution.`);
      console.error(`   Run: node scripts/resolveMarket.js ${market.target} ${type} <price>`);
    } else if (Number(info.status) === 1) {
      console.error(`   Market is CLOSED but not yet resolved.`);
      console.error(`   Push a fresh oracle price then call resolve().`);
    }
    process.exit(1);
  }

  return info;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 3: Check if already claimed
// ─────────────────────────────────────────────────────────────────────────────
async function checkAlreadyClaimed(market, walletAddress) {
  console.log(`\n🔍 Checking claim status for ${walletAddress}...`);
  const already = await market.hasClaimed(walletAddress);

  if (already) {
    console.log(`\n⚠️  You have already claimed your winnings from this market.`);
    console.log(`   Wallet:  ${walletAddress}`);
    console.log(`   Nothing left to claim.`);
    process.exit(0);
  }

  console.log(`   ✅ Not yet claimed.`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 4: Check claimable amount
// ─────────────────────────────────────────────────────────────────────────────
async function checkClaimableAmount(market, walletAddress, type) {
  console.log(`\n💵 Reading your position and claimable amount...`);

  const [shares1, shares2] = await market.getPosition(walletAddress);
  const claimable          = await market.getClaimableAmount(walletAddress);

  if (type === "binary") {
    console.log(`   YES shares: ${formatUSDC(shares1)} USDC`);
    console.log(`   NO shares:  ${formatUSDC(shares2)} USDC`);
  } else {
    console.log(`   LONG shares:  ${formatUSDC(shares1)} USDC`);
    console.log(`   SHORT shares: ${formatUSDC(shares2)} USDC`);
  }

  console.log(`\n   Claimable:  ${formatUSDC(claimable)} USDC`);

  if (claimable === 0n) {
    const totalShares = shares1 + shares2;
    if (totalShares === 0n) {
      console.log(`\n⚠️  You have no position on this market.`);
      console.log(`   Your wallet never placed a bet here.`);
    } else {
      console.log(`\n⚠️  You have shares but nothing to claim.`);
      console.log(`   This means your side lost the market.`);
      console.log(`   Losers receive 0 USDC — all funds go to winners.`);
    }
    process.exit(0);
  }

  console.log(`\n   ✅ You are owed ${formatUSDC(claimable)} USDC.`);
  return claimable;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 5: Execute claim()
// No approval needed — contract SENDS USDC to you, doesn't pull from you.
// ─────────────────────────────────────────────────────────────────────────────
async function executeClaim(market, provider, marketAddress, type) {
  console.log(`\n${"─".repeat(55)}`);
  console.log(`Executing claim()`);
  console.log(`${"─".repeat(55)}`);

  const gas = await getGasOverrides(provider);
  console.log(`⛽ maxFeePerGas: ${ethers.formatUnits(gas.maxFeePerGas, "gwei")} Gwei`);

  console.log(`\n📡 Sending claim() transaction...`);
  const tx = await market.claim(gas);

  console.log(`⏳ Tx hash: ${tx.hash}`);
  console.log(`   Waiting for confirmation...`);

  const receipt = await tx.wait(1); // Arc: 1 conf = final

  console.log(`\n✅ Claim confirmed! Block: ${receipt.blockNumber}`);
  console.log(`   Tx: https://testnet.arcscan.app/tx/${receipt.hash}`);

  await logGasReport(provider, receipt);

  // ── Parse WinningsClaimed event ────────────────────────────────────────
  const iface = market.interface;
  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed && parsed.name === "WinningsClaimed") {
        console.log(`\n🏆 WinningsClaimed Event:`);
        console.log(`   User:   ${parsed.args.user}`);
        console.log(`   Amount: ${formatUSDC(parsed.args.amount)} USDC`);
      }
      if (parsed && parsed.name === "FeeCollected") {
        console.log(`\n💸 FeeCollected Event:`);
        console.log(`   Treasury: ${parsed.args.treasury}`);
        console.log(`   Fee:      ${formatUSDC(parsed.args.amount)} USDC`);
      }
    } catch { /* skip unknown events */ }
  }

  return receipt;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 6: Read final USDC balance after claim
// ─────────────────────────────────────────────────────────────────────────────
async function readFinalBalance(provider, walletAddress) {
  console.log(`\n💰 Your USDC balance after claim:`);

  const usdc       = getUSDC(provider);
  const erc20Bal   = await usdc.balanceOf(walletAddress);
  const nativeBal  = await provider.getBalance(walletAddress);

  console.log(`   ERC-20 USDC (6 dec):  ${formatUSDC(erc20Bal)} USDC`);
  console.log(`   Native USDC (18 dec): ${ethers.formatUnits(nativeBal, 18)} USDC`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Arc Prediction Markets — Claim Winnings`);
  console.log(`${"═".repeat(60)}`);

  // Step 0: Parse args
  const { marketAddress, type } = parseArgs();

  console.log(`\n  Market:  ${marketAddress}`);
  console.log(`  Type:    ${type}`);

  // Connect
  const provider = getProvider();
  await assertArcChain(provider);
  const wallet = getWallet(provider);
  console.log(`  Wallet:  ${wallet.address}`);

  // Step 1: Load contract
  const market = loadMarketContract(type, marketAddress, wallet);

  // Step 2: Validate market is RESOLVED
  await validateResolved(market, type);

  // Step 3: Check if already claimed
  await checkAlreadyClaimed(market, wallet.address);

  // Step 4: Check claimable amount
  await checkClaimableAmount(market, wallet.address, type);

  // Step 5: Execute claim
  await executeClaim(market, provider, marketAddress, type);

  // Step 6: Final balance
  await readFinalBalance(provider, wallet.address);

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Claim complete. USDC is in your wallet.`);
  console.log(`${"═".repeat(60)}\n`);
}

main().catch((err) => {
  console.error(`\n💥 claimWinnings failed: ${err.message}`);
  if (err.data) console.error(`   Revert data: ${err.data}`);
  process.exit(1);
});
