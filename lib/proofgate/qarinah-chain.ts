import {
  createEventEnvelope,
  validateStoredEvent,
  type QarinahEvent,
  type QarinahEventInput,
} from "qarinah";

import { hashText, isSha256Hash } from "@/lib/proof/canonical";

import type {
  CompiledPolicy,
  PreflightAggregate,
  PreflightClaimResult,
  PreflightDecision,
  PreflightRuleResult,
  ProofGateQarinahChain,
  TelegraphSignalReceipt,
} from "./types";
import { PROOFGATE_CHAIN_SCHEMA_VERSION } from "./types";

export interface CreateProofGateChainInput {
  action_id: string;
  generated_at: string;
  action: string;
  claims: PreflightClaimResult[];
  policy: CompiledPolicy;
  signals: TelegraphSignalReceipt[];
  aggregate: PreflightAggregate;
  rules: PreflightRuleResult[];
  decision: PreflightDecision;
  authorization_issued: boolean;
  reason: string;
  reason_codes: string[];
}

function hex(value: string): string {
  return hashText(value).slice("sha256:".length);
}

function eventId(actionId: string, ordinal: number, label: string): string {
  const value = hex(`${actionId}\u0000${ordinal}\u0000${label}`).slice(0, 32);
  return `evt_${value.slice(0, 8)}-${value.slice(8, 12)}-4${value.slice(13, 16)}-8${value.slice(17, 20)}-${value.slice(20, 32)}`;
}

export function proofGateWorkspaceId(actionId: string): string {
  return `ws_${hex(`qarinah-proofgate\u0000${actionId}`).slice(0, 32)}`;
}

/** Builds an isolated Qarinah chain without reading or mutating a project ledger. */
export function createProofGateChain(input: CreateProofGateChainInput): ProofGateQarinahChain {
  const workspaceId = proofGateWorkspaceId(input.action_id);
  const events: QarinahEvent[] = [];
  let previousHash: string | null = null;
  let ordinal = 0;

  const append = (label: string, event: Omit<QarinahEventInput, "eventId" | "timestamp">): QarinahEvent => {
    const envelope = createEventEnvelope({
      ...event,
      eventId: eventId(input.action_id, ordinal, label),
      timestamp: input.generated_at,
    }, { workspaceId, previousHash });
    const validated = validateStoredEvent(envelope, { workspaceId, expectedPreviousHash: previousHash });
    events.push(validated);
    previousHash = validated.hash;
    ordinal += 1;
    return validated;
  };

  const request = append("preflight-request", {
    kind: "prompt.submitted",
    actor: { type: "agent", id: "proofgate-requester" },
    title: "Pre-action authorization requested",
    body: "",
    data: {
      action: input.action,
      claims: input.claims.map(({ id, claim }) => ({ id, claim })),
      policy_hash: input.policy.policy_hash,
      untrusted_input: true,
    },
    confidence: "claimed",
    disclosure: { scopes: ["proofgate", "preflight"], classification: "public" },
    provenance: { adapter: "proofgate/request", sourceId: input.action_id },
    retention: { class: "durable", expiresAt: null },
  });

  const signalEvents = input.signals.map((signal) => append(`telegraph:${signal.signal_hash}`, {
    kind: "source",
    actor: { type: "tool", id: "telegraph-engine" },
    title: `Captured Telegraph signal ${signal.signal_hash.slice(0, 14)}`,
    body: "",
    data: {
      signal: {
        signal_hash: signal.signal_hash,
        signal_verified: signal.signal_verified,
        signal_verification: signal.signal_verification,
        result_hash: signal.result_hash,
        payment_response_hash: signal.payment_response_hash,
        payment_settlement: signal.payment_settlement,
        miner_id: signal.miner_id,
        miner_slug: signal.miner_slug,
        rank_at_request: signal.rank_at_request,
        requested_intent: signal.requested_intent,
        intent: signal.intent,
        route_mode: signal.route_mode,
        cost_usd: signal.cost_usd,
        timestamp: signal.timestamp,
        stance: signal.stance,
        confidence: signal.confidence,
      },
      trust_boundary: "telegraph-output-is-data-until-node-attestation-binding-and-policy-evaluation",
    },
    confidence: signal.signal_verified ? "extracted" : "claimed",
    relations: [{ type: "derived_from", target: request.eventId }],
    disclosure: { scopes: ["proofgate", "telegraph", "evidence"], classification: "public" },
    provenance: { adapter: "proofgate/telegraph", sourceId: signal.signal_hash },
    retention: { class: "durable", expiresAt: null },
  }));

  append("preflight-decision", {
    kind: "decision",
    actor: { type: "system", id: "maqam-proofgate-policy" },
    title: `ProofGate decision: ${input.decision}`,
    body: "",
    data: {
      decision: input.decision,
      authorization_issued: input.authorization_issued,
      aggregate: input.aggregate,
      claims: input.claims,
      rules: input.rules,
      reason: input.reason,
      reason_codes: input.reason_codes,
    },
    confidence: "verified",
    relations: [
      { type: "governed_by", target: input.policy.policy_hash },
      { type: "derived_from", target: request.eventId },
      ...signalEvents.map((event) => ({ type: "derived_from" as const, target: event.eventId })),
    ],
    disclosure: { scopes: ["proofgate", "decision"], classification: "public" },
    provenance: { adapter: "proofgate/maqam", sourceId: input.policy.policy_hash },
    retention: { class: "durable", expiresAt: null },
  });

  if (previousHash === null || !isSha256Hash(previousHash)) {
    throw new TypeError("ProofGate did not produce a valid Qarinah chain head.");
  }
  return {
    schema_version: PROOFGATE_CHAIN_SCHEMA_VERSION,
    workspace_id: workspaceId,
    events,
    event_count: events.length,
    head_hash: previousHash,
  };
}

export function validateProofGateChain(chain: ProofGateQarinahChain): QarinahEvent[] {
  if (chain.schema_version !== PROOFGATE_CHAIN_SCHEMA_VERSION) throw new TypeError("Unsupported ProofGate chain version.");
  if (!Array.isArray(chain.events) || chain.events.length < 2 || chain.events.length > 8) {
    throw new TypeError("ProofGate chain event count is outside the bounded contract.");
  }
  if (chain.event_count !== chain.events.length) throw new TypeError("ProofGate chain metadata is inconsistent.");
  let previousHash: string | null = null;
  const events = chain.events.map((event) => {
    const validated = validateStoredEvent(event, { workspaceId: chain.workspace_id, expectedPreviousHash: previousHash });
    previousHash = validated.hash;
    return validated;
  });
  if (previousHash !== chain.head_hash) throw new TypeError("ProofGate chain head is inconsistent.");
  return events;
}
