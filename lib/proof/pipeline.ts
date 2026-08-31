import { randomUUID } from "node:crypto";
import { getDomain } from "tldts";
import { acquireSources, type AcquisitionResult } from "./acquire";
import { hashText, isSha256Hash, sealEvidenceItem } from "./canonical";
import { extractEvidence, type EvidenceCandidate } from "./extract";
import { applyProofPolicy } from "./policy";
import { createQarinahProofChain } from "./qarinah-chain";
import { scoreEvidence, type DeterministicScore, type ScoredCandidate } from "./scoring";
import { discoverSources, type SearchDiscovery } from "./search";
import { synthesizeAnswer } from "./synthesis";
import {
  PROOFPACK_SCHEMA_VERSION,
  type Contradiction,
  type EvidenceItem,
  type PolicyDecision,
  type ProofClaim,
  type ProofPack,
  type ProofPackPayload,
  type ProofRequest,
  type Sha256Hash,
  type SourceType,
  type Stance,
} from "./types";
import { sealProofPack, verifyProofPack } from "./verify";

const NEWS_DOMAINS = new Set([
  "aljazeera.com",
  "apnews.com",
  "bbc.co.uk",
  "bbc.com",
  "bloomberg.com",
  "cnn.com",
  "npr.org",
  "reuters.com",
  "theguardian.com",
  "nytimes.com",
]);

const ACADEMIC_DOMAINS = new Set([
  "arxiv.org",
  "doi.org",
  "jstor.org",
  "nature.com",
  "ncbi.nlm.nih.gov",
  "pubmed.ncbi.nlm.nih.gov",
  "sciencedirect.com",
  "springer.com",
]);

export interface ProofPipelineDiagnostics {
  discovery: SearchDiscovery | null;
  acquisition: AcquisitionResult | null;
  acquisition_error: string | null;
  synthesis_method: "deterministic" | "openai";
  synthesis_model: string | null;
}

export interface BuildProofPackOptions {
  signal?: AbortSignal;
  evidence?: readonly EvidenceCandidate[];
  onDiagnostics?: (diagnostics: ProofPipelineDiagnostics) => void;
}

function rounded(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 10_000) / 10_000;
}

function sourceType(candidate: EvidenceCandidate): SourceType {
  const host = new URL(candidate.canonical).hostname.toLowerCase();
  const domain = getDomain(host) ?? host;
  if (host.endsWith(".gov") || host.includes(".gov.") || host.endsWith(".mil")) return "government";
  if (host.endsWith(".edu") || host.includes(".edu.") || host.includes(".ac.")) return "academic";
  if (ACADEMIC_DOMAINS.has(domain)) return "academic";
  if (NEWS_DOMAINS.has(domain)) return "news";
  return candidate.sourceType;
}

function publicStance(stance: ScoredCandidate["stance"]): Stance {
  if (stance === "SUPPORT") return "SUPPORTS";
  if (stance === "REFUTE") return "REFUTES";
  return "NEUTRAL";
}

function evidenceItems(
  candidates: readonly EvidenceCandidate[],
  score: DeterministicScore,
): EvidenceItem[] {
  return score.evidence.map((scored, index) => {
    const source = candidates.find((candidate) => (
      candidate.url === scored.url && candidate.excerpt === scored.excerpt
    ));
    if (!source) throw new TypeError("A scored passage lost its acquisition provenance.");
    const stance = publicStance(scored.stance);
    const contentHash: Sha256Hash = isSha256Hash(source.contentHash)
      ? source.contentHash
      : hashText(source.excerpt);
    return sealEvidenceItem({
      id: `EV-${String(index + 1).padStart(3, "0")}`,
      url: source.url,
      canonical_url: source.canonical,
      title: source.title.replace(/\s+/g, " ").trim().slice(0, 1_024),
      excerpt: source.excerpt.replace(/\s+/g, " ").trim().slice(0, 16_384),
      retrieved_at: new Date(source.retrievedAt).toISOString(),
      published_at: source.publishedAt ? new Date(source.publishedAt).toISOString() : null,
      content_hash: contentHash,
      source_domain: source.domain,
      source_type: sourceType(source),
      stance,
      relevance: rounded(scored.relevance),
      quality: rounded(scored.quality),
      freshness: rounded(scored.freshness),
      supports: stance === "SUPPORTS",
      refutes: stance === "REFUTES",
      untrusted: true,
    });
  });
}

function proofClaim(
  request: ProofRequest,
  evidence: readonly EvidenceItem[],
  score: DeterministicScore,
  verdict: ProofClaim["verdict"],
): ProofClaim {
  return {
    id: "CL-001",
    claim: request.query,
    verdict,
    confidence: score.confidence,
    evidence_ids: evidence.map((item) => item.id),
    supporting_evidence_ids: evidence.filter((item) => item.supports).map((item) => item.id),
    refuting_evidence_ids: evidence.filter((item) => item.refutes).map((item) => item.id),
  };
}

