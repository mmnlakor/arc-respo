// scripts/createMarket.js
// ─────────────────────────────────────────────────────────────────────────────
// Create a new prediction market via the deployed MarketFactory.
//
// Binary market example:
//   node scripts/createMarket.js binary \
//     "Will BTC exceed $100k by Aug 1 2026?" \
//     BTC_USD \
//     10000000000000 \
//     1753920000 \
//     1753920600
//
// Scalar market example:
//   node scripts/createMarket.js scalar \
//     "What will ETH price be on Aug 1 2026?" \
//     ETH_USD \
//     200000000000 \
//     500000000000 \
//     1753920000 \
//     1753920600
//
// Price format: 8 decimals
//   $100,000 BTC → 10_000_000_000_000 (13 digits)
//   $65,432.10   → 6_543_210_000_000  (13 digits)
//   $2,000 ETH   → 200_000_000_000    (12 digits)
//
// Timestamps: Unix epoch seconds
//   Use: date -d "2026-08-01" +%s
// ─────────────────────────────────────────────────────────────────────────────

import { ethers }  from "ethers";
import { getProvider, getWallet, assertArcChain, loadDeployment, loadABI } from "./utils/provider.js";
import { getGasOverrides, logGasReport, formatPrice } from "./utils/gas.js";

async function createBinaryMarket(factory, wallet, provider, args) {
  const [question, feedName, strikePriceStr, expiryStr, resolutionStr] = args;

  const feedId         = ethers.keccak256(ethers.toUtf8Bytes(feedName));
  const strikePrice    = BigInt(strikePriceStr);
  const expiryTime     = parseInt(expiryStr);
  const resolutionTime = parseInt(resolutionStr);

  console.log(`\n📋 Binary Market Parameters:`);
  console.log(`   Question:        ${question}`);
  console.log(`   Feed:            ${feedName} (${feedId.slice(0, 10)}...)`);
  console.log(`   Strike Price:    $${formatPrice(strikePrice)}`);
  console.log(`   Expiry:          ${new Date(expiryTime * 1000).toISOString()}`);
  console.log(`   Resolution:      ${new Date(resolutionTime * 1000).toISOString()}`);

  const gas = await getGasOverrides(provider);
  console.log(`\n📡 Sending createBinaryMarket tx...`);

  const tx = await factory.createBinaryMarket(
    feedId,
    question,
    strikePrice,
    expiryTime,
    resolutionTime,
    gas
  );

  console.log(`⏳ Tx: ${tx.hash}`);
  const receipt = await tx.wait(1);

  // Parse the BinaryMarketCreated event to get the new market address
  const iface       = factory.interface;
  let   marketAddr  = null;

  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed && parsed.name === "BinaryMarketCreated") {
        marketAddr = parsed.args.market;
        break;
      }
    } catch { /* skip */ }
  }

  console.log(`\n✅ Binary Market Created!`);
  console.log(`   Address:  ${marketAddr}`);
  console.log(`   Block:    ${receipt.blockNumber}`);
  console.log(`   Explorer: https://testnet.arcscan.app/address/${marketAddr}`);
  await logGasReport(provider, receipt);

  return marketAddr;
}

async function createScalarMarket(factory, wallet, provider, args) {
  const [question, feedName, floorStr, capStr, expiryStr, resolutionStr] = args;

  const feedId         = ethers.keccak256(ethers.toUtf8Bytes(feedName));
  const floorPrice     = BigInt(floorStr);
  const capPrice       = BigInt(capStr);
  const expiryTime     = parseInt(expiryStr);
  const resolutionTime = parseInt(resolutionStr);

  console.log(`\n📋 Scalar Market Parameters:`);
  console.log(`   Question:    ${question}`);
  console.log(`   Feed:        ${feedName} (${feedId.slice(0, 10)}...)`);
  console.log(`   Floor:       $${formatPrice(floorPrice)}`);
  console.log(`   Cap:         $${formatPrice(capPrice)}`);
  console.log(`   Expiry:      ${new Date(expiryTime * 1000).toISOString()}`);
  console.log(`   Resolution:  ${new Date(resolutionTime * 1000).toISOString()}`);

  const gas = await getGasOverrides(provider);
  console.log(`\n📡 Sending createScalarMarket tx...`);

  const tx = await factory.createScalarMarket(
    feedId,
    question,
    floorPrice,
    capPrice,
    expiryTime,
    resolutionTime,
    gas
  );

  console.log(`⏳ Tx: ${tx.hash}`);
  const receipt = await tx.wait(1);

  let marketAddr = null;
  for (const log of receipt.logs) {
    try {
      const parsed = factory.interface.parseLog(log);
      if (parsed && parsed.name === "ScalarMarketCreated") {
        marketAddr = parsed.args.market;
        break;
      }
    } catch { /* skip */ }
  }

  console.log(`\n✅ Scalar Market Created!`);
  console.log(`   Address:  ${marketAddr}`);
  console.log(`   Block:    ${receipt.blockNumber}`);
  console.log(`   Explorer: https://testnet.arcscan.app/address/${marketAddr}`);
  await logGasReport(provider, receipt);

  return marketAddr;
}

// ─────────────────────────────────────────────
// Entry
// ─────────────────────────────────────────────
async function main() {
  const [,, type, ...args] = process.argv;

  if (!type || !["binary", "scalar"].includes(type)) {
    console.error(`\nUsage:`);
    console.error(`  node scripts/createMarket.js binary "<question>" <feedName> <strikePrice> <expiryTs> <resolutionTs>`);
    console.error(`  node scripts/createMarket.js scalar "<question>" <feedName> <floor> <cap> <expiryTs> <resolutionTs>`);
    console.error(`\nFeed names: BTC_USD, ETH_USD, SOL_USD, BNB_USD, ADA_USD, DOGE_USD`);
    console.error(`Price format: 8 decimals — $65432.10 = 6543210000000`);
    process.exit(1);
  }

  const provider = getProvider();
  await assertArcChain(provider);
  const wallet = getWallet(provider);

  // Load MarketFactory deployment
  const deployment = loadDeployment("MarketFactory");
  const abi        = loadABI("MarketFactory");
  const factory    = new ethers.Contract(deployment.address, abi, wallet);

  console.log(`\n🏭 MarketFactory: ${deployment.address}`);
  console.log(`👤 Creator:       ${wallet.address}`);

  if (type === "binary") {
    await createBinaryMarket(factory, wallet, provider, args);
  } else {
    await createScalarMarket(factory, wallet, provider, args);
  }
}

main().catch((err) => {
  console.error(`\n💥 Failed: ${err.message}`);
  process.exit(1);
});
