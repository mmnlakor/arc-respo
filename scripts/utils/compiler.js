// scripts/utils/compiler.js
import solc from "solc";
import fs   from "fs";
import path from "path";

export function readContract(name) {
  const p = path.resolve(`contracts/${name}.sol`);
  if (!fs.existsSync(p)) throw new Error(`Contract not found: ${p}`);
  return fs.readFileSync(p, "utf8");
}

export function compileContract(name, source) {
  console.log(`\n🔨 Compiling ${name}.sol ...`);

  const input = {
    language: "Solidity",
    sources: { [`${name}.sol`]: { content: source } },
    settings: {
      outputSelection: {
        "*": {
          "*": ["abi", "evm.bytecode.object"],
        },
      },
      optimizer: {
        enabled: true,
        runs: 200,
        details: {
          yul: true,
        },
      },
      viaIR: true,
      evmVersion: "cancun",
    },
  };

  // ── Import resolver ────────────────────────────────────────────────────
  // Handles relative imports like:
  //   import "./interfaces/IUSDC.sol"
  //   import "./interfaces/IPriceOracle.sol"
  // solc-js cannot resolve file paths on its own — we supply them here.
  function findImports(importPath) {
    const candidates = [
      path.resolve(`contracts/${importPath}`),
      path.resolve(importPath),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        return { contents: fs.readFileSync(c, "utf8") };
      }
    }
    return { error: `Import not found: ${importPath}` };
  }

  const output = JSON.parse(
    solc.compile(JSON.stringify(input), { import: findImports })
  );

  // ── Surface errors and warnings ────────────────────────────────────────
  if (output.errors) {
    let fatal = false;
    for (const e of output.errors) {
      if (e.severity === "error") {
        console.error(`❌ ${e.formattedMessage}`);
        fatal = true;
      } else {
        console.warn(`⚠️  ${e.formattedMessage}`);
      }
    }
    if (fatal) throw new Error(`Compilation of ${name}.sol failed.`);
  }

  // ── Extract ABI and bytecode ───────────────────────────────────────────
  const compiled = output.contracts?.[`${name}.sol`]?.[name];
  if (!compiled) {
    throw new Error(
      `No output for contract "${name}". ` +
      `Make sure the contract name matches the file name exactly (case-sensitive).`
    );
  }

  const abi      = compiled.abi;
  const bytecode = "0x" + compiled.evm.bytecode.object;

  if (!bytecode || bytecode === "0x") {
    throw new Error(`Empty bytecode for ${name} — is it abstract or an interface?`);
  }

  console.log(`✅ ${name} compiled successfully`);
  console.log(`   ABI entries: ${abi.length}`);
  console.log(`   Bytecode:    ${Math.round(bytecode.length / 2)} bytes`);

  return { abi, bytecode };
}

// ── Save ABI to abis/<name>.json ───────────────────────────────────────────
export function saveABI(name, abi) {
  fs.mkdirSync("abis", { recursive: true });
  const p = `abis/${name}.json`;
  fs.writeFileSync(p, JSON.stringify(abi, null, 2));
  console.log(`📄 ABI → ${p}`);
  return p;
}

// ── Save deployment receipt to deployments/<name>.json ─────────────────────
export function saveDeployment(name, data) {
  fs.mkdirSync("deployments", { recursive: true });
  const p = `deployments/${name}.json`;
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
  console.log(`💾 Deployment → ${p}`);
  return p;
}

// ── Load a saved deployment receipt ───────────────────────────────────────
export function loadDeployment(name) {
  const p = `deployments/${name}.json`;
  if (!fs.existsSync(p)) {
    throw new Error(
      `No deployment found at ${p}.\n` +
      `Run: node scripts/deploy.js first.`
    );
  }
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

// ── Load a saved ABI ──────────────────────────────────────────────────────
export function loadABI(name) {
  const p = `abis/${name}.json`;
  if (!fs.existsSync(p)) {
    throw new Error(
      `No ABI found at ${p}.\n` +
      `Run: node scripts/deploy.js first (it auto-saves ABIs).`
    );
  }
  return JSON.parse(fs.readFileSync(p, "utf8"));
}
