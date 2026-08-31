import { hashCanonical } from "@/lib/proof/canonical";
import { PolicyEngine, type PolicyDecision as MaqamPolicyDecision } from "maqam";

import { buildFactCheckQuery, claimId, extractClaims, normalizePreflightText } from "./claims";
import { normalizeSignalReceipt } from "./normalize";
import { compilePolicy } from "./policy";
import { createProofGateChain, validateProofGateChain } from "./qarinah-chain";
import {
  createTelegraphClient,
  selectDirectMiners,
  TelegraphClientError,
} from "./telegraph";
import type {
  ClaimAssessment,
  PreflightAggregate,
  PreflightClaimResult,
  PreflightDecision,
  PreflightOperationalStatus,
  PreflightRequest,
  PreflightResponse,
  PreflightResponsePayload,
  PreflightRuleResult,
  SignalStance,
  TelegraphAskResult,
  TelegraphClient,
  TelegraphIntent,
  TelegraphMiner,
  TelegraphRouteMode,
  TelegraphSignalReceipt,
} from "./types";
import {
  PREFLIGHT_RECEIPT_SCHEMA_VERSION,
  PREFLIGHT_SCHEMA_VERSION,
} from "./types";

const DEFAULT_MAX_PAID_CALLS = 3;

export interface BuildPreflightOptions {
  client?: TelegraphClient;
  maqamPolicyEngine?: MaqamPolicyAuthorizer;
  maximumPaidCalls?: number;
  signal?: AbortSignal;
  now?: () => Date;
}

export function resolveMaximumPaidCalls(
  value: string | number | undefined = process.env.PROOFGATE_MAX_CALLS,
): number {
  if (value === undefined || value === "") return DEFAULT_MAX_PAID_CALLS;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 3) {
    throw new TypeError("PROOFGATE_MAX_CALLS must be an integer from 1 through 3.");
  }
  return parsed;
}

export interface MaqamPolicyAuthorizer {
  authorizeToolCall(input: {
    toolName?: string;
    input?: unknown;
    context?: unknown;
    metadata?: { effects?: string[]; risk?: string };
  }): MaqamPolicyDecision;
}

