import { hashCanonical } from "@/lib/proof/canonical";

import type { CompiledPolicy } from "./types";

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
};

function boundedInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = NUMBER_WORDS[value.toLowerCase()] ?? Number(value);
  return Number.isInteger(parsed) ? Math.min(3, Math.max(1, parsed)) : fallback;
}

function parsedRatio(value: string | undefined, isPercent: boolean): number | null {
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  if (isPercent) return parsed <= 100 ? parsed / 100 : null;
  if (parsed <= 1) return parsed;
  return parsed <= 100 ? parsed / 100 : null;
}

function clauseKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b(?:only\s+allow\s+(?:if|when)|allow\s+only\s+(?:if|when)|otherwise|require|requires|required|must\s+have|must\s+use|please)\b/g, " ")
    .replace(/[^a-z0-9%<>=.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function recognizesClause(clause: string): boolean {
  const normalized = clauseKey(clause);
  if (!normalized) return true;

  const confidence = normalized.match(/^(?:(?:decision|mapped\s+provider)\s+)?confidence\s*(?:of\s*)?(?:(?:is|must\s+be)\s*)?(?:at\s+least|>=|minimum|min)?\s*(\d+(?:\.\d+)?)\s*(%)?$/);
  if (confidence) return parsedRatio(confidence[1], Boolean(confidence[2])) !== null;
  const conflict = normalized.match(/^conflict\s*(?:score)?\s*(?:at\s+most|<=|maximum|max)\s*(\d+(?:\.\d+)?)\s*(%)?$/);
  if (conflict) return parsedRatio(conflict[1], Boolean(conflict[2])) !== null;

  return [
    /^(?:at\s+least\s+)?(?:one|two|three|[1-3])\s+(?:(?:verified|independent|distinct|telegraph|supporting)\s+)*(?:miners?|sources?|signals?)(?:\s+(?:must\s+)?support\s+(?:the\s+)?claims?)?$/,
    /^(?:there\s+(?:is|are)\s+)?(?:no|zero|without)\s+(?:(?:material|unresolved|conflicting)\s+)*(?:conflicts?|contradictions?|refutations?)$/,
    /^all\s+(?:required\s+)?claims?\s+(?:are\s+|must\s+be\s+)?supported$/,
    /^block\s+(?:if|on)\s+(?:any\s+)?(?:credible\s+)?(?:claim\s+(?:is\s+)?)?(?:refuted|refutation|contradicted|contradiction|conflict)$/,
    /^escalate\s+(?:if|on)\s+(?:uncertain|insufficient|conflict|low\s+confidence|failure)$/,
    /^escalate\s+to\s+(?:a\s+)?human\s+(?:review|reviewer)$/,
  ].some((pattern) => pattern.test(normalized));
}

/** Compile a deliberately small natural-language policy grammar. */
export function compilePolicy(source: string): CompiledPolicy {
  const normalized = source.normalize("NFKC").replace(/\s+/g, " ").trim();
  let minConfidence = 0.7;
  let minDistinctMiners = 2;
  let minVerifiedSignals = 2;
  let minSupportingSignals = 2;
  let maxConflictScore = 0;
  let blockOnCredibleRefutation = true;
  let blockOnAnyConflict = false;
  const recognized = new Set<string>();

  const confidence = normalized.match(/(?:(?:decision|mapped\s+provider)\s+)?confidence\s*(?:of\s*)?(?:(?:is|must\s+be)\s*)?(?:at\s+least|>=|minimum|min)?\s*(\d+(?:\.\d+)?)\s*(%)?/i);
  if (confidence) {
    const parsed = parsedRatio(confidence[1], Boolean(confidence[2]));
    if (parsed !== null) {
      minConfidence = parsed;
      recognized.add("MIN_CONFIDENCE");
    }
  }

  const distinct = normalized.match(/(?:at\s+least\s+)?(one|two|three|[1-3])\s+(?:(?:verified|telegraph)\s+)*(?:(?:independent|distinct)\s+)?(?:miners?|sources?)/i);
  if (distinct) {
    minDistinctMiners = boundedInteger(distinct[1], minDistinctMiners);
    recognized.add("MIN_DISTINCT_MINERS");
  }

  const verified = normalized.match(/(?:at\s+least\s+)?(one|two|three|[1-3])\s+(?:(?:independent|distinct|telegraph)\s+)*verified\s+signals?/i)
    ?? normalized.match(/(?:at\s+least\s+)?(one|two|three|[1-3])\s+(?:telegraph\s+)?signals?/i);
  if (verified) {
    minVerifiedSignals = boundedInteger(verified[1], minVerifiedSignals);
    recognized.add("MIN_VERIFIED_SIGNALS");
  }

  const supporting = normalized.match(/(?:at\s+least\s+)?(one|two|three|[1-3])\s+(?:(?:verified|independent|distinct|telegraph)\s+)*supporting\s+(?:miners?|sources?|signals?)/i);
  const supportingMiners = normalized.match(/(?:at\s+least\s+)?(one|two|three|[1-3])\s+(?:(?:verified|telegraph)\s+)*(?:(?:independent|distinct)\s+)?miners?\s+(?:must\s+)?support\s+(?:the\s+)?claims?/i);
  if (supporting || supportingMiners) {
    minSupportingSignals = boundedInteger((supporting ?? supportingMiners)?.[1], minSupportingSignals);
    recognized.add("MIN_SUPPORTING_SIGNALS");
  }

  const conflictLimit = normalized.match(/conflict\s*(?:score)?\s*(?:at\s+most|<=|maximum|max)\s*(\d+(?:\.\d+)?)\s*(%)?/i);
  if (conflictLimit) {
    const parsed = parsedRatio(conflictLimit[1], Boolean(conflictLimit[2]));
    if (parsed !== null) {
      maxConflictScore = parsed;
      recognized.add("MAX_CONFLICT_SCORE");
    }
  } else if (/(?:no|zero|without)\s+(?:(?:material|unresolved|conflicting)\s+)*(?:conflicts?|contradictions?)/i.test(normalized)) {
    maxConflictScore = 0;
    recognized.add("MAX_CONFLICT_SCORE");
  }

  if (/block\s+(?:if|on)\s+(?:any\s+)?(?:credible\s+)?(?:claim\s+(?:is\s+)?)?(?:refuted|refutation|contradicted|contradiction)/i.test(normalized)) {
    blockOnCredibleRefutation = true;
    recognized.add("BLOCK_ON_REFUTATION");
  }
  if (/block\s+(?:if|on)\s+(?:any\s+)?(?:material\s+)?conflict/i.test(normalized)) {
    blockOnAnyConflict = true;
    recognized.add("BLOCK_ON_CONFLICT");
  }
  if (/all\s+(?:required\s+)?claims?\s+(?:are\s+|must\s+be\s+)?supported/i.test(normalized)) {
    recognized.add("ALL_CLAIMS_SUPPORTED");
  }

  const clauses = normalized
    .split(/\s*(?:[;,\n]|\.(?:\s|$)|\band\b)\s*/i)
    .map((clause) => clause.trim())
    .filter(Boolean);
  const unsupportedClauses = clauses.filter((clause) => !recognizesClause(clause)).slice(0, 8);

  if (recognized.size === 0 && normalized) {
    unsupportedClauses.splice(0, unsupportedClauses.length, normalized);
  }

  const withoutHash = {
    schema_version: "maqam.proofgate-policy.v1" as const,
    source: normalized,
    min_confidence: minConfidence,
    min_distinct_miners: minDistinctMiners,
    min_verified_signals: minVerifiedSignals,
    min_supporting_signals: minSupportingSignals,
    max_conflict_score: maxConflictScore,
    require_all_claims_supported: true as const,
    block_on_credible_refutation: blockOnCredibleRefutation,
    block_on_any_conflict: blockOnAnyConflict,
    recognized_constraints: [...recognized].sort(),
    unsupported_clauses: unsupportedClauses,
  };

  return { ...withoutHash, policy_hash: hashCanonical(withoutHash) };
}
