import {
  buildEvidenceHash,
  buildManifestHash,
  canonicalJson,
  canonicalizeUrl,
  isSha256Hash,
} from "./canonical";
import { qarinahEvidenceProjection, validateQarinahProofChain } from "./qarinah-chain";
import {
  PROOFPACK_SCHEMA_VERSION,
  PROOF_VERIFICATION_SCHEMA_VERSION,
  type EvidenceItem,
  type ProofPack,
  type ProofPackPayload,
  type ProofVerification,
  type ProofVerificationResult,
  type VerificationError,
  type VerificationErrorCode,
} from "./types";

const VERDICTS = new Set(["SUPPORTED", "REFUTED", "MIXED", "INSUFFICIENT_EVIDENCE"]);
const STANCES = new Set(["SUPPORTS", "REFUTES", "MIXED", "NEUTRAL"]);
const INTENTS = new Set(["FACT_CHECK", "RESEARCH_SYNTHESIS"]);
const SOURCE_TYPES = new Set([
  "official",
  "government",
  "academic",
  "news",
  "primary",
  "secondary",
  "crawler",
  "rendered",
  "other",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze<T>(value: T, visited = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || visited.has(value)) return value;
  visited.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child, visited);
  }
  return Object.freeze(value);
}

function canonicalClone<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

function makeVerification(payload: ProofPackPayload): ProofVerification {
  return {
    schema_version: PROOF_VERIFICATION_SCHEMA_VERSION,
    algorithm: "SHA-256",
    canonicalization: "proofpack.canonical-json.v1",
    manifest_scope: "proofpack-without-verification",
    manifest_hash: buildManifestHash(payload),
    event_chain_head: payload.qarinah.head_hash,
    event_count: payload.qarinah.event_count,
  };
}

export function createProofVerification(payload: ProofPackPayload): ProofVerification {
  return makeVerification(payload);
}

/**
 * Attaches a deterministic manifest seal and returns a detached, deeply frozen
 * ProofPack. Invalid packs are rejected before they can be issued.
 */
export function sealProofPack(payload: ProofPackPayload): ProofPack {
  const detached = canonicalClone(payload);
  const pack: ProofPack = { ...detached, verification: makeVerification(detached) };
  const result = verifyProofPack(pack);
  if (!result.valid) {
    const detail = result.errors.map((error) => `${error.path}: ${error.message}`).join("; ");
    throw new TypeError(`Cannot seal an invalid ProofPack. ${detail}`);
  }
  return deepFreeze(pack);
}

function verifier() {
  const errors: VerificationError[] = [];
  const add = (code: VerificationErrorCode, path: string, message: string) => {
    errors.push({ code, path, message });
  };
  return { errors, add };
}

function checkKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  path: string,
  add: (code: VerificationErrorCode, path: string, message: string) => void,
) {
  const allowedSet = new Set(allowed);
  const missing = required.filter((key) => !(key in record));
  const unknown = Object.keys(record).filter((key) => !allowedSet.has(key));
  for (const key of missing) add("INVALID_CONTRACT", `${path}.${key}`, "Required field is missing.");
  for (const key of unknown) add("INVALID_CONTRACT", `${path}.${key}`, "Unknown field is not permitted.");
}

function checkString(
  value: unknown,
  path: string,
  add: (code: VerificationErrorCode, path: string, message: string) => void,
  options: { allowEmpty?: boolean; minimum?: number; maximum?: number } = {},
): value is string {
  const minimum = options.allowEmpty ? 0 : (options.minimum ?? 1);
  const maximum = options.maximum ?? 65_536;
  if (typeof value !== "string" || value.trim().length < minimum || value.length > maximum) {
    add("INVALID_CONTRACT", path, `Expected a string from ${minimum} through ${maximum} characters.`);
    return false;
  }
  return true;
}

function checkScore(
  value: unknown,
  path: string,
  add: (code: VerificationErrorCode, path: string, message: string) => void,
): value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    add("INVALID_CONTRACT", path, "Expected a finite number from 0 through 1.");
    return false;
  }
  return true;
}

