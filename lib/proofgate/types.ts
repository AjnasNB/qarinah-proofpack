import type { QarinahEvent } from "qarinah";

import type { Sha256Hash } from "@/lib/proof/types";

export const PREFLIGHT_SCHEMA_VERSION = "proofgate.preflight.v1" as const;
export const PREFLIGHT_RECEIPT_SCHEMA_VERSION = "proofgate.receipt.v1" as const;
export const PROOFGATE_CHAIN_SCHEMA_VERSION = "qarinah.proofgate-chain.v1" as const;

export type PreflightDecision = "ALLOW" | "BLOCK" | "ESCALATE";
export type TelegraphIntent = "FACT_CHECK" | "RESEARCH_SYNTHESIS";
export type TelegraphRouteMode = "AUTO" | "DIRECT";
export type SignalStance = "SUPPORTS" | "REFUTES" | "UNCERTAIN";
export type ClaimVerdict = "SUPPORTED" | "REFUTED" | "UNCERTAIN" | "CONFLICTED";

export interface PreflightRequest {
  action: string;
  policy: string;
  claims?: string[];
  request_id?: string;
}

export interface CompiledPolicy {
  schema_version: "maqam.proofgate-policy.v1";
  source: string;
  min_confidence: number;
  min_distinct_miners: number;
  min_verified_signals: number;
  min_supporting_signals: number;
  max_conflict_score: number;
  require_all_claims_supported: true;
  block_on_credible_refutation: boolean;
  block_on_any_conflict: boolean;
  recognized_constraints: string[];
  unsupported_clauses: string[];
  policy_hash: Sha256Hash;
}

export interface ClaimAssessment {
  claim_id: string;
  claim: string;
  stance: SignalStance;
  confidence: number | null;
}

export interface TelegraphSignalReceipt {
  receipt_id: string;
  route_mode: TelegraphRouteMode;
  requested_intent: TelegraphIntent;
  intent: TelegraphIntent | null;
  miner_id: string;
  miner_slug: string;
  miner_name: string;
  rank_at_request: number | null;
  endpoint: string;
  cost_usd: number | null;
  timestamp: string | null;
  signal_hash: `0x${string}`;
  /** Official-node attestation bound to this exact query/miner/intent/result; not an independently recomputed Telegraph hash. */
  signal_verified: boolean;
  signal_verification: {
    status: "node_attested" | "rejected";
    authority: "telegraph-node";
    scope: "exact-query-miner-intent-result";
    locally_recomputed: false;
    algorithm: string | null;
    commitment: string | null;
    checked_at: string;
  };
  payment_response_hash: Sha256Hash | null;
  payment_settlement: {
    network: "eip155:84532";
    transaction: `0x${string}`;
    payer_hash: Sha256Hash;
    amount_micros: number | null;
  } | null;
  result_hash: Sha256Hash;
  signal_mapping: {
    confidence_field: string | null;
    label_field: string | null;
    reason_field: string | null;
  };
  confidence: number | null;
  label: string | null;
  reason: string | null;
  stance: SignalStance;
  claim_assessments: ClaimAssessment[];
  warnings: string[];
}

export interface PreflightClaimResult {
  id: string;
  claim: string;
  verdict: ClaimVerdict;
  confidence: number | null;
  supporting_signals: number;
  refuting_signals: number;
  uncertain_signals: number;
  signal_hashes: `0x${string}`[];
}

export interface PreflightRuleResult {
  id: string;
  label: string;
  passed: boolean;
  actual: number | string | boolean | null;
  required: number | string | boolean;
}

export interface PreflightAggregate {
  /** Mean mapped confidence from distinct Miners aligned with the dominant stance; never model-generated. */
  confidence: number | null;
  supporting_signals: number;
  refuting_signals: number;
  uncertain_signals: number;
  distinct_miners: number;
  verified_signals: number;
  conflict_score: number;
  total_cost_usd: number;
}

