#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseMinerYaml,
  renderMinerYaml,
  sha256Yaml,
  TELEGRAPH_INTENTS,
  TELEGRAPH_MINER_ID,
  TELEGRAPH_MINER_SLUG,
  validateLiveIntents,
  validateMinerConfig,
  validateRegistryAvailability,
} from "../telegraph/config.mjs";

export const TELEGRAPH_INTENTS_URL = "https://devnode.telegraphprotocol.com/engine/v1/intents";
export const TELEGRAPH_MINERS_URL = "https://devnode.telegraphprotocol.com/api/miners?limit=1000";
export const TELEGRAPH_YAML_STANDARD_URL = "https://raw.githubusercontent.com/telegraphprotocol/telegraph-docs/main/miners/yaml-config.md";
export const TELEGRAPH_REFERENCE_YAML_URL = "https://raw.githubusercontent.com/telegraphprotocol/telegraph-examples/master/frontend/yaml/example-miner.yaml";
export const TELEGRAPH_DOCS_COMMIT_URL = "https://api.github.com/repos/telegraphprotocol/telegraph-docs/commits/main";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, "..");
const DEFAULT_TEMPLATE = resolve(REPOSITORY_ROOT, "telegraph", "miner.yaml");

function usage() {
  return `Qarinah ProofPack Telegraph validator

Usage:
  PROOFPACK_PUBLIC_URL=https://qarinah-proofpack.vercel.app \\
    node scripts/validate-telegraph.mjs [options]

Options:
  --out <file>       Write the fully rendered, registration-ready YAML.
  --template <file>  Read another template instead of telegraph/miner.yaml.
  --official-source  Audit assumptions against Telegraph's current public docs and reference YAML.
  --offline          Skip the live canonical-intent and Miner-registry checks.
  --help             Show this help.

The script never accepts or transmits an API key. Qarinah ProofPack declares
auth.type: none. Run Telegraph's authenticated schema and endpoint sandbox in
the official developer console before registration.`;
}

function parseArguments(argv) {
  const options = {
    offline: false,
    officialSource: false,
    out: null,
    template: DEFAULT_TEMPLATE,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") return { ...options, help: true };
    if (argument === "--offline") {
      options.offline = true;
      continue;
    }
    if (argument === "--official-source") {
      options.officialSource = true;
      continue;
    }
    if (argument === "--out" || argument === "--template") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new TypeError(`${argument} requires a file path.`);
      options[argument.slice(2)] = resolve(process.cwd(), value);
      index += 1;
      continue;
    }
    throw new TypeError(`Unknown argument: ${argument}`);
  }

  if (options.officialSource && options.offline) {
    throw new TypeError("--official-source and --offline cannot be used together.");
  }
  if (options.out && options.out === options.template) {
    throw new TypeError("--out must not overwrite the substitution-token template.");
  }
  return options;
}

