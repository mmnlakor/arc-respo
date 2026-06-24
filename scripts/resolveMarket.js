// scripts/resolveMarket.js
// ─────────────────────────────────────────────────────────────────────────────
// Two-step process:
//   Step 1 — Push current price to oracle
//   Step 2 — Call resolve() on the market contract
//
// Usage:
//   node scripts/resolveMarket.js <marketAddress> <marketType> <currentPrice>
//
//   marketType: binary | scalar
//   currentPrice: in 8 decimals — $65432.10 = 6543210000000
//
// Example:
//   node scripts/resolveMarket.js 0xABC... binary 10500000000000
//   (BTC settled at $105,000 — if strike was $100k → YES wins)
// ─────────────────────────────────────────────────────────────────────────────

import { ethers } from "ethers";
import { getProvider, getWallet, assertArcChain, loadDeployment, loadABI } from "./utils/provider.js";
import { getGasOverrides, logGasReport, formatPrice } from "./utils/gas.js";

async function main() {
  const [,, marketAddress, marketType, priceStr] = process.argv;

  if (!marketAddress || !marketType || !priceStr) {
    console.error(`\nUsage: node scripts/resolveMarket.js <marketAddress> <binary|scalar> <price8dec>`);
    console.error(`Example: node scripts/resolveMarket.js 0xABC... binary 10500000000000`);
    process.exit(1);
  }

  if (!["binary", "scalar"].includes(marketType)) {
    console.error(`marketType must be "binary" or "scalar"`);
    process.exit(1);
  }

  const price = BigInt(priceStr);

  const provider = getProvider();
  await assertArcChain(provider);
  const wallet = getWallet(provider);

  console.log(`\n${"─".repeat(60)}`);
  console.log(`🔮 Market Resolution`);
  console.log(`${"─".repeat(60)}`);
  console.log(`Market:  ${marketAddress}`);
  console.log(`Type:    ${marketType}`);
  console.log(`Price:   $${formatPrice(price)} (raw: ${price})`);
  console.log(`${"─".repeat(60)}`);

  // ── Load market contract ───────────────────────────────────────────────
  const contractName = marketType === "binary" ? "BinaryMarket" : "ScalarMarket";
  const marketABI    = loadABI(contractName);
  const market       = new ethers.Contract(marketAddress, marketABI, wallet);

  // ── Read market info to get the feedId ────────────────────────────────
  console.log(`\n📖 Reading market info...`);
  const info = await market.getInfo();

  console.log(`   Question:  ${info.question}`);
  console.log(`   Feed ID:   ${info.feedId}`);
  console.log(`   Status:    ${["OPEN","CLOSED","RESOLVED"][info.status]}`);

  if (info.status === 2n) {
    console.log(`\n⚠️  Market is already resolved.`);
    console.log(`   Settled price: $${formatPrice(info.settledPrice)}`);
    process.exit(0);
  }

  // ── Step 1: Push price to oracle ──────────────────────────────────────
  console.log(`\n${"─".repeat(40)}`);
  console.log(`Step 1/2 — Update Oracle Price`);
  console.log(`${"─".repeat(40)}`);

  const oracleDeployment = loadDeployment("PriceOracle");
  const oracleABI        = loadABI("PriceOracle");
  const oracle           = new ethers.Contract(oracleDeployment.address, oracleABI, wallet);

  const gas1 = await getGasOverrides(provider);
  console.log(`📡 Pushing price $${formatPrice(price)} to feed ${info.feedId.slice(0, 10)}...`);

  const tx1 = await oracle.updatePrice(info.feedId, price, gas1);
  console.log(`⏳ Tx: ${tx1.hash}`);
  const receipt1 = await tx1.wait(1);
  console.log(`✅ Oracle price updated. Block: ${receipt1.blockNumber}`);
  await logGasReport(provider, receipt1);

  // ── Step 2: Resolve the market ────────────────────────────────────────
  console.log(`\n${"─".repeat(40)}`);
  console.log(`Step 2/2 — Resolve Market`);
  console.log(`${"─".repeat(40)}`);

  const gas2 = await getGasOverrides(provider);
  console.log(`📡 Calling resolve()...`);

  const tx2 = await market.resolve(gas2);
  console.log(`⏳ Tx: ${tx2.hash}`);
  const receipt2 = await tx2.wait(1);

  console.log(`✅ Market resolved! Block: ${receipt2.blockNumber}`);
  await logGasReport(provider, receipt2);

  // ── Parse resolution event ────────────────────────────────────────────
  const iface = market.interface;
  for (const log of receipt2.logs) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed) {
        if (parsed.name === "MarketResolved") {
          if (marketType === "binary") {
            const outcomes = ["UNRESOLVED", "YES", "NO"];
            console.log(`\n🏆 Outcome: ${outcomes[Number(parsed.args.outcome)]}`);
            console.log(`   Settled Price: $${formatPrice(parsed.args.settledPrice)}`);
          } else {
            console.log(`\n📊 Settled Price:   $${formatPrice(parsed.args.settledPrice)}`);
            console.log(`   LONG Payout:    ${(Number(parsed.args.longPayoutBps) / 100).toFixed(2)}%`);
            console.log(`   SHORT Payout:   ${((10000 - Number(parsed.args.longPayoutBps)) / 100).toFixed(2)}%`);
          }
        }
      }
    } catch { /* skip */ }
  }

  console.log(`\n🔍 Market: https://testnet.arcscan.app/address/${marketAddress}`);
  console.log(`\n💡 Users can now call: node scripts/claimWinnings.js ${marketAddress} ${marketType}`);
}

main().catch((err) => {
  console.error(`\n💥 Failed: ${err.message}`);
  process.exit(1);
});