function checkInteger(
  value: unknown,
  path: string,
  add: (code: VerificationErrorCode, path: string, message: string) => void,
): value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    add("INVALID_CONTRACT", path, "Expected a non-negative safe integer.");
    return false;
  }
  return true;
}

function checkTimestamp(
  value: unknown,
  path: string,
  add: (code: VerificationErrorCode, path: string, message: string) => void,
  nullable = false,
): value is string | null {
  if (nullable && value === null) return true;
  if (typeof value !== "string") {
    add("INVALID_CONTRACT", path, `Expected ${nullable ? "null or " : ""}a canonical ISO-8601 timestamp.`);
    return false;
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) {
    add("INVALID_CONTRACT", path, "Expected a canonical ISO-8601 timestamp such as 2026-08-31T12:00:00.000Z.");
    return false;
  }
  return true;
}

function checkStringArray(
  value: unknown,
  path: string,
  add: (code: VerificationErrorCode, path: string, message: string) => void,
): value is string[] {
  if (!Array.isArray(value) || value.length > 128 || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    add("INVALID_CONTRACT", path, "Expected at most 128 non-empty strings.");
    return false;
  }
  if (new Set(value).size !== value.length) {
    add("INVALID_CONTRACT", path, "Duplicate entries are not permitted.");
    return false;
  }
  return true;
}

function validateEvidence(
  evidence: unknown,
  index: number,
  add: (code: VerificationErrorCode, path: string, message: string) => void,
): evidence is EvidenceItem {
  const path = `$.evidence[${index}]`;
  if (!isRecord(evidence)) {
    add("INVALID_CONTRACT", path, "Expected an evidence object.");
    return false;
  }
  const keys = [
    "id", "url", "canonical_url", "title", "excerpt", "retrieved_at", "published_at",
    "content_hash", "evidence_hash", "source_domain", "source_type", "stance", "relevance",
    "quality", "freshness", "supports", "refutes", "untrusted",
  ];
  checkKeys(evidence, keys, keys, path, add);
  checkString(evidence.id, `${path}.id`, add, { maximum: 128 });
  const validUrl = checkString(evidence.url, `${path}.url`, add, { maximum: 4_096 });
  const validCanonical = checkString(evidence.canonical_url, `${path}.canonical_url`, add, { maximum: 4_096 });
  checkString(evidence.title, `${path}.title`, add, { allowEmpty: true, maximum: 1_024 });
  checkString(evidence.excerpt, `${path}.excerpt`, add, { maximum: 16_384 });
  checkTimestamp(evidence.retrieved_at, `${path}.retrieved_at`, add);
  checkTimestamp(evidence.published_at, `${path}.published_at`, add, true);
  if (!isSha256Hash(evidence.content_hash)) add("INVALID_CONTRACT", `${path}.content_hash`, "Expected a lowercase SHA-256 hash.");
  if (!isSha256Hash(evidence.evidence_hash)) add("INVALID_CONTRACT", `${path}.evidence_hash`, "Expected a lowercase SHA-256 hash.");
  const validDomain = checkString(evidence.source_domain, `${path}.source_domain`, add, { maximum: 253 });
  if (!SOURCE_TYPES.has(evidence.source_type as string)) add("INVALID_CONTRACT", `${path}.source_type`, "Unsupported source type.");
  if (!STANCES.has(evidence.stance as string)) add("INVALID_CONTRACT", `${path}.stance`, "Unsupported evidence stance.");
  checkScore(evidence.relevance, `${path}.relevance`, add);
  checkScore(evidence.quality, `${path}.quality`, add);
  checkScore(evidence.freshness, `${path}.freshness`, add);
  if (typeof evidence.supports !== "boolean") add("INVALID_CONTRACT", `${path}.supports`, "Expected a boolean.");
  if (typeof evidence.refutes !== "boolean") add("INVALID_CONTRACT", `${path}.refutes`, "Expected a boolean.");
  if (evidence.untrusted !== true) add("INVALID_CONTRACT", `${path}.untrusted`, "Crawler material must be explicitly marked untrusted: true.");

  if (validUrl && validCanonical) {
    try {
      const canonical = canonicalizeUrl(evidence.url as string);
      if (canonical !== evidence.canonical_url) {
        add("INCONSISTENT_CONTRACT", `${path}.canonical_url`, "Canonical URL does not match the source URL.");
      }
      const canonicalHostname = new URL(evidence.canonical_url as string).hostname;
      if (
        validDomain
        && canonicalHostname !== evidence.source_domain
        && !canonicalHostname.endsWith(`.${evidence.source_domain as string}`)
      ) {
        add("INCONSISTENT_CONTRACT", `${path}.source_domain`, "Source domain does not match canonical_url.");
      }
    } catch (error) {
      add("INVALID_CONTRACT", `${path}.url`, error instanceof Error ? error.message : "Invalid evidence URL.");
    }
  }

  const stance = evidence.stance;
  if (stance === "SUPPORTS" && (evidence.supports !== true || evidence.refutes !== false)) {
    add("INCONSISTENT_CONTRACT", path, "SUPPORTS stance requires supports=true and refutes=false.");
  } else if (stance === "REFUTES" && (evidence.supports !== false || evidence.refutes !== true)) {
    add("INCONSISTENT_CONTRACT", path, "REFUTES stance requires supports=false and refutes=true.");
  } else if (stance === "MIXED" && (evidence.supports !== true || evidence.refutes !== true)) {
    add("INCONSISTENT_CONTRACT", path, "MIXED stance requires supports=true and refutes=true.");
  } else if (stance === "NEUTRAL" && (evidence.supports !== false || evidence.refutes !== false)) {
    add("INCONSISTENT_CONTRACT", path, "NEUTRAL stance requires supports=false and refutes=false.");
  }
  return true;
}

