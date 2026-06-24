// scripts/utils/gas.js
import { ethers } from "ethers";

const MIN_FEE_GWEI  = 20n;
const PRIORITY_GWEI = 1n;

export async function getGasOverrides(provider) {
  const feeData   = await provider.getFeeData();
  const raw       = feeData.gasPrice ?? ethers.parseUnits("20", "gwei");
  const oneGwei   = ethers.parseUnits("1", "gwei");
  const inGwei    = raw / oneGwei;
  const base      = inGwei < MIN_FEE_GWEI ? MIN_FEE_GWEI : inGwei;
  const maxFee    = (base * 120n) / 100n;  // +20% headroom

  return {
    maxFeePerGas:         ethers.parseUnits(maxFee.toString(), "gwei"),
    maxPriorityFeePerGas: ethers.parseUnits(PRIORITY_GWEI.toString(), "gwei"),
  };
}

// ERC-20 USDC (6 dec) helpers
export const parseUSDC  = (h) => ethers.parseUnits(h.toString(), 6);
export const formatUSDC = (r) => ethers.formatUnits(r, 6);

// Oracle price (8 dec) helpers
export const parsePrice  = (h) => ethers.parseUnits(h.toString(), 8);
export const formatPrice = (r) => ethers.formatUnits(r, 8);

export async function logGasReport(provider, receipt) {
  const gasUsed  = receipt.gasUsed;
  const gasPrice = receipt.gasPrice ?? receipt.effectiveGasPrice ?? 0n;
  const fee      = gasUsed * gasPrice;
  console.log(`\n⛽ Gas Report:`);
  console.log(`   Gas used:  ${gasUsed.toLocaleString()} units`);
  console.log(`   Gas price: ${ethers.formatUnits(gasPrice, "gwei")} Gwei`);
  console.log(`   Fee paid:  ${ethers.formatUnits(fee, 18)} USDC`);
}
