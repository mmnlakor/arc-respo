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
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "cancun",
    },
  };

  // Resolve imports — handles all relative paths in contracts/
  function findImports(importPath) {
    const candidates = [
      path.resolve(`contracts/${importPath}`),
      path.resolve(importPath),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return { contents: fs.readFileSync(c, "utf8") };
    }
    return { error: `Import not found: ${importPath}` };
  }

  const output = JSON.parse(
    solc.compile(JSON.stringify(input), { import: findImports })
  );

  if (output.errors) {
    let fatal = false;
    for (const e of output.errors) {
      if (e.severity === "error") { console.error(`❌ ${e.formattedMessage}`); fatal = true; }
      else                        { console.warn(`⚠️  ${e.formattedMessage}`); }
    }
    if (fatal) throw new Error(`Compilation of ${name}.sol failed.`);
  }

  const compiled = output.contracts?.[`${name}.sol`]?.[name];
  if (!compiled) throw new Error(`No output for "${name}".`);

  const abi      = compiled.abi;
  const bytecode = "0x" + compiled.evm.bytecode.object;
  if (!bytecode || bytecode === "0x") throw new Error(`Empty bytecode for ${name}.`);

  console.log(`✅ ${name} compiled — ${abi.length} ABI entries, ${Math.round(bytecode.length / 2)} bytes`);
  return { abi, bytecode };
}

export function saveABI(name, abi) {
  fs.mkdirSync("abis", { recursive: true });
  fs.writeFileSync(`abis/${name}.json`, JSON.stringify(abi, null, 2));
  console.log(`📄 ABI → abis/${name}.json`);
}

export function saveDeployment(name, data) {
  fs.mkdirSync("deployments", { recursive: true });
  fs.writeFileSync(`deployments/${name}.json`, JSON.stringify(data, null, 2));
  console.log(`💾 Deployment → deployments/${name}.json`);
}
