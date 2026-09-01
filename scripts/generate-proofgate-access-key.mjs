import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const accessKey = `pg_test_${randomBytes(24).toString("base64url")}`;
const digest = createHash("sha256").update(accessKey.normalize("NFKC"), "utf8").digest("hex");
const hashedKey = `sha256:${digest}`;
const outputIndex = process.argv.indexOf("--out");
const outputPath = outputIndex === -1 ? null : process.argv[outputIndex + 1];

if (outputIndex !== -1 && !outputPath) {
  throw new Error("--out requires a path inside an ignored private artifact directory.");
}

if (outputPath) {
  const absolute = resolve(outputPath);
  const allowedRoot = resolve(process.cwd(), "artifacts", "private");
  if (absolute !== allowedRoot && !absolute.startsWith(`${allowedRoot}\\`) && !absolute.startsWith(`${allowedRoot}/`)) {
    throw new Error("Access-key artifacts may only be written under artifacts/private.");
  }
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, `${JSON.stringify({ access_key: accessKey, hash: hashedKey }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  process.stdout.write(`Generated an ignored private tester credential at ${absolute}.\nOnly its SHA-256 hash should be stored in Vercel.\n`);
  process.exit(0);
}

process.stdout.write([
  "ProofGate tester credential generated.",
  "",
  `Share once with the approved tester: ${accessKey}`,
  `Store only this server-side hash: ${hashedKey}`,
  "",
  "The raw key cannot be recovered from the hash. Do not commit or screenshot it.",
  "",
].join("\n"));
