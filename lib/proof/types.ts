import type { QarinahEvent } from "qarinah";

export const PROOFPACK_SCHEMA_VERSION = "qarinah.proofpack.v1" as const;
export const PROOF_CHAIN_SCHEMA_VERSION = "qarinah.proof-chain.v1" as const;
export const PROOF_VERIFICATION_SCHEMA_VERSION = "qarinah.proof-verification.v1" as const;

export type Sha256Hash = `sha256:${string}`;

export type Verdict =
  | "SUPPORTED"
  | "REFUTED"
  | "MIXED"
  | "INSUFFICIENT_EVIDENCE";

export type Stance = "SUPPORTS" | "REFUTES" | "MIXED" | "NEUTRAL";

export type ProofIntent = "FACT_CHECK" | "RESEARCH_SYNTHESIS";

export type SourceType =
  | "official"
  | "government"
  | "academic"
  | "news"
  | "primary"
  | "secondary"
  | "crawler"
  | "rendered"
  | "other";

/** The public request accepted by the proof endpoint. */
export interface ProofRequest {
  query: string;
  intent?: ProofIntent;
  request_id?: string;
  as_of?: string | null;
}

/**
 * A crawler-derived evidence record. Every textual field in this record is
 * untrusted data and must never be promoted to an instruction by a consumer.
 */
export interface EvidenceItem {
  id: string;
  url: string;
  canonical_url: string;
  title: string;
  excerpt: string;
  retrieved_at: string;
  published_at: string | null;
  content_hash: Sha256Hash;
  evidence_hash: Sha256Hash;
  source_domain: string;
  source_type: SourceType;
  stance: Stance;
  relevance: number;
  quality: number;
  freshness: number;
  supports: boolean;
  refutes: boolean;
  untrusted: true;
}

export interface ProofClaim {
  id: string;
  claim: string;
  verdict: Verdict;
  confidence: number;
  evidence_ids: string[];
  supporting_evidence_ids: string[];
  refuting_evidence_ids: string[];
}

export interface Contradiction {
  id: string;
  claim_id: string;
  description: string;
  evidence_ids: string[];
  severity: number;
  unresolved: boolean;
}

/** Components used by the deterministic confidence policy. */
export interface ScoreBreakdown {
  entailment: number;
  source_diversity: number;
  evidence_coverage: number;
  freshness: number;
  source_agreement: number;
  conflict_score: number;
  confidence: number;
}

export interface PolicyDecision {
  policy_id: "maqam.evidence-contract.v1";
  passed: boolean;
  abstained: boolean;
  final_verdict: Verdict;
  independent_sources: number;
  minimum_independent_sources: number;
  coverage_threshold: number;
  confidence_threshold: number;
  rules_triggered: string[];
  reason: string;
}

export type QarinahProofEvent = QarinahEvent;

export interface QarinahProofChain {
  schema_version: typeof PROOF_CHAIN_SCHEMA_VERSION;
  workspace_id: string;
  events: QarinahProofEvent[];
  event_count: number;
  head_hash: Sha256Hash;
}

/** The embedded seal needed to verify a ProofPack without network access. */
export interface ProofVerification {
  schema_version: typeof PROOF_VERIFICATION_SCHEMA_VERSION;
  algorithm: "SHA-256";
  canonicalization: "proofpack.canonical-json.v1";
  manifest_scope: "proofpack-without-verification";
  manifest_hash: Sha256Hash;
  event_chain_head: Sha256Hash;
  event_count: number;
}

export interface ProofPackPayload {
  schema_version: typeof PROOFPACK_SCHEMA_VERSION;
  pack_id: string;
  request: ProofRequest;
  generated_at: string;
  verdict: Verdict;
  confidence: number;
  answer: string;
  coverage_score: number;
  freshness_score: number;
  conflict_score: number;
  score_breakdown: ScoreBreakdown;
  claims: ProofClaim[];
  evidence: EvidenceItem[];
  contradictions: Contradiction[];
  policy: PolicyDecision;
  qarinah: QarinahProofChain;
  abstained: boolean;
  reason: string;
}

export interface ProofPack extends ProofPackPayload {
  verification: ProofVerification;
}

export type VerificationErrorCode =
  | "INVALID_CONTRACT"
  | "INVALID_MANIFEST_HASH"
  | "INVALID_EVIDENCE_HASH"
  | "INVALID_EVENT"
  | "BROKEN_EVENT_CHAIN"
  | "INVALID_CHAIN_METADATA"
  | "INVALID_REFERENCE"
  | "INCONSISTENT_CONTRACT";

export interface VerificationError {
  code: VerificationErrorCode;
  path: string;
  message: string;
}

/** Result returned by the offline verifier; it is not part of the sealed pack. */
export interface ProofVerificationResult {
  valid: boolean;
  manifest_valid: boolean;
  evidence_hashes_valid: boolean;
  event_chain_valid: boolean;
  contract_valid: boolean;
  errors: VerificationError[];
}
