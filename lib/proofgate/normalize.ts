import { canonicalJson, hashCanonical, hashText } from "@/lib/proof/canonical";

import { claimId } from "./claims";
import type {
  ClaimAssessment,
  SignalStance,
  TelegraphAskResult,
  TelegraphIntent,
  TelegraphMiner,
  TelegraphRouteMode,
  TelegraphSignalLookup,
  TelegraphSignalReceipt,
} from "./types";

const SIGNAL_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const UNCERTAIN_PATTERN = /\b(?:mixed|uncertain|unknown|insufficient|inconclusive|ambiguous|unverified)\b/i;
const REFUSAL_PATTERN = /(?:\b(?:cannot|can['’]?t|could\s+not|unable\s+to)\s+(?:independently\s+)?(?:verify|confirm|determine|establish|find)\b|\b(?:no|not\s+enough|insufficient|inadequate|limited|without)\s+(?:clear\s+|credible\s+|reliable\s+|sufficient\s+)?(?:evidence|information|support|sources?|confirmation)\b|\b(?:evidence|information|support|sources?)\s+(?:is|are)\s+(?:insufficient|inconclusive|unclear|unavailable)\b)/i;
const ABSENT_SUPPORT_PATTERN = /(?:\b(?:do|does|did|is|are|was|were|has|have|had)\s+not\s+(?:support|supported|verify|verified|confirm|confirmed|substantiate|substantiated)\b|\bnot\s+(?:supported|verified|confirmed|substantiated)\b|\bunsupported\b)/i;
const NEGATED_TRUTH_PATTERN = /\b(?:not|isn['’]?t|wasn['’]?t|aren['’]?t|weren['’]?t)\s+(?:true|correct)\b/i;
const NEGATED_REFUTATION_PATTERN = /\b(?:not|isn['’]?t|wasn['’]?t|aren['’]?t|weren['’]?t)\s+(?:refuted|false|incorrect|debunked|contradicted)\b/i;
const STOP_WORDS = new Set([
  "the", "and", "that", "this", "with", "from", "into", "for", "are", "was", "were", "will", "has", "have",
  "had", "did", "does", "its", "their", "about", "claim", "true", "whether", "what", "when", "where", "which",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readPath(value: unknown, path: string | undefined): unknown {
  if (!path) return undefined;
  return path.split(".").reduce<unknown>((current, segment) => {
    const record = asRecord(current);
    return record ? record[segment] : undefined;
  }, value);
}

function boundedText(value: unknown, maximum = 2_000): string | null {
  if (value === undefined || value === null) return null;
  let text: string;
  if (typeof value === "string") text = value;
  else if (typeof value === "number" || typeof value === "boolean") text = String(value);
  else {
    try {
      text = canonicalJson(value);
    } catch {
      return null;
    }
  }
  const normalized = text.normalize("NFKC").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.slice(0, maximum);
}

function normalizeConfidence(value: unknown): number | null {
  let number: number;
  if (typeof value === "number") number = value;
  else if (typeof value === "string") {
    const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(%)?$/);
    if (!match) return null;
    number = Number(match[1]);
    if (match[2]) number /= 100;
  } else return null;
  if (!Number.isFinite(number) || number < 0) return null;
  if (number > 1 && number <= 100) number /= 100;
  return number <= 1 ? Math.round(number * 10_000) / 10_000 : null;
}

function tokens(value: string): string[] {
  return (value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token));
}

function overlap(claim: string, evidence: string): number {
  const expected = new Set(tokens(claim));
  if (expected.size === 0) return 0;
  const actual = new Set(tokens(evidence));
  return [...expected].filter((token) => actual.has(token)).length / expected.size;
}

/** Conservative stance inference from a miner-declared label/reason. */
export function inferSignalStance(label: string | null, _reason: string | null, claim: string): SignalStance {
  // Kept in the public signature for callers that already provide context;
  // neither free-form rationale nor claim echoing may create direction.
  void _reason;
  void claim;
  const primary = (label ?? "").trim();
  // A reason is explanatory data, not a declared verdict. It may simply echo
  // the request or explain an abstention, so it never supplies direction alone.
  if (!primary) return "UNCERTAIN";

  if (REFUSAL_PATTERN.test(primary) || ABSENT_SUPPORT_PATTERN.test(primary) || UNCERTAIN_PATTERN.test(primary)) return "UNCERTAIN";
  if (NEGATED_REFUTATION_PATTERN.test(primary)) return "UNCERTAIN";
  if (NEGATED_TRUTH_PATTERN.test(primary)) return "REFUTES";

  const explicit = primary.toLowerCase().match(/^\s*(?:(?:the\s+)?claim\s+(?:is|was)\s+)?(supported|true|verified|confirmed|correct|refuted|false|incorrect|debunked|mixed|uncertain|unknown|insufficient|inconclusive|yes|no)\b/)?.[1];
  if (explicit) {
    if (["refuted", "false", "incorrect", "debunked", "no"].includes(explicit)) return "REFUTES";
    if (["supported", "true", "verified", "confirmed", "correct", "yes"].includes(explicit)) return "SUPPORTS";
    return "UNCERTAIN";
  }
  return "UNCERTAIN";
}

function structuredClaimAssessments(result: unknown, claims: string[]): ClaimAssessment[] | null {
  const record = asRecord(result);
  if (!record || !Array.isArray(record.claims)) return null;
  const parsed = record.claims.flatMap((entry) => {
    const claimRecord = asRecord(entry);
    if (!claimRecord) return [];
    const text = boundedText(claimRecord.claim ?? claimRecord.text, 1_024);
    const verdict = boundedText(claimRecord.verdict ?? claimRecord.stance ?? claimRecord.label, 100);
    if (!text || !verdict) return [];
    const confidence = normalizeConfidence(claimRecord.confidence);
    return [{ text, verdict, confidence }];
  });
  if (parsed.length === 0) return null;

  return claims.map((claim, index) => {
    const best = parsed
      .map((entry) => ({ ...entry, overlap: overlap(claim, entry.text) }))
      .sort((left, right) => right.overlap - left.overlap)[0];
    const stance = best && best.overlap >= 0.6
      ? inferSignalStance(best.verdict, best.text, claim)
      : "UNCERTAIN";
    return { claim_id: claimId(claim, index), claim, stance, confidence: best?.confidence ?? null };
  });
}

function rankAtRequest(miner: TelegraphMiner | undefined, intent: TelegraphIntent): number | null {
  const rank = miner?.scores?.find((score) => score.intent_id === intent)?.rank;
  return typeof rank === "number" && Number.isInteger(rank) && rank >= 0 ? rank : null;
}

function normalizedTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim() || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function verifiedLookup(
  lookup: TelegraphSignalLookup,
  ask: TelegraphAskResult,
  miner: TelegraphMiner | undefined,
  resultHash: string,
  expectedQuery: string,
  expectedIntent: TelegraphIntent | null,
): boolean {
  if (!ask.signal_hash || lookup.signal_hash?.toLowerCase() !== ask.signal_hash.toLowerCase()) return false;
  if (lookup.verification?.verified !== true
    || lookup.verification.algorithm?.toLowerCase() !== "keccak256"
    || lookup.verification.commitment !== "payload") return false;
  const signal = asRecord(lookup.signal);
  if (signal === null || !(typeof signal.subnet_id === "string" || typeof signal.subnet_id === "number")) return false;
  if (String(signal.subnet_id) !== ask.miner_id) return false;
  if (typeof signal.miner_slug !== "string" || signal.miner_slug !== (miner?.slug ?? ask.miner_name)) return false;
  if (expectedIntent === null || signal.intent_id !== expectedIntent) return false;

  const payload = asRecord(lookup.payload);
  if (payload === null
    || payload.request !== expectedQuery
    || String(payload.subnet_id) !== ask.miner_id
    || payload.miner_slug !== (miner?.slug ?? ask.miner_name)
    || payload.intent_id !== expectedIntent
    || payload.response === undefined) return false;
  try {
    return hashCanonical(payload.response) === resultHash;
  } catch {
    return false;
  }
}

function canonicalIntent(value: string | undefined, fallback: TelegraphIntent): TelegraphIntent | null {
  if (value === "FACT_CHECK" || value === "RESEARCH_SYNTHESIS") return value;
  return value === undefined ? fallback : null;
}

export interface NormalizeReceiptInput {
  ask: TelegraphAskResult;
  lookup: TelegraphSignalLookup;
  miner?: TelegraphMiner;
  routeMode: TelegraphRouteMode;
  requestedIntent: TelegraphIntent;
  claims: string[];
  expectedQuery: string;
  checkedAt: string;
}

export function normalizeSignalReceipt(input: NormalizeReceiptInput): TelegraphSignalReceipt | null {
  const { ask, lookup, miner, routeMode, requestedIntent, claims, expectedQuery, checkedAt } = input;
  if (!ask.signal_hash || !SIGNAL_HASH_PATTERN.test(ask.signal_hash)) return null;
  const signalHash = ask.signal_hash as `0x${string}`;
  const resultHash = hashCanonical(ask.result);
  const mapping = miner?.signal_mapping ?? null;
  const label = boundedText(readPath(ask.result, mapping?.label_field));
  const reason = boundedText(readPath(ask.result, mapping?.reason_field));
  const confidence = normalizeConfidence(readPath(ask.result, mapping?.confidence_field));
  const structured = structuredClaimAssessments(ask.result, claims);
  const claimAssessments = structured ?? claims.map((claim, index) => ({
    claim_id: claimId(claim, index),
    claim,
    stance: inferSignalStance(label, reason, claim),
    confidence,
  }));
  const stances = new Set(claimAssessments.map((assessment) => assessment.stance));
  const stance: SignalStance = stances.size === 1 ? [...stances][0] : "UNCERTAIN";
  const intent = canonicalIntent(ask.intent, requestedIntent);
  const verified = verifiedLookup(lookup, ask, miner, resultHash, expectedQuery, intent);
  const timestamp = normalizedTimestamp(ask.timestamp)
    ?? normalizedTimestamp(asRecord(asRecord(lookup.result)?.execution)?.timestamp);
  const warningTexts = (ask.warnings ?? [])
    .map((warning) => boundedText(warning, 300))
    .filter((warning): warning is string => warning !== null)
    .slice(0, 8);

  return {
    receipt_id: `TG-${hashText(signalHash).slice("sha256:".length, "sha256:".length + 16)}`,
    route_mode: routeMode,
    requested_intent: requestedIntent,
    intent,
    miner_id: ask.miner_id,
    miner_slug: miner?.slug ?? ask.miner_name,
    miner_name: miner?.name ?? ask.miner_name,
    rank_at_request: rankAtRequest(miner, intent ?? requestedIntent),
    endpoint: ask.endpoint ?? "",
    cost_usd: typeof ask.cost_usd === "number" && Number.isFinite(ask.cost_usd) && ask.cost_usd >= 0 ? ask.cost_usd : null,
    timestamp,
    signal_hash: signalHash,
    signal_verified: verified,
    signal_verification: {
      algorithm: lookup.verification?.algorithm ?? null,
      commitment: lookup.verification?.commitment ?? null,
      checked_at: checkedAt,
    },
    payment_response_hash: ask.payment_response ? hashText(ask.payment_response) : null,
    result_hash: resultHash,
    signal_mapping: {
      confidence_field: mapping?.confidence_field ?? null,
      label_field: mapping?.label_field ?? null,
      reason_field: mapping?.reason_field ?? null,
    },
    confidence,
    label,
    reason,
    stance,
    claim_assessments: claimAssessments,
    warnings: warningTexts,
  };
}
