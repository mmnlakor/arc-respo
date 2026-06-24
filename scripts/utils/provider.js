// scripts/utils/provider.js
import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

export function getProvider() {
  const rpcUrl = process.env.ARC_RPC_URL;
  if (!rpcUrl) throw new Error("ARC_RPC_URL not set.");
  return new ethers.JsonRpcProvider(rpcUrl, {
    chainId: parseInt(process.env.ARC_CHAIN_ID || "5042002"),
    name: "arc-testnet",
  });
}

export function getWallet(provider) {
  const pk = process.env.PRIVATE_KEY;
  if (!pk) throw new Error("PRIVATE_KEY not set.");
  return new ethers.Wallet(pk, provider);
}

export async function assertArcChain(provider) {
  const network  = await provider.getNetwork();
  const expected = BigInt(process.env.ARC_CHAIN_ID || "5042002");
  if (network.chainId !== expected) {
    throw new Error(`Wrong chain. Expected ${expected}, got ${network.chainId}.`);
  }
  console.log(`✅ Connected to Arc Testnet (chainId: ${network.chainId})`);
}

// USDC ERC-20 ABI — minimal surface needed by scripts
export const USDC_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function transferFrom(address from, address to, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
];

export function getUSDC(signerOrProvider) {
  const addr = process.env.USDC_ADDRESS || "0x3600000000000000000000000000000000000000";
  return new ethers.Contract(addr, USDC_ABI, signerOrProvider);
}

// Load a saved deployment JSON
import fs from "fs";

export function loadDeployment(name) {
  const p = `deployments/${name}.json`;
  if (!fs.existsSync(p)) throw new Error(`No deployment at ${p}. Run deploy.js first.`);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

export function loadABI(name) {
  const p = `abis/${name}.json`;
  if (!fs.existsSync(p)) throw new Error(`No ABI at ${p}. Run deploy.js first.`);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}