function rounded(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function mean(values: number[]): number | null {
  return values.length > 0 ? rounded(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
}

function receiptConfidence(signal: TelegraphSignalReceipt): number | null {
  // Only the catalog-declared signal_mapping.confidence_field has policy
  // authority. Nested or coincidental fields may be displayed as provider data
  // but cannot silently become a Telegraph confidence signal.
  return signal.confidence;
}

function aggregateSignals(signals: TelegraphSignalReceipt[]): PreflightAggregate {
  const verified = signals.filter((signal) => signal.signal_verified);
  const supporting = verified.filter((signal) => signal.stance === "SUPPORTS").length;
  const refuting = verified.filter((signal) => signal.stance === "REFUTES").length;
  const uncertain = verified.filter((signal) => signal.stance === "UNCERTAIN").length;
  const directional = supporting + refuting;
  const conflictScore = directional === 0 ? 0 : (2 * Math.min(supporting, refuting)) / directional;
  const dominantStance: SignalStance | null = supporting > refuting
    ? "SUPPORTS"
    : refuting > supporting
      ? "REFUTES"
      : null;
  const alignedConfidenceByMiner = new Map<string, number>();
  if (dominantStance) {
    for (const signal of verified) {
      if (signal.stance !== dominantStance || alignedConfidenceByMiner.has(signal.miner_id)) continue;
      const confidence = receiptConfidence(signal);
      if (confidence !== null) alignedConfidenceByMiner.set(signal.miner_id, confidence);
    }
  }
  return {
    // Confidence is directional: uncertain or opposing signals must never
    // increase the score used to authorize the dominant evidence stance.
    confidence: mean([...alignedConfidenceByMiner.values()]),
    supporting_signals: supporting,
    refuting_signals: refuting,
    uncertain_signals: uncertain,
    distinct_miners: new Set(verified.map((signal) => signal.miner_id)).size,
    verified_signals: verified.length,
    conflict_score: rounded(conflictScore),
    total_cost_usd: rounded(signals.reduce((sum, signal) => sum + (signal.cost_usd ?? 0), 0)),
  };
}

export function buildClaimResults(
  claims: string[],
  signals: TelegraphSignalReceipt[],
  requiredSupport: number,
): PreflightClaimResult[] {
  const verified = signals.filter((signal) => signal.signal_verified);
  return claims.map((claim, index) => {
    const id = claimId(claim, index);
    const assessments = verified.flatMap((signal) => {
      const assessment = signal.claim_assessments.find((candidate) => candidate.claim_id === id);
      return assessment ? [{ signal, assessment }] : [];
    });
    const minersFor = (stance: SignalStance) => new Set(
      assessments
        .filter(({ assessment }) => assessment.stance === stance)
        .map(({ signal }) => signal.miner_id),
    );
    const supporting = minersFor("SUPPORTS").size;
    const refuting = minersFor("REFUTES").size;
    const uncertain = minersFor("UNCERTAIN").size;
    const credibleRefutationThreshold = Math.max(2, requiredSupport);
    const verdict = supporting > 0 && refuting > 0
      ? "CONFLICTED" as const
      : refuting >= credibleRefutationThreshold && supporting === 0
        ? "REFUTED" as const
        : supporting >= requiredSupport && refuting === 0
          ? "SUPPORTED" as const
          : "UNCERTAIN" as const;
    return {
      id,
      claim,
      verdict,
      confidence: mean(assessments.flatMap(({ assessment }) =>
        assessment.confidence === null ? [] : [assessment.confidence]
      )),
      supporting_signals: supporting,
      refuting_signals: refuting,
      uncertain_signals: uncertain,
      signal_hashes: [...new Set(assessments.map(({ signal }) => signal.signal_hash))],
    };
  });
}

function rule(
  id: string,
  label: string,
  passed: boolean,
  actual: number | string | boolean | null,
  required: number | string | boolean,
): PreflightRuleResult {
  return { id, label, passed, actual, required };
}

function evaluateRules(input: {
  configured: boolean;
  aggregate: PreflightAggregate;
  claims: PreflightClaimResult[];
  signals: TelegraphSignalReceipt[];
  policy: ReturnType<typeof compilePolicy>;
  partialFailure: boolean;
}): PreflightRuleResult[] {
  const { configured, aggregate, claims, signals, policy, partialFailure } = input;
  const verifiedAutoFact = signals.some((signal) =>
    signal.signal_verified && signal.route_mode === "AUTO" && signal.intent === "FACT_CHECK"
  );
  const mappedSupportingMiners = new Set(
    signals
      .filter((signal) => signal.signal_verified && signal.stance === "SUPPORTS" && receiptConfidence(signal) !== null)
      .map((signal) => signal.miner_id),
  ).size;
  const mappedRefutingMiners = new Set(
    signals
      .filter((signal) => signal.signal_verified && signal.stance === "REFUTES" && receiptConfidence(signal) !== null)
      .map((signal) => signal.miner_id),
  ).size;
  const alignedMappedMiners = Math.max(mappedSupportingMiners, mappedRefutingMiners);
  return [
    rule("TELEGRAPH_CONFIGURED", "Telegraph x402 payer is configured", configured, configured, true),
    rule("VERIFIED_AUTO_FACT_CHECK", "A real auto-routed FACT_CHECK signal is verified", verifiedAutoFact, verifiedAutoFact, true),
    rule("NO_PARTIAL_FAILURES", "No Telegraph call or verification failed", !partialFailure, !partialFailure, true),
    rule("POLICY_FULLY_COMPILED", "Every policy clause is understood", policy.unsupported_clauses.length === 0, policy.unsupported_clauses.length, 0),
    rule("MIN_VERIFIED_SIGNALS", "Verified Telegraph signals meet the minimum", aggregate.verified_signals >= policy.min_verified_signals, aggregate.verified_signals, policy.min_verified_signals),
    rule("MIN_DISTINCT_MINERS", "Distinct verified miners meet the minimum", aggregate.distinct_miners >= policy.min_distinct_miners, aggregate.distinct_miners, policy.min_distinct_miners),
    rule("PROVIDER_CONFIDENCE_COVERAGE", "Enough distinct aligned miners map provider confidence", alignedMappedMiners >= policy.min_supporting_signals, alignedMappedMiners, policy.min_supporting_signals),
    rule("MIN_CONFIDENCE", "Miner-declared confidence meets the minimum", aggregate.confidence !== null && aggregate.confidence >= policy.min_confidence, aggregate.confidence, policy.min_confidence),
    rule("MIN_SUPPORTING_SIGNALS", "Supporting signals meet the minimum", aggregate.supporting_signals >= policy.min_supporting_signals, aggregate.supporting_signals, policy.min_supporting_signals),
    rule("MAX_CONFLICT_SCORE", "Conflict does not exceed policy", aggregate.conflict_score <= policy.max_conflict_score, aggregate.conflict_score, policy.max_conflict_score),
    rule("ALL_CLAIMS_SUPPORTED", "Every required claim is independently supported", claims.length > 0 && claims.every((claim) => claim.verdict === "SUPPORTED"), claims.length > 0 ? claims.filter((claim) => claim.verdict === "SUPPORTED").length : 0, claims.length),
  ];
}

function reasonCodesFor(
  rules: PreflightRuleResult[],
  claims: PreflightClaimResult[],
  operationalCodes: string[],
): string[] {
  const codes = new Set(operationalCodes);
  for (const failed of rules.filter((candidate) => !candidate.passed)) codes.add(failed.id);
  if (claims.some((claim) => claim.verdict === "REFUTED")) codes.add("CREDIBLE_REFUTATION");
  if (claims.some((claim) => claim.verdict === "CONFLICTED")) codes.add("MATERIAL_CONFLICT");
  return [...codes];
}

function decideEvidence(input: {
  rules: PreflightRuleResult[];
  claims: PreflightClaimResult[];
  blockOnRefutation: boolean;
  blockOnAnyConflict: boolean;
  partialFailure: boolean;
}): PreflightDecision {
  if (input.partialFailure) return "ESCALATE";
  const blockBoundaryRules = new Set([
    "TELEGRAPH_CONFIGURED",
    "VERIFIED_AUTO_FACT_CHECK",
    "NO_PARTIAL_FAILURES",
    "POLICY_FULLY_COMPILED",
    "MIN_VERIFIED_SIGNALS",
    "MIN_DISTINCT_MINERS",
    "PROVIDER_CONFIDENCE_COVERAGE",
    "MIN_CONFIDENCE",
  ]);
  if (input.rules.some((rule) => blockBoundaryRules.has(rule.id) && !rule.passed)) return "ESCALATE";
  if (input.blockOnRefutation && input.claims.some((claim) => claim.verdict === "REFUTED")) return "BLOCK";
  if (input.blockOnAnyConflict && input.claims.some((claim) => claim.verdict === "CONFLICTED")) return "BLOCK";
  return input.rules.every((rule) => rule.passed) ? "ALLOW" : "ESCALATE";
}

function defaultMaqamAuthorizer(): PolicyEngine {
  return new PolicyEngine({
    allowedTools: ["proofgate.authorize-action"],
    maxToolCalls: 1,
    defaultLimits: { maximumAuthorizations: 1 },
  });
}

function authorizeWithMaqam(input: {
  authorizer: MaqamPolicyAuthorizer;
  actionId: string;
  action: string;
  claims: PreflightClaimResult[];
  aggregate: PreflightAggregate;
  signalHashes: string[];
  policyHash: string;
}): MaqamPolicyDecision {
  return input.authorizer.authorizeToolCall({
    toolName: "proofgate.authorize-action",
    input: {
      action_id: input.actionId,
      action: input.action,
      claims: input.claims.map(({ id, verdict }) => ({ id, verdict })),
      aggregate: input.aggregate,
      signal_hashes: input.signalHashes,
      policy_hash: input.policyHash,
    },
    context: { runId: input.actionId, boundary: "pre-action" },
    metadata: { effects: ["authorize"], risk: "low" },
  });
}

function explain(decision: PreflightDecision, codes: string[]): string {
  if (decision === "ALLOW") {
    return "Authorization issued: every hard evidence rule passed using verified Telegraph signals from distinct miners.";
  }
  if (decision === "BLOCK") {
    return codes.includes("CREDIBLE_REFUTATION")
      ? "Action blocked: multiple verified Telegraph signals credibly refute a required claim."
      : "Action blocked: the compiled policy treats the verified evidence conflict as disqualifying.";
  }
  if (codes.includes("TELEGRAPH_NOT_CONFIGURED") || codes.includes("TELEGRAPH_CONFIGURED")) {
    return "Action escalated: configure a funded Telegraph x402 payer before ProofGate can obtain real signals.";
  }
  if (codes.some((code) => code.endsWith("_FAILED") || code === "NO_PARTIAL_FAILURES")) {
    return "Action escalated: the Telegraph evidence run was incomplete, so ProofGate refused to authorize it.";
  }
  if (codes.includes("POLICY_FULLY_COMPILED")) {
    return "Action escalated: at least one policy clause is outside ProofGate's deterministic policy grammar.";
  }
  if (codes.includes("MAQAM_AUTHORIZATION_DENIED") || codes.includes("MAQAM_APPROVAL_REQUIRED")) {
    return "Action escalated: Maqam did not authorize this exact action boundary.";
  }
  return "Action escalated: verified evidence did not satisfy every hard policy threshold.";
}

function actionId(request: PreflightRequest, generatedAt: string, claims: string[]): string {
  const seed = hashCanonical({
    generated_at: generatedAt,
    request_id: request.request_id ?? null,
    action: request.action,
    policy: request.policy,
    claims,
  });
  return `PG-${seed.slice("sha256:".length, "sha256:".length + 20)}`;
}

function minerForAsk(miners: TelegraphMiner[], ask: TelegraphAskResult): TelegraphMiner | undefined {
  return miners.find((miner) => miner.id === ask.miner_id)
    ?? miners.find((miner) => miner.slug === ask.miner_name);
}

async function executeAndVerify(input: {
  client: TelegraphClient;
  miners: TelegraphMiner[];
  routeMode: TelegraphRouteMode;
  requestedIntent: TelegraphIntent;
  claims: string[];
  generatedAt: string;
  query: string;
  expectedMinerId?: string;
  signal?: AbortSignal;
  execute: () => Promise<TelegraphAskResult>;
}): Promise<{ ask: TelegraphAskResult; receipt: TelegraphSignalReceipt | null }> {
  const ask = await input.execute();
  if (input.expectedMinerId !== undefined && ask.miner_id !== input.expectedMinerId) {
    throw new TelegraphClientError(
      "INVALID_RESPONSE",
      `Telegraph direct ask returned miner ${ask.miner_id} instead of requested miner ${input.expectedMinerId}.`,
    );
  }
  if (!ask.signal_hash) return { ask, receipt: null };
  const lookup = await input.client.verifySignal(ask.signal_hash, { signal: input.signal });
  return {
    ask,
    receipt: normalizeSignalReceipt({
      ask,
      lookup,
      miner: minerForAsk(input.miners, ask),
      routeMode: input.routeMode,
      requestedIntent: input.requestedIntent,
      claims: input.claims,
      expectedQuery: input.query,
      checkedAt: input.generatedAt,
    }),
  };
}

export async function buildPreflight(
  request: PreflightRequest,
  options: BuildPreflightOptions = {},
): Promise<PreflightResponse> {
  const generatedAt = (options.now?.() ?? new Date()).toISOString();
  const normalizedRequest: PreflightRequest = {
    action: normalizePreflightText(request.action, 2_048),
    policy: normalizePreflightText(request.policy, 4_096),
    ...(request.claims ? { claims: request.claims.map((claim) => normalizePreflightText(claim, 1_024)) } : {}),
    ...(request.request_id ? { request_id: normalizePreflightText(request.request_id, 256) } : {}),
  };
  const claims = extractClaims(normalizedRequest.action, normalizedRequest.claims);
  const id = actionId(normalizedRequest, generatedAt, claims);
  const policy = compilePolicy(normalizedRequest.policy);
  const signals: TelegraphSignalReceipt[] = [];
  const operationalCodes: string[] = [];
  const operational: PreflightOperationalStatus = {
    telegraph_configured: false,
    paid_calls_attempted: 0,
    paid_calls_succeeded: 0,
  };
  let maximumPaidCalls = 0;
  try {
    maximumPaidCalls = resolveMaximumPaidCalls(options.maximumPaidCalls);
  } catch {
    operationalCodes.push("PROOFGATE_CALL_LIMIT_INVALID");
  }

  let client: TelegraphClient | null = options.client ?? null;
  if (!client) {
    try {
      client = createTelegraphClient();
    } catch {
      operationalCodes.push("TELEGRAPH_CONFIGURATION_INVALID");
    }
  }
  operational.telegraph_configured = client?.configured === true;

  if (claims.length === 0) operationalCodes.push("NO_CHECKABLE_CLAIMS");
  if (!operational.telegraph_configured || !client) {
    operationalCodes.push("TELEGRAPH_NOT_CONFIGURED");
  } else if (claims.length > 0 && maximumPaidCalls > 0) {
    let miners: TelegraphMiner[] = [];
    try {
      miners = await client.discoverMiners({ signal: options.signal });
    } catch {
      operationalCodes.push("TELEGRAPH_DISCOVERY_FAILED");
    }

    if (miners.length > 0) {
      const query = buildFactCheckQuery(claims);
      const excluded = new Set<string>();
      let autoVerified = false;
      operational.paid_calls_attempted += 1;
      try {
        const auto = await executeAndVerify({
          client,
          miners,
          routeMode: "AUTO",
          requestedIntent: "FACT_CHECK",
          claims,
          generatedAt,
          query,
          signal: options.signal,
          execute: () => client.askAuto(query, { signal: options.signal }),
        });
        operational.paid_calls_succeeded += 1;
        excluded.add(auto.ask.miner_id);
        if (auto.receipt) signals.push(auto.receipt);
        if (auto.receipt?.signal_verified) autoVerified = true;
        else operationalCodes.push("AUTO_SIGNAL_VERIFICATION_FAILED");
      } catch (error) {
        operationalCodes.push(error instanceof TelegraphClientError && error.code === "PAYMENT_FAILED"
          ? "TELEGRAPH_PAYMENT_FAILED"
          : "AUTO_FACT_CHECK_FAILED");
      }

      if (autoVerified) {
        const remainingCalls = maximumPaidCalls - operational.paid_calls_attempted;
        const directPlans = selectDirectMiners(miners, excluded, query, remainingCalls);
        if (remainingCalls > 0 && directPlans.length === 0) operationalCodes.push("NO_ADDITIONAL_VIABLE_MINER");
        for (const { miner, intent } of directPlans) {
          if (operational.paid_calls_attempted >= maximumPaidCalls) break;
          operational.paid_calls_attempted += 1;
          try {
            const direct = await executeAndVerify({
              client,
              miners,
              routeMode: "DIRECT",
              requestedIntent: intent,
              claims,
              generatedAt,
              query,
              expectedMinerId: miner.id,
              signal: options.signal,
              execute: () => client.askDirect(miner, intent, query, { signal: options.signal }),
            });
            operational.paid_calls_succeeded += 1;
            excluded.add(direct.ask.miner_id);
            if (direct.receipt) signals.push(direct.receipt);
            if (!direct.receipt?.signal_verified) {
              operationalCodes.push("DIRECT_SIGNAL_VERIFICATION_FAILED");
              break;
            }
          } catch (error) {
            operationalCodes.push(error instanceof TelegraphClientError && error.code === "PAYMENT_FAILED"
              ? "TELEGRAPH_PAYMENT_FAILED"
              : "DIRECT_MINER_FAILED");
            break;
          }
        }
      }
    }
  }

  if (signals.some((signal) => !signal.signal_verified)) operationalCodes.push("SIGNAL_VERIFICATION_FAILED");
  const partialFailure = operational.paid_calls_attempted !== operational.paid_calls_succeeded
    || operationalCodes.some((code) => code.endsWith("_FAILED"));
  const uniqueSignals = signals.filter((candidate, index, all) =>
    all.findIndex((signal) => signal.signal_hash === candidate.signal_hash) === index
  );
  const aggregate = aggregateSignals(uniqueSignals);
  const evaluatedClaims = buildClaimResults(claims, uniqueSignals, policy.min_supporting_signals);
  const rules = evaluateRules({
    configured: operational.telegraph_configured,
    aggregate,
    claims: evaluatedClaims,
    signals: uniqueSignals,
    policy,
    partialFailure,
  });
  const evidenceDecision = decideEvidence({
    rules,
    claims: evaluatedClaims,
    blockOnRefutation: policy.block_on_credible_refutation,
    blockOnAnyConflict: policy.block_on_any_conflict,
    partialFailure,
  });
  let decision = evidenceDecision;
  let maqamStatus = "not_requested";
  let maqamPassed = true;
  if (evidenceDecision === "ALLOW") {
    try {
      const maqam = authorizeWithMaqam({
        authorizer: options.maqamPolicyEngine ?? defaultMaqamAuthorizer(),
        actionId: id,
        action: normalizedRequest.action,
        claims: evaluatedClaims,
        aggregate,
        signalHashes: uniqueSignals.map((signal) => signal.signal_hash),
        policyHash: policy.policy_hash,
      });
      maqamStatus = maqam.status;
      maqamPassed = maqam.status === "allow";
      if (!maqamPassed) {
        decision = "ESCALATE";
        operationalCodes.push(maqam.status === "needs_approval"
          ? "MAQAM_APPROVAL_REQUIRED"
          : "MAQAM_AUTHORIZATION_DENIED");
      }
    } catch {
      maqamStatus = "error";
      maqamPassed = false;
      decision = "ESCALATE";
      operationalCodes.push("MAQAM_AUTHORIZATION_FAILED");
    }
  }
  rules.push(rule(
    "MAQAM_AUTHORIZATION_BOUNDARY",
    "Maqam action boundary was honored",
    maqamPassed,
    maqamStatus,
    evidenceDecision === "ALLOW" ? "allow" : "not_required",
  ));
  const reasonCodes = reasonCodesFor(rules, evaluatedClaims, operationalCodes);
  if (decision === "ALLOW") reasonCodes.push("POLICY_PASSED");
  const reason = explain(decision, reasonCodes);
  const qarinah = createProofGateChain({
    action_id: id,
    generated_at: generatedAt,
    action: normalizedRequest.action,
    claims: evaluatedClaims,
    policy,
    signals: uniqueSignals,
    aggregate,
    rules,
    decision,
    authorization_issued: decision === "ALLOW",
    reason,
    reason_codes: reasonCodes,
  });
  const payload: PreflightResponsePayload = {
    schema_version: PREFLIGHT_SCHEMA_VERSION,
    action_id: id,
    generated_at: generatedAt,
    decision,
    authorization_issued: decision === "ALLOW",
    action: normalizedRequest.action,
    claims: evaluatedClaims,
    compiled_policy: policy,
    aggregate,
    rules,
    signals: uniqueSignals,
    qarinah,
    reason,
    reason_codes: reasonCodes,
    operational,
  };
  return {
    ...payload,
    receipt: {
      schema_version: PREFLIGHT_RECEIPT_SCHEMA_VERSION,
      algorithm: "SHA-256",
      canonicalization: "proofgate.canonical-json.v1",
      scope: "preflight-without-receipt",
      root_hash: hashCanonical(payload),
      qarinah_head_hash: qarinah.head_hash,
      telegraph_signal_hashes: uniqueSignals.map((signal) => signal.signal_hash),
    },
  };
}

export function verifyPreflightReceipt(response: PreflightResponse): boolean {
  try {
    const { receipt, ...payload } = response;
    const payloadSignalHashes = payload.signals.map((signal) => signal.signal_hash);
    const exactSignalHashes = receipt.telegraph_signal_hashes.length === payloadSignalHashes.length
      && receipt.telegraph_signal_hashes.every((hash, index) => hash === payloadSignalHashes[index])
      && new Set(receipt.telegraph_signal_hashes).size === receipt.telegraph_signal_hashes.length;
    validateProofGateChain(payload.qarinah);
    return receipt.schema_version === PREFLIGHT_RECEIPT_SCHEMA_VERSION
      && receipt.algorithm === "SHA-256"
      && receipt.canonicalization === "proofgate.canonical-json.v1"
      && receipt.scope === "preflight-without-receipt"
      && exactSignalHashes
      && receipt.qarinah_head_hash === payload.qarinah.head_hash
      && hashCanonical(payload) === receipt.root_hash;
  } catch {
    return false;
  }
}

export function assessmentForClaim(
  signal: TelegraphSignalReceipt,
  claim: PreflightClaimResult,
): ClaimAssessment | undefined {
  return signal.claim_assessments.find((assessment) => assessment.claim_id === claim.id);
}
