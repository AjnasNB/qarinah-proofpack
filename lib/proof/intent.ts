import type { ProofIntent } from "./types";

const RESEARCH_SYNTHESIS_PATTERNS = [
  /^\s*(?:research|summari[sz]e|synthesi[sz]e|compare|contrast|analy[sz]e|survey)\b/iu,
  /\b(?:research synthesis|literature review|state of (?:the )?(?:evidence|research)|evidence landscape|key findings|areas of agreement|areas of disagreement|pros and cons)\b/iu,
  /\b(?:compare|contrast)\b.+\b(?:with|versus|vs\.?)\b/iu,
];

/**
 * Telegraph's HTTP request builder supplies an explicit intent through the
 * Miner parameter contract. On-chain callers may omit that optional second
 * string, so this conservative fallback recognizes only clear synthesis
 * language and otherwise keeps the primary FACT_CHECK behavior.
 */
export function inferProofIntent(query: string): ProofIntent {
  const normalized = query.normalize("NFKC").replace(/\s+/gu, " ").trim();
  return RESEARCH_SYNTHESIS_PATTERNS.some((pattern) => pattern.test(normalized))
    ? "RESEARCH_SYNTHESIS"
    : "FACT_CHECK";
}