export interface ProofGateQarinahChain {
  schema_version: typeof PROOFGATE_CHAIN_SCHEMA_VERSION;
  workspace_id: string;
  events: QarinahEvent[];
  event_count: number;
  head_hash: Sha256Hash;
}

export interface PreflightReceipt {
  schema_version: typeof PREFLIGHT_RECEIPT_SCHEMA_VERSION;
  algorithm: "SHA-256";
  canonicalization: "proofgate.canonical-json.v1";
  scope: "preflight-without-receipt";
  root_hash: Sha256Hash;
  qarinah_head_hash: Sha256Hash;
  telegraph_signal_hashes: `0x${string}`[];
  integrity: {
    status: "self_hash_consistent";
    authenticity: "unsigned";
    transferable_authorization: false;
  };
}

export interface PreflightOperationalStatus {
  telegraph_configured: boolean;
  paid_calls_attempted: number;
  paid_calls_succeeded: number;
}

export interface PreflightResponsePayload {
  schema_version: typeof PREFLIGHT_SCHEMA_VERSION;
  action_id: string;
  generated_at: string;
  decision: PreflightDecision;
  authorization_issued: boolean;
  action: string;
  claims: PreflightClaimResult[];
  compiled_policy: CompiledPolicy;
  aggregate: PreflightAggregate;
  rules: PreflightRuleResult[];
  signals: TelegraphSignalReceipt[];
  qarinah: ProofGateQarinahChain;
  reason: string;
  reason_codes: string[];
  operational: PreflightOperationalStatus;
}

export interface PreflightResponse extends PreflightResponsePayload {
  receipt: PreflightReceipt;
}

export interface TelegraphMinerEndpoint {
  path: string;
  method: string;
  description?: string;
}

export interface TelegraphMinerScore {
  intent_id: string;
  rank: number;
  score?: number;
  epoch_id?: number;
  scored_at?: string;
}

export interface TelegraphJsonSchema {
  type?: string;
  properties?: Record<string, Record<string, unknown>>;
  required?: string[];
}

export interface TelegraphMiner {
  id: string;
  slug: string;
  name: string;
  description?: string;
  endpoints: TelegraphMinerEndpoint[];
  input_schema: TelegraphJsonSchema | null;
  output_schema?: TelegraphJsonSchema | null;
  signal_mapping?: {
    confidence_field?: string;
    label_field?: string;
    reason_field?: string;
  } | null;
  supported_intents: string[];
  activation_status: string;
  min_price_usdc?: number;
  scores?: TelegraphMinerScore[];
}

export interface TelegraphAskResult {
  miner_id: string;
  miner_name: string;
  endpoint?: string;
  result: unknown;
  cost_usd?: number;
  duration_ms?: number;
  timestamp?: string;
  reasoning?: string;
  intent?: string;
  signal_hash?: string;
  warnings?: unknown[];
  payment_response?: string | null;
  payment_settlement?: {
    network: "eip155:84532";
    transaction: `0x${string}`;
    payer_hash: Sha256Hash;
    amount_micros: number | null;
  };
}

export interface TelegraphSignalLookup {
  signal_hash?: string;
  signal?: Record<string, unknown>;
  payload?: Record<string, unknown>;
  result?: Record<string, unknown>;
  verification?: {
    algorithm?: string;
    commitment?: string;
    verified?: boolean;
  };
}

export interface TelegraphClient {
  readonly configured: boolean;
  discoverMiners(options?: { signal?: AbortSignal }): Promise<TelegraphMiner[]>;
  askAuto(query: string, options?: { signal?: AbortSignal }): Promise<TelegraphAskResult>;
  askDirect(
    miner: TelegraphMiner,
    intent: TelegraphIntent,
    query: string,
    options?: { signal?: AbortSignal },
  ): Promise<TelegraphAskResult>;
  verifySignal(signalHash: string, options?: { signal?: AbortSignal }): Promise<TelegraphSignalLookup>;
}
