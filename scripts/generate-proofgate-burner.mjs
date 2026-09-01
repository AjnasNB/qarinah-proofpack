import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const outputIndex = process.argv.indexOf("--out");
const outputPath = outputIndex === -1 ? null : process.argv[outputIndex + 1];
if (!outputPath) throw new Error("Use --out with a path under artifacts/private.");

const absolute = resolve(outputPath);
const allowedRoot = resolve(process.cwd(), "artifacts", "private");
if (absolute !== allowedRoot && !absolute.startsWith(`${allowedRoot}\\`) && !absolute.startsWith(`${allowedRoot}/`)) {
  throw new Error("Burner artifacts may only be written under artifacts/private.");
}

const privateKey = generatePrivateKey();
const account = privateKeyToAccount(privateKey);
await mkdir(dirname(absolute), { recursive: true });
await writeFile(absolute, `${JSON.stringify({
  network: "Base Sepolia",
  address: account.address,
  private_key: privateKey,
  purpose: "Dedicated minimally funded ProofGate x402 test burner",
}, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

process.stdout.write([
  `Generated dedicated ProofGate burner ${account.address}.`,
  `Private material is stored only in ignored artifact ${absolute}.`,
  "Do not import or fund the participant owner wallet for this purpose.",
  "",
].join("\n"));