function validateContract(pack: Record<string, unknown>, add: (code: VerificationErrorCode, path: string, message: string) => void) {
  const rootKeys = [
    "schema_version", "pack_id", "request", "generated_at", "verdict", "confidence", "answer",
    "coverage_score", "freshness_score", "conflict_score", "score_breakdown", "claims", "evidence",
    "contradictions", "policy", "qarinah", "abstained", "reason", "verification",
  ];
  checkKeys(pack, rootKeys, rootKeys, "$", add);
  if (pack.schema_version !== PROOFPACK_SCHEMA_VERSION) add("INVALID_CONTRACT", "$.schema_version", "Unsupported ProofPack schema version.");
  checkString(pack.pack_id, "$.pack_id", add, { maximum: 128 });
  checkTimestamp(pack.generated_at, "$.generated_at", add);
  if (!VERDICTS.has(pack.verdict as string)) add("INVALID_CONTRACT", "$.verdict", "Unsupported verdict.");
  checkScore(pack.confidence, "$.confidence", add);
  checkString(pack.answer, "$.answer", add, { allowEmpty: true, maximum: 65_536 });
  checkScore(pack.coverage_score, "$.coverage_score", add);
  checkScore(pack.freshness_score, "$.freshness_score", add);
  checkScore(pack.conflict_score, "$.conflict_score", add);
  if (typeof pack.abstained !== "boolean") add("INVALID_CONTRACT", "$.abstained", "Expected a boolean.");
  checkString(pack.reason, "$.reason", add, { maximum: 4_096 });

  if (isRecord(pack.request)) {
    checkKeys(pack.request, ["query", "intent", "request_id", "as_of"], ["query"], "$.request", add);
    checkString(pack.request.query, "$.request.query", add, { minimum: 3, maximum: 2_048 });
    if (pack.request.intent !== undefined && !INTENTS.has(pack.request.intent as string)) {
      add("INVALID_CONTRACT", "$.request.intent", "Unsupported Telegraph intent.");
    }
    if (pack.request.request_id !== undefined) checkString(pack.request.request_id, "$.request.request_id", add, { maximum: 256 });
    if (pack.request.as_of !== undefined) checkTimestamp(pack.request.as_of, "$.request.as_of", add, true);
  } else {
    add("INVALID_CONTRACT", "$.request", "Expected a request object.");
  }

  const evidenceIds = new Set<string>();
  if (!Array.isArray(pack.evidence)) {
    add("INVALID_CONTRACT", "$.evidence", "Expected an evidence array.");
  } else {
    if (pack.evidence.length > 128) add("INVALID_CONTRACT", "$.evidence", "At most 128 evidence records are permitted.");
    pack.evidence.forEach((item, index) => {
      if (validateEvidence(item, index, add) && evidenceIds.has(item.id)) {
        add("INVALID_CONTRACT", `$.evidence[${index}].id`, "Evidence IDs must be unique.");
      } else if (isRecord(item) && typeof item.id === "string") {
        evidenceIds.add(item.id);
      }
    });
  }

  const claimIds = new Set<string>();
  if (!Array.isArray(pack.claims)) {
    add("INVALID_CONTRACT", "$.claims", "Expected a claims array.");
  } else {
    if (pack.claims.length > 128) add("INVALID_CONTRACT", "$.claims", "At most 128 claims are permitted.");
    pack.claims.forEach((candidate, index) => {
      const path = `$.claims[${index}]`;
      if (!isRecord(candidate)) {
        add("INVALID_CONTRACT", path, "Expected a claim object.");
        return;
      }
      const keys = ["id", "claim", "verdict", "confidence", "evidence_ids", "supporting_evidence_ids", "refuting_evidence_ids"];
      checkKeys(candidate, keys, keys, path, add);
      if (checkString(candidate.id, `${path}.id`, add, { maximum: 128 })) {
        if (claimIds.has(candidate.id)) add("INVALID_CONTRACT", `${path}.id`, "Claim IDs must be unique.");
        claimIds.add(candidate.id);
      }
      checkString(candidate.claim, `${path}.claim`, add, { maximum: 8_192 });
      if (!VERDICTS.has(candidate.verdict as string)) add("INVALID_CONTRACT", `${path}.verdict`, "Unsupported claim verdict.");
      checkScore(candidate.confidence, `${path}.confidence`, add);
      for (const field of ["evidence_ids", "supporting_evidence_ids", "refuting_evidence_ids"] as const) {
        if (checkStringArray(candidate[field], `${path}.${field}`, add)) {
          for (const id of candidate[field]) {
            if (!evidenceIds.has(id)) add("INVALID_REFERENCE", `${path}.${field}`, `Unknown evidence ID '${id}'.`);
          }
        }
      }
      if (Array.isArray(candidate.evidence_ids)) {
        const all = new Set(candidate.evidence_ids);
        for (const field of ["supporting_evidence_ids", "refuting_evidence_ids"] as const) {
          if (Array.isArray(candidate[field])) {
            for (const id of candidate[field]) {
              if (!all.has(id)) add("INCONSISTENT_CONTRACT", `${path}.${field}`, `Evidence ID '${id}' is absent from evidence_ids.`);
            }
          }
        }
      }
    });
  }

  if (!Array.isArray(pack.contradictions)) {
    add("INVALID_CONTRACT", "$.contradictions", "Expected a contradictions array.");
  } else {
    if (pack.contradictions.length > 128) add("INVALID_CONTRACT", "$.contradictions", "At most 128 contradictions are permitted.");
    const contradictionIds = new Set<string>();
    pack.contradictions.forEach((candidate, index) => {
      const path = `$.contradictions[${index}]`;
      if (!isRecord(candidate)) {
        add("INVALID_CONTRACT", path, "Expected a contradiction object.");
        return;
      }
      const keys = ["id", "claim_id", "description", "evidence_ids", "severity", "unresolved"];
      checkKeys(candidate, keys, keys, path, add);
      if (checkString(candidate.id, `${path}.id`, add, { maximum: 128 })) {
        if (contradictionIds.has(candidate.id)) add("INVALID_CONTRACT", `${path}.id`, "Contradiction IDs must be unique.");
        contradictionIds.add(candidate.id);
      }
      if (checkString(candidate.claim_id, `${path}.claim_id`, add, { maximum: 128 }) && !claimIds.has(candidate.claim_id)) {
        add("INVALID_REFERENCE", `${path}.claim_id`, `Unknown claim ID '${candidate.claim_id}'.`);
      }
      checkString(candidate.description, `${path}.description`, add, { maximum: 8_192 });
      if (checkStringArray(candidate.evidence_ids, `${path}.evidence_ids`, add)) {
        if (candidate.evidence_ids.length < 2) add("INVALID_CONTRACT", `${path}.evidence_ids`, "A contradiction requires at least two evidence records.");
        for (const id of candidate.evidence_ids) {
          if (!evidenceIds.has(id)) add("INVALID_REFERENCE", `${path}.evidence_ids`, `Unknown evidence ID '${id}'.`);
        }
      }
      checkScore(candidate.severity, `${path}.severity`, add);
      if (typeof candidate.unresolved !== "boolean") add("INVALID_CONTRACT", `${path}.unresolved`, "Expected a boolean.");
    });
  }

  if (isRecord(pack.score_breakdown)) {
    const keys = ["entailment", "source_diversity", "evidence_coverage", "freshness", "source_agreement", "conflict_score", "confidence"];
    checkKeys(pack.score_breakdown, keys, keys, "$.score_breakdown", add);
    for (const key of keys) checkScore(pack.score_breakdown[key], `$.score_breakdown.${key}`, add);
    const comparisons: Array<[string, unknown, unknown]> = [
      ["confidence", pack.confidence, pack.score_breakdown.confidence],
      ["coverage_score", pack.coverage_score, pack.score_breakdown.evidence_coverage],
      ["freshness_score", pack.freshness_score, pack.score_breakdown.freshness],
      ["conflict_score", pack.conflict_score, pack.score_breakdown.conflict_score],
    ];
    for (const [field, outer, inner] of comparisons) {
      if (typeof outer === "number" && typeof inner === "number" && outer !== inner) {
        add("INCONSISTENT_CONTRACT", `$.${field}`, `Top-level ${field} does not match score_breakdown.`);
      }
    }
  } else {
    add("INVALID_CONTRACT", "$.score_breakdown", "Expected a score breakdown object.");
  }

  if (isRecord(pack.policy)) {
    const keys = [
      "policy_id", "passed", "abstained", "final_verdict", "independent_sources",
      "minimum_independent_sources", "coverage_threshold", "confidence_threshold", "rules_triggered", "reason",
    ];
    checkKeys(pack.policy, keys, keys, "$.policy", add);
    if (pack.policy.policy_id !== "maqam.evidence-contract.v1") add("INVALID_CONTRACT", "$.policy.policy_id", "Unsupported evidence policy.");
    if (typeof pack.policy.passed !== "boolean") add("INVALID_CONTRACT", "$.policy.passed", "Expected a boolean.");
    if (typeof pack.policy.abstained !== "boolean") add("INVALID_CONTRACT", "$.policy.abstained", "Expected a boolean.");
    if (!VERDICTS.has(pack.policy.final_verdict as string)) add("INVALID_CONTRACT", "$.policy.final_verdict", "Unsupported verdict.");
    checkInteger(pack.policy.independent_sources, "$.policy.independent_sources", add);
    checkInteger(pack.policy.minimum_independent_sources, "$.policy.minimum_independent_sources", add);
    checkScore(pack.policy.coverage_threshold, "$.policy.coverage_threshold", add);
    checkScore(pack.policy.confidence_threshold, "$.policy.confidence_threshold", add);
    checkStringArray(pack.policy.rules_triggered, "$.policy.rules_triggered", add);
    checkString(pack.policy.reason, "$.policy.reason", add, { maximum: 4_096 });
    if (pack.policy.abstained !== pack.abstained) add("INCONSISTENT_CONTRACT", "$.policy.abstained", "Policy abstention does not match the ProofPack.");
    if (pack.policy.final_verdict !== pack.verdict) add("INCONSISTENT_CONTRACT", "$.policy.final_verdict", "Policy verdict does not match the ProofPack.");
    if (pack.policy.passed === pack.abstained) add("INCONSISTENT_CONTRACT", "$.policy.passed", "A passed policy must not abstain, and an abstaining policy must not pass.");
    if (pack.abstained === false && typeof pack.confidence === "number" && typeof pack.policy.confidence_threshold === "number" && pack.confidence < pack.policy.confidence_threshold) {
      add("INCONSISTENT_CONTRACT", "$.confidence", "A non-abstained pack is below the policy confidence threshold.");
    }
    if (pack.abstained === false && typeof pack.coverage_score === "number" && typeof pack.policy.coverage_threshold === "number" && pack.coverage_score < pack.policy.coverage_threshold) {
      add("INCONSISTENT_CONTRACT", "$.coverage_score", "A non-abstained pack is below the policy coverage threshold.");
    }
  } else {
    add("INVALID_CONTRACT", "$.policy", "Expected a policy decision object.");
  }

  if (pack.verdict === "INSUFFICIENT_EVIDENCE" && pack.abstained !== true) {
    add("INCONSISTENT_CONTRACT", "$.abstained", "INSUFFICIENT_EVIDENCE requires abstained=true.");
  }
  if (pack.abstained === true && pack.verdict !== "INSUFFICIENT_EVIDENCE" && pack.verdict !== "MIXED") {
    add("INCONSISTENT_CONTRACT", "$.verdict", "An abstained ProofPack must use MIXED or INSUFFICIENT_EVIDENCE.");
  }
  if (Array.isArray(pack.evidence) && pack.evidence.length === 0 && (pack.abstained !== true || pack.verdict !== "INSUFFICIENT_EVIDENCE")) {
    add("INCONSISTENT_CONTRACT", "$.verdict", "A ProofPack with no evidence must abstain as INSUFFICIENT_EVIDENCE.");
  }

  if (!isRecord(pack.qarinah)) add("INVALID_CONTRACT", "$.qarinah", "Expected a Qarinah proof-chain object.");
  if (isRecord(pack.verification)) {
    const keys = ["schema_version", "algorithm", "canonicalization", "manifest_scope", "manifest_hash", "event_chain_head", "event_count"];
    checkKeys(pack.verification, keys, keys, "$.verification", add);
    if (pack.verification.schema_version !== PROOF_VERIFICATION_SCHEMA_VERSION) add("INVALID_CONTRACT", "$.verification.schema_version", "Unsupported verification schema version.");
    if (pack.verification.algorithm !== "SHA-256") add("INVALID_CONTRACT", "$.verification.algorithm", "Unsupported hash algorithm.");
    if (pack.verification.canonicalization !== "proofpack.canonical-json.v1") add("INVALID_CONTRACT", "$.verification.canonicalization", "Unsupported canonicalization algorithm.");
    if (pack.verification.manifest_scope !== "proofpack-without-verification") add("INVALID_CONTRACT", "$.verification.manifest_scope", "Unsupported manifest scope.");
    if (!isSha256Hash(pack.verification.manifest_hash)) add("INVALID_CONTRACT", "$.verification.manifest_hash", "Expected a lowercase SHA-256 hash.");
    if (!isSha256Hash(pack.verification.event_chain_head)) add("INVALID_CONTRACT", "$.verification.event_chain_head", "Expected a lowercase SHA-256 hash.");
    checkInteger(pack.verification.event_count, "$.verification.event_count", add);
    if (isRecord(pack.qarinah)) {
      if (pack.verification.event_chain_head !== pack.qarinah.head_hash) add("INVALID_CHAIN_METADATA", "$.verification.event_chain_head", "Verification head does not match Qarinah chain head.");
      if (pack.verification.event_count !== pack.qarinah.event_count) add("INVALID_CHAIN_METADATA", "$.verification.event_count", "Verification count does not match Qarinah chain count.");
    }
  } else {
    add("INVALID_CONTRACT", "$.verification", "Expected a verification object.");
  }
}

