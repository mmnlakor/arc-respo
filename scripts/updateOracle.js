// scripts/updateOracle.js
// ─────────────────────────────────────────────────────────────────────────────
// Pushes fresh prices to the PriceOracle contract.
// Run this regularly to keep oracle prices fresh (within ORACLE_FRESHNESS_SECONDS).
// Markets will refuse to resolve if oracle price is stale.
//
// Modes:
//
//   Single price update:
//     node scripts/updateOracle.js single BTC_USD 10500000000000
//
//   Batch update (multiple feeds in one tx — saves gas):
//     node scripts/updateOracle.js batch BTC_USD:10500000000000 ETH_USD:320000000000
//
//   Infinite loop (keeps oracle fresh automatically — good for Railway):
//     node scripts/updateOracle.js loop BTC_USD:10500000000000 ETH_USD:320000000000
//     LOOP_INTERVAL_SECONDS=300  ← update every 5 min (default)
//
// Price format: 8 decimals
//   $105,000.00 BTC → 10500000000000
//   $3,200.00   ETH → 320000000000
//   $150.00     SOL → 15000000000
//   $1.00       BNB → 100000000
//
// Pre-registered feeds (set in PriceOracle constructor):
//   BTC_USD, ETH_USD, SOL_USD, BNB_USD, USDT_USD
//   XRP_USD, ADA_USD, DOGE_USD, CPI_US, FED_RATE
// ─────────────────────────────────────────────────────────────────────────────

import { ethers } from "ethers";
import {
  getProvider,
  getWallet,
  assertArcChain,
  loadDeployment,
  loadABI,
} from "./utils/provider.js";
import {
  getGasOverrides,
  logGasReport,
  formatPrice,
} from "./utils/gas.js";

// ─────────────────────────────────────────────
// Parse "FEED_NAME:price" pairs from CLI args
// Returns array of { feedName, feedId, price }
// ─────────────────────────────────────────────
function parseFeedPairs(args) {
  return args.map((arg) => {
    const parts = arg.split(":");
    if (parts.length !== 2) {
      throw new Error(
        `Invalid feed pair "${arg}". Format: FEED_NAME:price8dec\n` +
        `Example: BTC_USD:10500000000000`
      );
    }
    const [feedName, priceStr] = parts;
    const price = BigInt(priceStr);
    if (price === 0n) throw new Error(`Price cannot be 0 for feed "${feedName}"`);

    return {
      feedName,
      feedId: ethers.keccak256(ethers.toUtf8Bytes(feedName)),
      price,
    };
  });
}

// ─────────────────────────────────────────────
// Load oracle contract from deployments/
// ─────────────────────────────────────────────
function loadOracle(wallet) {
  const deployment = loadDeployment("PriceOracle");
  const abi        = loadABI("PriceOracle");
  return {
    oracle: new ethers.Contract(deployment.address, abi, wallet),
    address: deployment.address,
  };
}

// ─────────────────────────────────────────────
// Single price update
// ─────────────────────────────────────────────
async function updateSingle(oracle, provider, feedName, price) {
  const feedId = ethers.keccak256(ethers.toUtf8Bytes(feedName));

  console.log(`\n📡 Updating ${feedName} → $${formatPrice(price)}`);
  console.log(`   Feed ID: ${feedId.slice(0, 10)}...`);
  console.log(`   Raw:     ${price}`);

  const gas = await getGasOverrides(provider);
  const tx  = await oracle.updatePrice(feedId, price, gas);

  console.log(`⏳ Tx: ${tx.hash}`);
  const receipt = await tx.wait(1);

  console.log(`✅ ${feedName} updated. Block: ${receipt.blockNumber}`);
  await logGasReport(provider, receipt);
}

// ─────────────────────────────────────────────
// Batch price update — all feeds in one tx
// Cheaper than sending N individual txns
// ─────────────────────────────────────────────
async function updateBatch(oracle, provider, feedPairs) {
  const feedIds = feedPairs.map((f) => f.feedId);
  const prices  = feedPairs.map((f) => f.price);

  console.log(`\n📦 Batch updating ${feedPairs.length} feeds:`);
  for (const f of feedPairs) {
    console.log(`   ${f.feedName.padEnd(12)} → $${formatPrice(f.price)}`);
  }

  const gas = await getGasOverrides(provider);
  const tx  = await oracle.updatePriceBatch(feedIds, prices, gas);

  console.log(`\n⏳ Tx: ${tx.hash}`);
  const receipt = await tx.wait(1);

  console.log(`✅ Batch updated. Block: ${receipt.blockNumber}`);
  await logGasReport(provider, receipt);

  return receipt;
}

