// scripts/deploy.js
// ─────────────────────────────────────────────────────────────────────────────
// Deploys the full prediction markets system in order:
//   1. PriceOracle
//   2. MarketFactory (wired to oracle)
//
// BinaryMarket and ScalarMarket are NOT deployed here.
// They are spawned on-demand via MarketFactory.createBinaryMarket()
// and MarketFactory.createScalarMarket().
//
// Railway env vars required:
//   PRIVATE_KEY, ARC_RPC_URL, ARC_CHAIN_ID, USDC_ADDRESS
//   PROTOCOL_FEE_BPS (default 200 = 2%)
//   ORACLE_FRESHNESS_SECONDS (default 3600 = 1 hour)
// ─────────────────────────────────────────────────────────────────────────────

import { ethers }  from "ethers";
import { getProvider, getWallet, assertArcChain } from "./utils/provider.js";
import { getGasOverrides, logGasReport }           from "./utils/gas.js";
import { readContract, compileContract, saveABI, saveDeployment } from "./utils/compiler.js";

if (process.env.SKIP_DEPLOY === "true") {
  console.log("SKIP_DEPLOY=true — exiting.");
  console.log(`Oracle:  ${process.env.ORACLE_ADDRESS}`);
  console.log(`Factory: ${process.env.FACTORY_ADDRESS}`);
  process.exit(0);
}

// ─────────────────────────────────────────────
// Deploy a single contract and return its address
// ─────────────────────────────────────────────
async function deployContract(name, constructorArgs, wallet, provider) {
  const source            = readContract(name);
  const { abi, bytecode } = compileContract(name, source);
  saveABI(name, abi);

  const gasOverrides = await getGasOverrides(provider);
  console.log(`\n📡 Deploying ${name}...`);
  console.log(`   Args: ${JSON.stringify(constructorArgs, null, 2)}`);

  const factory  = new ethers.ContractFactory(abi, bytecode, wallet);
  const contract = await factory.deploy(...constructorArgs, gasOverrides);
  const tx       = contract.deploymentTransaction();

  console.log(`⏳ Tx: ${tx.hash}`);
  const receipt = await tx.wait(1); // Arc: 1 conf = final
  const address = await contract.getAddress();

  console.log(`✅ ${name} → ${address}`);
  console.log(`   Block:    ${receipt.blockNumber}`);
  console.log(`   Explorer: https://testnet.arcscan.app/address/${address}`);

  await logGasReport(provider, receipt);

  saveDeployment(name, {
    contractName: name,
    address,
    deployer:        wallet.address,
    txHash:          receipt.hash,
    blockNumber:     receipt.blockNumber,
    chainId:         5042002,
    network:         "arc-testnet",
    constructorArgs,
    deployedAt:      new Date().toISOString(),
    explorerUrl:     `https://testnet.arcscan.app/address/${address}`,
  });

  return { address, abi, contract };
}

// ─────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────
async function main() {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Arc Prediction Markets — Full System Deploy`);
  console.log(`${"═".repeat(60)}`);
  console.log(`  Time: ${new Date().toISOString()}`);

  const provider = getProvider();
  await assertArcChain(provider);
  const wallet = getWallet(provider);

  console.log(`\n👤 Deployer:  ${wallet.address}`);

  const nativeBal = await provider.getBalance(wallet.address);
  console.log(`💰 USDC bal:  ${ethers.formatUnits(nativeBal, 18)} USDC`);
  if (nativeBal === 0n) {
    console.error(`❌ No USDC for gas. Get from: https://faucet.circle.com/`);
    process.exit(1);
  }

  const USDC_ADDRESS       = process.env.USDC_ADDRESS       || "0x3600000000000000000000000000000000000000";
  const PROTOCOL_FEE_BPS   = parseInt(process.env.PROTOCOL_FEE_BPS       || "200");
  const FRESHNESS_SECONDS  = parseInt(process.env.ORACLE_FRESHNESS_SECONDS || "3600");

  // ── 1. Deploy PriceOracle ─────────────────────────────────────────────
  console.log(`\n${"─".repeat(60)}`);
  console.log(`Step 1/2 — PriceOracle`);
  console.log(`${"─".repeat(60)}`);

  const { address: oracleAddress } = await deployContract(
    "PriceOracle",
    [],   // no constructor args — pre-registers BTC/ETH/SOL feeds in constructor
    wallet,
    provider
  );

  // ── 2. Deploy MarketFactory ───────────────────────────────────────────
  console.log(`\n${"─".repeat(60)}`);
  console.log(`Step 2/2 — MarketFactory`);
  console.log(`${"─".repeat(60)}`);

  const { address: factoryAddress } = await deployContract(
    "MarketFactory",
    [
      USDC_ADDRESS,
      oracleAddress,
      wallet.address,   // treasury = deployer wallet (change this in production)
      PROTOCOL_FEE_BPS,
      FRESHNESS_SECONDS,
    ],
    wallet,
    provider
  );

  // ── Summary ───────────────────────────────────────────────────────────
  console.log(`\n${"═".repeat(60)}`);
  console.log(`✅ DEPLOYMENT COMPLETE`);
  console.log(`${"═".repeat(60)}`);
  console.log(`PriceOracle:   ${oracleAddress}`);
  console.log(`MarketFactory: ${factoryAddress}`);
  console.log(`\nAdd these to Railway Variables:`);
  console.log(`  ORACLE_ADDRESS=${oracleAddress}`);
  console.log(`  FACTORY_ADDRESS=${factoryAddress}`);
  console.log(`  SKIP_DEPLOY=true`);
  console.log(`${"═".repeat(60)}`);
}

main().catch((err) => {
  console.error(`\n💥 Deploy failed: ${err.message}`);
  process.exit(1);
});