function validateProvenanceSemantics(pack: ProofPack, add: (code: VerificationErrorCode, path: string, message: string) => void) {
  const eventEvidence = new Map<string, Record<string, unknown>>();
  for (const event of pack.qarinah.events) {
    if (event.kind !== "source" || !isRecord(event.data) || !isRecord(event.data.evidence)) continue;
    const embedded = event.data.evidence;
    if (typeof embedded.id === "string") eventEvidence.set(embedded.id, embedded);
  }
  for (const evidence of pack.evidence) {
    const embedded = eventEvidence.get(evidence.id);
    if (!embedded) {
      add("INVALID_REFERENCE", "$.qarinah.events", `No Qarinah source event records evidence '${evidence.id}'.`);
    } else if (canonicalJson(embedded) !== canonicalJson(qarinahEvidenceProjection(evidence))) {
      add("INCONSISTENT_CONTRACT", "$.qarinah.events", `Qarinah source event for '${evidence.id}' does not match the sealed evidence record.`);
    }
  }

  const decision = [...pack.qarinah.events].reverse().find((event) => event.kind === "decision");
  if (!decision || !isRecord(decision.data)) {
    add("INVALID_REFERENCE", "$.qarinah.events", "Qarinah chain does not contain a decision event.");
    return;
  }
  if (decision.data.verdict !== pack.verdict || decision.data.confidence !== pack.confidence || decision.data.abstained !== pack.abstained) {
    add("INCONSISTENT_CONTRACT", "$.qarinah.events", "Qarinah decision event does not match the ProofPack decision.");
  }
}

