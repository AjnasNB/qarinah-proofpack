import { createHash } from "node:crypto";

import type {
  EvidenceItem,
  ProofPack,
  ProofPackPayload,
  Sha256Hash,
} from "./types";

const TRACKING_PARAMETER = /^(?:utm_.+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|ref_src)$/i;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

type CanonicalPrimitive = string | number | boolean | null;
export type CanonicalJsonValue =
  | CanonicalPrimitive
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue };

function normalizeJson(value: unknown, path: string, ancestors: WeakSet<object>): CanonicalJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${path} contains a non-finite number.`);
    }
    return Object.is(value, -0) ? 0 : value;
  }

  if (typeof value !== "object") {
    throw new TypeError(`${path} contains a non-JSON value of type '${typeof value}'.`);
  }

  if (ancestors.has(value)) {
    throw new TypeError(`${path} contains a circular reference.`);
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry, index) => normalizeJson(entry, `${path}[${index}]`, ancestors));
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${path} must contain only plain JSON objects.`);
    }

    const record = value as Record<string, unknown>;
    const normalized: Record<string, CanonicalJsonValue> = {};
    for (const key of Object.keys(record).sort()) {
      normalized[key] = normalizeJson(record[key], `${path}.${key}`, ancestors);
    }
    return normalized;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Serializes a JSON value with lexicographically sorted object keys. Arrays keep
 * their order and unsupported JavaScript values are rejected rather than lost.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeJson(value, "$", new WeakSet()));
}

export function hashText(value: string): Sha256Hash {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export function hashCanonical(value: unknown): Sha256Hash {
  return hashText(canonicalJson(value));
}

export function isSha256Hash(value: unknown): value is Sha256Hash {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

/**
 * Produces a conservative HTTP(S) canonical URL. It removes fragments and
 * well-known tracking parameters but retains parameters that may change page
 * semantics. Credentials and non-web protocols are rejected.
 */
export function canonicalizeUrl(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new TypeError("Evidence URL must be an absolute URL.");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError("Evidence URL must use HTTP or HTTPS.");
  }
  if (parsed.username || parsed.password) {
    throw new TypeError("Evidence URL must not contain credentials.");
  }

  parsed.hash = "";
  const retained = [...parsed.searchParams.entries()]
    .filter(([key]) => !TRACKING_PARAMETER.test(key))
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => {
      if (leftKey !== rightKey) return leftKey < rightKey ? -1 : 1;
      if (leftValue === rightValue) return 0;
      return leftValue < rightValue ? -1 : 1;
    });
  parsed.search = "";
  for (const [key, value] of retained) {
    parsed.searchParams.append(key, value);
  }

  return parsed.toString();
}

export type UnsealedEvidenceItem = Omit<EvidenceItem, "evidence_hash"> & {
  evidence_hash?: Sha256Hash;
};

function withoutKey(value: object, key: string): Record<string, unknown> {
  const result = { ...(value as Record<string, unknown>) };
  delete result[key];
  return result;
}

/** Hashes every evidence field except the self-referential evidence_hash. */
export function buildEvidenceHash(evidence: UnsealedEvidenceItem | EvidenceItem): Sha256Hash {
  return hashCanonical(withoutKey(evidence, "evidence_hash"));
}

export function sealEvidenceItem(evidence: Omit<EvidenceItem, "evidence_hash">): EvidenceItem {
  return { ...evidence, evidence_hash: buildEvidenceHash(evidence) };
}

/** Hashes the complete ProofPack payload, excluding only its verification seal. */
export function buildManifestHash(pack: ProofPack | ProofPackPayload): Sha256Hash {
  if ("verification" in pack) {
    return hashCanonical(withoutKey(pack, "verification"));
  }
  return hashCanonical(pack);
}