function contradictions(
  claim: ProofClaim,
  score: DeterministicScore,
): Contradiction[] {
  if (!claim.supporting_evidence_ids.length || !claim.refuting_evidence_ids.length) return [];
  return [{
    id: "CX-001",
    claim_id: claim.id,
    description: "Independent evidence records materially support and refute the same claim.",
    evidence_ids: [claim.supporting_evidence_ids[0], claim.refuting_evidence_ids[0]],
    severity: score.conflictScore,
    unresolved: true,
  }];
}

function policyDecision(
  score: DeterministicScore,
  policy: ReturnType<typeof applyProofPolicy>,
): PolicyDecision {
  return {
    policy_id: "maqam.evidence-contract.v1",
    passed: !policy.abstained,
    abstained: policy.abstained,
    final_verdict: policy.verdict,
    independent_sources: score.independentSources,
    minimum_independent_sources: policy.thresholds.minimumIndependentSources,
    coverage_threshold: policy.thresholds.minimumCoverage,
    confidence_threshold: policy.thresholds.minimumConfidence,
    rules_triggered: policy.reasonCodes,
    reason: policy.reason,
  };
}

async function acquireEvidence(
  query: string,
  signal: AbortSignal | undefined,
): Promise<{
  candidates: EvidenceCandidate[];
  discovery: SearchDiscovery | null;
  acquisition: AcquisitionResult | null;
  error: string | null;
}> {
  try {
    const discovery = await discoverSources(query, { maxResults: 12, signal });
    const acquisition = await acquireSources(discovery.results, { maxPages: 10, signal });
    const candidates = extractEvidence(query, acquisition.pages, { maxEvidence: 15 });
    return { candidates, discovery, acquisition, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Live evidence acquisition failed.";
    return { candidates: [], discovery: null, acquisition: null, error: message.slice(0, 500) };
  }
}

/**
 * Runs the complete acquisition, scoring, policy, synthesis, provenance, and
 * verification pipeline. Network failure produces a sealed abstention pack.
 */
export async function buildProofPack(
  request: ProofRequest,
  options: BuildProofPackOptions = {},
): Promise<ProofPack> {
  const generatedAt = new Date().toISOString();
  const packId = `pp_${randomUUID()}`;
  const acquired = options.evidence
    ? { candidates: [...options.evidence], discovery: null, acquisition: null, error: null }
    : await acquireEvidence(request.query, options.signal);

  const score = scoreEvidence(request.query, acquired.candidates);
  const policy = applyProofPolicy(score);
  const evidence = evidenceItems(acquired.candidates, score);
  const claim = proofClaim(request, evidence, score, policy.verdict);
  const conflicts = contradictions(claim, score);
  const synthesis = await synthesizeAnswer({
    query: request.query,
    verdict: policy.verdict,
    reason: policy.reason,
    confidence: score.confidence,
    evidence: score.evidence,
    signal: options.signal,
  });
  const decision = policyDecision(score, policy);
  const scoreBreakdown = {
    entailment: score.entailment,
    source_diversity: score.sourceDiversity,
    evidence_coverage: score.evidenceCoverage,
    freshness: score.freshness,
    source_agreement: score.sourceAgreement,
    conflict_score: score.conflictScore,
    confidence: score.confidence,
  };
  const qarinah = createQarinahProofChain({
    pack_id: packId,
    generated_at: generatedAt,
    request,
    verdict: policy.verdict,
    confidence: score.confidence,
    score_breakdown: scoreBreakdown,
    claims: [claim],
    evidence,
    contradictions: conflicts,
    policy: decision,
    abstained: policy.abstained,
    reason: synthesis.reason,
  });
  const payload: ProofPackPayload = {
    schema_version: PROOFPACK_SCHEMA_VERSION,
    pack_id: packId,
    request,
    generated_at: generatedAt,
    verdict: policy.verdict,
    confidence: score.confidence,
    answer: synthesis.answer,
    coverage_score: score.evidenceCoverage,
    freshness_score: score.freshness,
    conflict_score: score.conflictScore,
    score_breakdown: scoreBreakdown,
    claims: [claim],
    evidence,
    contradictions: conflicts,
    policy: decision,
    qarinah,
    abstained: policy.abstained,
    reason: synthesis.reason,
  };
  const pack = sealProofPack(payload);
  const verification = verifyProofPack(pack);
  if (!verification.valid) {
    throw new TypeError(`ProofPack self-verification failed: ${verification.errors[0]?.message ?? "unknown error"}`);
  }

  options.onDiagnostics?.({
    discovery: acquired.discovery,
    acquisition: acquired.acquisition,
    acquisition_error: acquired.error,
    synthesis_method: synthesis.method,
    synthesis_model: synthesis.model,
  });
  return pack;
}