/** Verifies hashes, Qarinah continuity, references, and contract invariants offline. */
export function verifyProofPack(value: unknown): ProofVerificationResult {
  const { errors, add } = verifier();
  if (!isRecord(value)) {
    add("INVALID_CONTRACT", "$", "ProofPack must be a plain JSON object.");
    return {
      valid: false,
      manifest_valid: false,
      evidence_hashes_valid: false,
      event_chain_valid: false,
      contract_valid: false,
      errors,
    };
  }

  validateContract(value, add);
  const contractErrorCountBeforeCrypto = errors.length;

  let manifestValid = false;
  if (isRecord(value.verification) && typeof value.verification.manifest_hash === "string") {
    try {
      const expected = buildManifestHash(value as unknown as ProofPack);
      manifestValid = expected === value.verification.manifest_hash;
      if (!manifestValid) add("INVALID_MANIFEST_HASH", "$.verification.manifest_hash", "Manifest hash does not match the canonical ProofPack payload.");
    } catch (error) {
      add("INVALID_MANIFEST_HASH", "$.verification.manifest_hash", error instanceof Error ? error.message : "Manifest could not be canonicalized.");
    }
  }

  let evidenceHashesValid = Array.isArray(value.evidence);
  if (Array.isArray(value.evidence)) {
    value.evidence.forEach((candidate, index) => {
      if (!isRecord(candidate) || typeof candidate.evidence_hash !== "string") {
        evidenceHashesValid = false;
        return;
      }
      try {
        const expected = buildEvidenceHash(candidate as unknown as EvidenceItem);
        if (expected !== candidate.evidence_hash) {
          evidenceHashesValid = false;
          add("INVALID_EVIDENCE_HASH", `$.evidence[${index}].evidence_hash`, "Evidence hash does not match the evidence record.");
        }
      } catch (error) {
        evidenceHashesValid = false;
        add("INVALID_EVIDENCE_HASH", `$.evidence[${index}].evidence_hash`, error instanceof Error ? error.message : "Evidence could not be canonicalized.");
      }
    });
  }

  let eventChainValid = false;
  if (isRecord(value.qarinah) && Array.isArray(value.qarinah.events)) {
    try {
      validateQarinahProofChain(value.qarinah as unknown as ProofPack["qarinah"]);
      eventChainValid = true;
      validateProvenanceSemantics(value as unknown as ProofPack, add);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Qarinah event chain is invalid.";
      const lower = message.toLowerCase();
      const code: VerificationErrorCode = lower.includes("continuity") || lower.includes("previoushash")
        ? "BROKEN_EVENT_CHAIN"
        : lower.includes("head_hash") || lower.includes("event_count")
          ? "INVALID_CHAIN_METADATA"
          : "INVALID_EVENT";
      add(code, "$.qarinah", message);
    }
  }

  const contractValid = contractErrorCountBeforeCrypto === 0
    && !errors.some((error) =>
      error.code === "INVALID_CONTRACT"
      || error.code === "INVALID_REFERENCE"
      || error.code === "INCONSISTENT_CONTRACT"
      || error.code === "INVALID_CHAIN_METADATA",
    );
  const valid = contractValid && manifestValid && evidenceHashesValid && eventChainValid && errors.length === 0;
  return {
    valid,
    manifest_valid: manifestValid,
    evidence_hashes_valid: evidenceHashesValid,
    event_chain_valid: eventChainValid,
    contract_valid: contractValid,
    errors,
  };
}