// ─────────────────────────────────────────────
// Sleep helper
// ─────────────────────────────────────────────
function sleep(seconds) {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

// ─────────────────────────────────────────────
// Countdown display
// ─────────────────────────────────────────────
async function countdown(seconds) {
  for (let i = seconds; i > 0; i--) {
    process.stdout.write(`\r⏳ Next update in ${i}s...   `);
    await sleep(1);
  }
  process.stdout.write(`\r🔄 Updating now...           \n`);
}

// ─────────────────────────────────────────────
// Infinite loop mode
// Sends batch update on every interval
// Good for Railway — keeps oracle always fresh
// ─────────────────────────────────────────────
async function runLoop(oracle, provider, feedPairs) {
  const intervalSeconds = parseInt(process.env.LOOP_INTERVAL_SECONDS || "300");

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Oracle Price Feed — Infinite Update Loop`);
  console.log(`${"═".repeat(60)}`);
  console.log(`  Feeds:    ${feedPairs.map((f) => f.feedName).join(", ")}`);
  console.log(`  Interval: ${intervalSeconds}s`);
  console.log(`  Started:  ${new Date().toISOString()}`);
  console.log(`${"═".repeat(60)}`);

  let round      = 0;
  let successes  = 0;
  let failures   = 0;
  const start    = Date.now();

  while (true) {
    round++;
    console.log(`\n${"─".repeat(50)}`);
    console.log(`🔄 Update Round #${round} — ${new Date().toISOString()}`);
    console.log(`${"─".repeat(50)}`);

    try {
      await updateBatch(oracle, provider, feedPairs);
      successes++;
    } catch (err) {
      failures++;
      console.error(`❌ Round #${round} failed: ${err.message}`);
      // Don't exit — keep trying next round
    }

    const elapsed = Math.round((Date.now() - start) / 1000);
    const h       = Math.floor(elapsed / 3600);
    const m       = Math.floor((elapsed % 3600) / 60);
    const s       = elapsed % 60;

    console.log(`\n📊 Stats — Round #${round}`);
    console.log(`   Successes: ${successes}`);
    console.log(`   Failures:  ${failures}`);
    console.log(`   Uptime:    ${h}h ${m}m ${s}s`);

    await countdown(intervalSeconds);
  }
}

// ─────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────
async function main() {
  const [,, mode, ...rest] = process.argv;

  if (!mode || !["single", "batch", "loop"].includes(mode)) {
    console.error(`\nUsage:`);
    console.error(`  Single: node scripts/updateOracle.js single <FEED_NAME> <price8dec>`);
    console.error(`  Batch:  node scripts/updateOracle.js batch FEED:price FEED:price ...`);
    console.error(`  Loop:   node scripts/updateOracle.js loop  FEED:price FEED:price ...`);
    console.error(`\nExamples:`);
    console.error(`  node scripts/updateOracle.js single BTC_USD 10500000000000`);
    console.error(`  node scripts/updateOracle.js batch BTC_USD:10500000000000 ETH_USD:320000000000`);
    console.error(`  node scripts/updateOracle.js loop  BTC_USD:10500000000000 ETH_USD:320000000000`);
    console.error(`\nPrice format: 8 decimals`);
    console.error(`  $105,000 BTC → 10500000000000`);
    console.error(`  $3,200   ETH → 320000000000`);
    console.error(`  $150     SOL → 15000000000`);
    process.exit(1);
  }

  const provider = getProvider();
  await assertArcChain(provider);
  const wallet = getWallet(provider);

  console.log(`\n👤 Wallet:  ${wallet.address}`);
  const nativeBal = await provider.getBalance(wallet.address);
  console.log(`💰 USDC:    ${ethers.formatUnits(nativeBal, 18)} USDC`);

  const { oracle, address } = loadOracle(wallet);
  console.log(`🔮 Oracle:  ${address}`);

  if (mode === "single") {
    const [feedName, priceStr] = rest;
    if (!feedName || !priceStr) {
      console.error(`❌ Usage: node scripts/updateOracle.js single <FEED_NAME> <price8dec>`);
      process.exit(1);
    }
    await updateSingle(oracle, provider, feedName, BigInt(priceStr));

  } else if (mode === "batch") {
    if (rest.length === 0) {
      console.error(`❌ Provide at least one FEED:price pair.`);
      process.exit(1);
    }
    const feedPairs = parseFeedPairs(rest);
    await updateBatch(oracle, provider, feedPairs);

  } else if (mode === "loop") {
    if (rest.length === 0) {
      console.error(`❌ Provide at least one FEED:price pair for loop mode.`);
      process.exit(1);
    }
    const feedPairs = parseFeedPairs(rest);
    await runLoop(oracle, provider, feedPairs);
  }
}

main().catch((err) => {
  console.error(`\n💥 updateOracle failed: ${err.message}`);
  process.exit(1);
});
