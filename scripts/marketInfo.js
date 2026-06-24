// scripts/marketInfo.js
// ─────────────────────────────────────────────────────────────────────────────
// Reads and displays full state of any deployed market.
// No wallet or gas needed — pure read-only calls.
//
// Usage:
//   node scripts/marketInfo.js <marketAddress> <binary|scalar>
//   node scripts/marketInfo.js <marketAddress> <binary|scalar> <walletAddress>
//
// Examples:
//   node scripts/marketInfo.js 0xABC... binary
//   node scripts/marketInfo.js 0xABC... binary 0xYourWallet
//   node scripts/marketInfo.js 0xDEF... scalar 0xYourWallet
// ─────────────────────────────────────────────────────────────────────────────

import { ethers } from "ethers";
import {
  getProvider,
  assertArcChain,
  getWallet,
  loadABI,
} from "./utils/provider.js";
import {
  formatUSDC,
  formatPrice,
} from "./utils/gas.js";

async function main() {
  const [,, marketAddress, marketType, optionalWallet] = process.argv;

  // ── Validate args ──────────────────────────────────────────────────────
  if (!marketAddress || !ethers.isAddress(marketAddress)) {
    console.error(`\n❌ Invalid market address.`);
    console.error(`Usage: node scripts/marketInfo.js <address> <binary|scalar> [walletAddress]`);
    process.exit(1);
  }

  const type = (marketType || "").toLowerCase();
  if (!["binary", "scalar"].includes(type)) {
    console.error(`\n❌ Type must be "binary" or "scalar".`);
    process.exit(1);
  }

  // ── Connect (read-only, no private key needed) ─────────────────────────
  const provider = getProvider();
  await assertArcChain(provider);

  // Use a random wallet just for read calls — no signing required
  const contractName = type === "binary" ? "BinaryMarket" : "ScalarMarket";
  const abi          = loadABI(contractName);
  const market       = new ethers.Contract(
    ethers.getAddress(marketAddress),
    abi,
    provider  // provider only, not wallet — read-only
  );

  // ── Read market info ───────────────────────────────────────────────────
  const info       = await market.getInfo();
  const statusMap  = ["OPEN", "CLOSED", "RESOLVED"];
  const statusStr  = statusMap[Number(info.status)] ?? "UNKNOWN";
  const now        = Math.floor(Date.now() / 1000);

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Arc Prediction Market — ${type.toUpperCase()}`);
  console.log(`${"═".repeat(60)}`);
  console.log(`\n  Address:  ${marketAddress}`);
  console.log(`  Status:   ${statusStr}`);
  console.log(`  Question: ${info.question}`);
  console.log(`  Oracle:   ${info.oracle}`);
  console.log(`  Creator:  ${info.creator}`);
  console.log(`  Fee:      ${Number(info.feeBps) / 100}%`);

  // ── Type-specific fields ───────────────────────────────────────────────
  if (type === "binary") {
    const outcomes   = ["UNRESOLVED", "YES", "NO"];
    const outcomeStr = outcomes[Number(info.outcome)] ?? "UNKNOWN";
    const totalPool  = BigInt(info.totalYes) + BigInt(info.totalNo);
    const yesShare   = totalPool > 0n
      ? ((Number(info.totalYes) / Number(totalPool)) * 100).toFixed(1)
      : "0.0";
    const noShare    = totalPool > 0n
      ? ((Number(info.totalNo)  / Number(totalPool)) * 100).toFixed(1)
      : "0.0";

    console.log(`\n${"─".repeat(55)}`);
    console.log(`  Binary Market Details`);
    console.log(`${"─".repeat(55)}`);
    console.log(`  Strike Price:  $${formatPrice(info.strikePrice)}`);
    console.log(`  Outcome:       ${outcomeStr}`);
    if (Number(info.settledPrice) > 0) {
      console.log(`  Settled Price: $${formatPrice(info.settledPrice)}`);
    }
    console.log(`\n  Liquidity:`);
    console.log(`    Total Pool:  ${formatUSDC(totalPool)} USDC`);
    console.log(`    YES pool:    ${formatUSDC(info.totalYes)} USDC (${yesShare}%)`);
    console.log(`    NO pool:     ${formatUSDC(info.totalNo)} USDC (${noShare}%)`);

    // Implied probability = YES pool / total pool
    if (totalPool > 0n) {
      console.log(`\n  Implied Probability:`);
      console.log(`    YES: ${yesShare}%  |  NO: ${noShare}%`);
      console.log(`    (based on current liquidity distribution)`);
    }

  } else {
    const totalPool    = BigInt(info.totalLong) + BigInt(info.totalShort);
    const longShare    = totalPool > 0n
      ? ((Number(info.totalLong)  / Number(totalPool)) * 100).toFixed(1)
      : "0.0";
    const shortShare   = totalPool > 0n
      ? ((Number(info.totalShort) / Number(totalPool)) * 100).toFixed(1)
      : "0.0";

    console.log(`\n${"─".repeat(55)}`);
    console.log(`  Scalar Market Details`);
    console.log(`${"─".repeat(55)}`);
    console.log(`  Price Range:   $${formatPrice(info.floorPrice)} → $${formatPrice(info.capPrice)}`);
    if (Number(info.settledPrice) > 0) {
      console.log(`  Settled Price: $${formatPrice(info.settledPrice)}`);
      console.log(`  LONG payout:   ${(Number(info.longPayoutBps) / 100).toFixed(2)}%`);
      console.log(`  SHORT payout:  ${((10000 - Number(info.longPayoutBps)) / 100).toFixed(2)}%`);
    }
    console.log(`\n  Liquidity:`);
    console.log(`    Total Pool:   ${formatUSDC(totalPool)} USDC`);
    console.log(`    LONG pool:    ${formatUSDC(info.totalLong)} USDC (${longShare}%)`);
    console.log(`    SHORT pool:   ${formatUSDC(info.totalShort)} USDC (${shortShare}%)`);
  }

  // ── Timestamps ────────────────────────────────────────────────────────
  const expiryTime     = Number(info.expiryTime);
  const resolutionTime = Number(info.resolutionTime);
  const timeToExpiry   = expiryTime - now;
  const timeToResolve  = resolutionTime - now;

  console.log(`\n${"─".repeat(55)}`);
  console.log(`  Timeline`);
  console.log(`${"─".repeat(55)}`);
  console.log(`  Expiry:      ${new Date(expiryTime * 1000).toISOString()}`);
  console.log(`               ${timeToExpiry > 0 ? `(in ${formatDuration(timeToExpiry)})` : "PASSED"}`);
  console.log(`  Resolution:  ${new Date(resolutionTime * 1000).toISOString()}`);
  console.log(`               ${timeToResolve > 0 ? `(in ${formatDuration(timeToResolve)})` : "PASSED"}`);

  // ── Optional: show a specific wallet's position ────────────────────────
  const walletToCheck = optionalWallet || (
    process.env.PRIVATE_KEY
      ? new ethers.Wallet(process.env.PRIVATE_KEY).address
      : null
  );

  if (walletToCheck && ethers.isAddress(walletToCheck)) {
    console.log(`\n${"─".repeat(55)}`);
    console.log(`  Your Position (${walletToCheck.slice(0, 10)}...)`);
    console.log(`${"─".repeat(55)}`);

    const [shares1, shares2] = await market.getPosition(walletToCheck);
    const alreadyClaimed     = await market.hasClaimed(walletToCheck);
    const claimable          = await market.getClaimableAmount(walletToCheck);

    if (type === "binary") {
      console.log(`  YES shares:  ${formatUSDC(shares1)} USDC`);
      console.log(`  NO shares:   ${formatUSDC(shares2)} USDC`);
    } else {
      console.log(`  LONG shares:  ${formatUSDC(shares1)} USDC`);
      console.log(`  SHORT shares: ${formatUSDC(shares2)} USDC`);
    }

    console.log(`  Claimed:     ${alreadyClaimed ? "✅ Yes" : "❌ Not yet"}`);
    console.log(`  Claimable:   ${formatUSDC(claimable)} USDC`);

    if (claimable > 0n) {
      console.log(`\n  💡 Run: node scripts/claimWinnings.js ${marketAddress} ${type}`);
    }
  }

  // ── Explorer link ──────────────────────────────────────────────────────
  console.log(`\n${"─".repeat(55)}`);
  console.log(`  Explorer: https://testnet.arcscan.app/address/${marketAddress}`);
  console.log(`${"═".repeat(60)}\n`);
}

// Format seconds as "2h 15m 30s"
function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}h ${m}m ${s}s`;
}

main().catch((err) => {
  console.error(`\n💥 marketInfo failed: ${err.message}`);
  process.exit(1);
});