async function fetchJson(url, init = {}, timeoutMs = 20_000) {
  const response = await fetch(url, {
    ...init,
    headers: {
      accept: "application/json",
      "user-agent": "qarinah-proofpack-telegraph-validator/1.0",
      ...init.headers,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let body;
  try {
    body = text === "" ? null : JSON.parse(text);
  } catch {
    throw new Error(`${url} returned non-JSON HTTP ${response.status}.`);
  }
  if (!response.ok) {
    const detail = body?.error ?? body?.message ?? JSON.stringify(body);
    throw new Error(`${url} returned HTTP ${response.status}: ${detail}`);
  }
  return body;
}

async function fetchText(url, timeoutMs = 20_000) {
  const response = await fetch(url, {
    headers: {
      accept: "text/plain",
      "user-agent": "qarinah-proofpack-telegraph-validator/1.0",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}.`);
  return response.text();
}

export function validateOfficialSourceDocuments(standard, referenceYaml) {
  const requiredStandardStatements = [
    "`semantics.signal_mapping.confidence_field`",
    "`semantics.signal_mapping.label_field`",
    "`semantics.signal_mapping.reason_field`",
    "`semantics.supported_intents`",
    "`on_chain.transform`",
    "`input_schema`",
    "`output_schema`",
    "`params`",
  ];
  for (const statement of requiredStandardStatements) {
    if (!standard.includes(statement)) {
      throw new Error(`Telegraph YAML Standard no longer contains expected contract marker ${statement}.`);
    }
  }

  const reference = parseMinerYaml(referenceYaml);
  for (const field of ["endpoints", "input_schema", "output_schema", "semantics", "on_chain"]) {
    if (!(field in reference)) {
      throw new Error(`Telegraph reference YAML no longer demonstrates ${field}.`);
    }
  }
  return true;
}

export async function validateOfficialSources() {
  const [standard, referenceYaml, commit] = await Promise.all([
    fetchText(TELEGRAPH_YAML_STANDARD_URL),
    fetchText(TELEGRAPH_REFERENCE_YAML_URL),
    fetchJson(TELEGRAPH_DOCS_COMMIT_URL),
  ]);
  validateOfficialSourceDocuments(standard, referenceYaml);
  const commitSha = String(commit?.sha ?? "");
  if (!/^[0-9a-f]{40}$/u.test(commitSha)) {
    throw new Error("Telegraph docs source did not return a valid Git commit SHA.");
  }
  return { commitSha };
}

export async function validateLiveState(config) {
  const [intentsResponse, minersResponse] = await Promise.all([
    fetchJson(TELEGRAPH_INTENTS_URL),
    fetchJson(TELEGRAPH_MINERS_URL),
  ]);
  return {
    intentCounts: validateLiveIntents(intentsResponse),
    registry: validateRegistryAvailability(minersResponse, config),
  };
}

function displayPath(path) {
  const fromRoot = relative(REPOSITORY_ROOT, path);
  return fromRoot.startsWith("..") ? path : fromRoot.replaceAll("\\", "/");
}

export async function main(argv = process.argv.slice(2), environment = process.env) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const publicUrl = environment.PROOFPACK_PUBLIC_URL;
  if (!publicUrl) {
    throw new TypeError("PROOFPACK_PUBLIC_URL is required and must be the deployed public HTTPS origin.");
  }

  const template = await readFile(options.template, "utf8");
  const rendered = renderMinerYaml(template, publicUrl);
  const config = validateMinerConfig(parseMinerYaml(rendered));
  const hash = sha256Yaml(rendered);

  process.stdout.write(`[ok] local Telegraph contract: ${config.slug} (${config.id})\n`);
  process.stdout.write(`[ok] endpoint: POST ${config.endpoints[0].path}\n`);
  process.stdout.write(`[ok] intents: ${TELEGRAPH_INTENTS.join(", ")}\n`);

  if (!options.offline) {
    const live = await validateLiveState(config);
    const countText = TELEGRAPH_INTENTS
      .map((intent) => `${intent}=${live.intentCounts[intent]} active Miner(s)`)
      .join(", ");
    process.stdout.write(`[ok] live canonical intents: ${countText}\n`);
    if (live.registry.alreadyRegistered) {
      process.stdout.write(`[ok] registry identity already belongs to ${TELEGRAPH_MINER_SLUG} (${TELEGRAPH_MINER_ID})\n`);
    } else {
      process.stdout.write(`[ok] Miner ID ${TELEGRAPH_MINER_ID} and slug ${TELEGRAPH_MINER_SLUG} are unused across ${live.registry.minerCount} live Miner(s)\n`);
    }
  } else {
    process.stdout.write("[skip] live Telegraph intent and registry checks (--offline)\n");
  }

  if (options.officialSource) {
    const official = await validateOfficialSources();
    process.stdout.write(`[ok] official Telegraph YAML sources at telegraph-docs commit ${official.commitSha}\n`);
  }

  if (options.out) {
    await writeFile(options.out, rendered, { encoding: "utf8", flag: "w" });
    process.stdout.write(`[ok] rendered YAML: ${displayPath(options.out)}\n`);
  } else {
    process.stdout.write("[info] no file written; pass --out <file> to create registration YAML\n");
  }

  process.stdout.write(`[hash] SHA-256 ${hash.contentHash}\n`);
  process.stdout.write(`[hash] registerMiner bytes32 ${hash.prefixed}\n`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[error] ${message}\n`);
    process.exitCode = 1;
  });
}
