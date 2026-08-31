import {
  createEventEnvelope,
  validateStoredEvent,
  type QarinahEvent,
  type QarinahEventInput,
} from "qarinah";

import { hashText, isSha256Hash } from "./canonical";
import type {
  Contradiction,
  EvidenceItem,
  PolicyDecision,
  ProofClaim,
  ProofRequest,
  QarinahProofChain,
  ScoreBreakdown,
  Verdict,
} from "./types";
import { PROOF_CHAIN_SCHEMA_VERSION } from "./types";

export interface CreateQarinahProofChainInput {
  pack_id: string;
  generated_at: string;
  request: ProofRequest;
  verdict: Verdict;
  confidence: number;
  score_breakdown: ScoreBreakdown;
  claims: ProofClaim[];
  evidence: EvidenceItem[];
  contradictions: Contradiction[];
  policy: PolicyDecision;
  abstained: boolean;
  reason: string;
  workspace_id?: string;
}

function sha256Hex(value: string): string {
  return hashText(value).slice("sha256:".length);
}

function deterministicEventId(packId: string, ordinal: number, label: string): string {
  const hex = sha256Hex(`${packId}\u0000${ordinal}\u0000${label}`).slice(0, 32);
  return `evt_${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function proofWorkspaceId(packId: string): string {
  return `ws_${sha256Hex(`qarinah-proofpack\u0000${packId}`).slice(0, 32)}`;
}

/** Safe, bounded evidence identity recorded in the provenance ledger. */
export function qarinahEvidenceProjection(evidence: EvidenceItem): Record<string, unknown> {
  return {
    id: evidence.id,
    canonical_url: evidence.canonical_url,
    content_hash: evidence.content_hash,
    evidence_hash: evidence.evidence_hash,
    source_domain: evidence.source_domain,
    stance: evidence.stance,
    untrusted: true,
  };
}

function requestData(request: ProofRequest): Record<string, unknown> {
  return {
    query: request.query,
    ...(request.intent === undefined ? {} : { intent: request.intent }),
    ...(request.request_id === undefined ? {} : { request_id: request.request_id }),
    ...(request.as_of === undefined ? {} : { as_of: request.as_of }),
    untrusted_input: true,
  };
}

/**
 * Builds an isolated, in-memory Qarinah event chain. This function deliberately
 * uses neither workspace discovery nor appendEvent; no project ledger is read or
 * mutated.
 */
export function createQarinahProofChain(
  input: CreateQarinahProofChainInput,
): QarinahProofChain {
  const workspaceId = input.workspace_id ?? proofWorkspaceId(input.pack_id);
  const events: QarinahEvent[] = [];
  let previousHash: string | null = null;
  let ordinal = 0;

  const appendInMemory = (label: string, eventInput: Omit<QarinahEventInput, "eventId" | "timestamp">) => {
    const event = createEventEnvelope(
      {
        ...eventInput,
        eventId: deterministicEventId(input.pack_id, ordinal, label),
        timestamp: input.generated_at,
      },
      { workspaceId, previousHash },
    );

    // Validate the exact envelope immediately, including canonical shape, hash,
    // workspace binding, and previous-hash continuity.
    const validated = validateStoredEvent(event, {
      workspaceId,
      expectedPreviousHash: previousHash,
    });
    events.push(validated);
    previousHash = validated.hash;
    ordinal += 1;
    return validated;
  };

  appendInMemory("request", {
    kind: "prompt.submitted",
    actor: { type: "agent", id: "telegraph-requester" },
    title: "ProofPack research request received",
    body: "",
    data: requestData(input.request),
    confidence: "claimed",
    disclosure: { scopes: ["proofpack"], classification: "public" },
    provenance: { adapter: "qarinah-proofpack/request", sourceId: input.pack_id },
    retention: { class: "durable", expiresAt: null },
  });

  const evidenceEvents = new Map<string, QarinahEvent>();
  for (const evidence of input.evidence) {
    const event = appendInMemory(`evidence:${evidence.id}`, {
      kind: "source",
      actor: { type: "tool", id: "cockroach-crawler" },
      title: `Captured untrusted evidence ${evidence.id}`,
      body: "",
      data: {
        evidence: qarinahEvidenceProjection(evidence),
        trust_boundary: "crawler-material-is-untrusted-data",
      },
      confidence: "extracted",
      disclosure: { scopes: ["proofpack", "evidence"], classification: "public" },
      provenance: {
        adapter: "qarinah-proofpack/cockroach-crawler",
        sourceId: evidence.canonical_url,
      },
      retention: { class: "durable", expiresAt: null },
    });
    evidenceEvents.set(evidence.id, event);
  }

  const claimEvents = new Map<string, QarinahEvent>();
  for (const claim of input.claims) {
    const supporting = new Set(claim.supporting_evidence_ids);
    const refuting = new Set(claim.refuting_evidence_ids);
    const relations = [...new Set(claim.evidence_ids)]
      .map((evidenceId) => {
        const target = evidenceEvents.get(evidenceId);
        if (!target) return null;
        return {
          type: refuting.has(evidenceId) && !supporting.has(evidenceId)
            ? ("contradicts" as const)
            : ("supports" as const),
          target: target.eventId,
        };
      })
      .filter((relation): relation is NonNullable<typeof relation> => relation !== null);

    const event = appendInMemory(`claim:${claim.id}`, {
      kind: "claim",
      actor: { type: "agent", id: "qarinah-proofpack" },
      title: `Evaluated claim ${claim.id}`,
      body: "",
      data: { claim: { ...claim } },
      confidence: "inferred",
      relations,
      disclosure: { scopes: ["proofpack", "claims"], classification: "public" },
      provenance: { adapter: "qarinah-proofpack/synthesis", sourceId: claim.id },
      retention: { class: "durable", expiresAt: null },
    });
    claimEvents.set(claim.id, event);
  }

  for (const contradiction of input.contradictions) {
    const targets = [...new Set(contradiction.evidence_ids)]
      .map((evidenceId) => evidenceEvents.get(evidenceId))
      .filter((event): event is QarinahEvent => event !== undefined);
    appendInMemory(`contradiction:${contradiction.id}`, {
      kind: "claim",
      actor: { type: "agent", id: "qarinah-proofpack" },
      title: `Recorded contradiction ${contradiction.id}`,
      body: "",
      data: { contradiction: { ...contradiction } },
      confidence: "inferred",
      relations: targets.map((event) => ({ type: "contradicts", target: event.eventId })),
      disclosure: { scopes: ["proofpack", "contradictions"], classification: "public" },
      provenance: { adapter: "qarinah-proofpack/synthesis", sourceId: contradiction.id },
      retention: { class: "durable", expiresAt: null },
    });
  }

  const derivedFrom = [...claimEvents.values()].map((event) => ({
    type: "derived_from" as const,
    target: event.eventId,
  }));
  appendInMemory("decision", {
    kind: "decision",
    actor: { type: "system", id: "maqam-evidence-policy" },
    title: "Applied the ProofPack evidence contract",
    body: "",
    data: {
      verdict: input.verdict,
      confidence: input.confidence,
      score_breakdown: { ...input.score_breakdown },
      policy: { ...input.policy },
      abstained: input.abstained,
      reason: input.reason,
    },
    confidence: "verified",
    relations: [
      { type: "governed_by", target: input.policy.policy_id },
      ...derivedFrom,
    ],
    disclosure: { scopes: ["proofpack", "decision"], classification: "public" },
    provenance: { adapter: "qarinah-proofpack/maqam", sourceId: input.policy.policy_id },
    retention: { class: "durable", expiresAt: null },
  });

  if (previousHash === null || !isSha256Hash(previousHash)) {
    throw new TypeError("Qarinah proof chain did not produce a valid head hash.");
  }

  return {
    schema_version: PROOF_CHAIN_SCHEMA_VERSION,
    workspace_id: workspaceId,
    events,
    event_count: events.length,
    head_hash: previousHash,
  };
}

/** Throws when an embedded chain is malformed, tampered with, or discontinuous. */
export function validateQarinahProofChain(chain: QarinahProofChain): QarinahEvent[] {
  if (chain.schema_version !== PROOF_CHAIN_SCHEMA_VERSION) {
    throw new TypeError("Unsupported Qarinah proof-chain schema version.");
  }
  if (!Array.isArray(chain.events) || chain.events.length === 0) {
    throw new TypeError("Qarinah proof chain must contain at least one event.");
  }
  if (chain.events.length > 512) {
    throw new TypeError("Qarinah proof chain cannot contain more than 512 events.");
  }
  if (chain.event_count !== chain.events.length) {
    throw new TypeError("Qarinah proof-chain event_count does not match events.length.");
  }

  const validated: QarinahEvent[] = [];
  let previousHash: string | null = null;
  for (const event of chain.events) {
    const current = validateStoredEvent(event, {
      workspaceId: chain.workspace_id,
      expectedPreviousHash: previousHash,
    });
    validated.push(current);
    previousHash = current.hash;
  }

  if (previousHash !== chain.head_hash) {
    throw new TypeError("Qarinah proof-chain head_hash does not match the final event.");
  }
  return validated;
}
