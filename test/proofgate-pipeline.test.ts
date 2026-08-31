import { describe, expect, it } from "vitest";

import {
  buildClaimResults,
  buildPreflight,
  resolveMaximumPaidCalls,
  verifyPreflightReceipt,
} from "@/lib/proofgate/pipeline";
import { validateProofGateChain } from "@/lib/proofgate/qarinah-chain";
import type {
  TelegraphAskResult,
  TelegraphClient,
  TelegraphIntent,
  TelegraphMiner,
  TelegraphSignalLookup,
} from "@/lib/proofgate/types";

const NOW = new Date("2026-08-31T12:00:00.000Z");
const POLICY = "Allow only when decision confidence is at least 80%, at least two independent miners support the claim, and there is no material conflict. Otherwise escalate to human review.";
const CLAIM = "The James Webb Space Telescope launched in 2021.";

function miner(id: string, intent: TelegraphIntent, rank: number): TelegraphMiner {
  return {
    id,
    slug: `miner-${id}`,
    name: `Miner ${id}`,
    endpoints: [{ path: "/proof", method: "POST" }],
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    output_schema: null,
    signal_mapping: { confidence_field: "confidence", label_field: "verdict", reason_field: "reason" },
    supported_intents: [intent],
    activation_status: "active",
    min_price_usdc: 10_000,
    scores: [{ intent_id: intent, rank }],
  };
}

class FakeTelegraphClient implements TelegraphClient {
  readonly configured: boolean;
  readonly miners = [miner("101", "FACT_CHECK", 1), miner("202", "FACT_CHECK", 2), miner("303", "RESEARCH_SYNTHESIS", 1)];
  readonly calls: string[] = [];
  readonly results = new Map<string, { miner: TelegraphMiner; result: Record<string, unknown>; intent: TelegraphIntent; query: string }>();
  private ordinal = 0;

  constructor(
    private readonly verdicts: Array<"SUPPORTED" | "REFUTED" | "UNCERTAIN"> = ["SUPPORTED", "SUPPORTED", "SUPPORTED"],
    private readonly confidence: number | number[] = 0.92,
    configured = true,
    private readonly failDirectMiner: string | null = null,
    private readonly tamperVerification = false,
    private readonly missingConfidenceAt: number | null = null,
    missingConfidenceMappingAt: number | null = null,
  ) {
    this.configured = configured;
    if (missingConfidenceMappingAt !== null) {
      const provider = this.miners[missingConfidenceMappingAt];
      if (provider) {
        provider.signal_mapping = { label_field: "verdict", reason_field: "reason" };
      }
    }
  }

  async discoverMiners(): Promise<TelegraphMiner[]> {
    this.calls.push("discover");
    return this.miners;
  }

  async askAuto(query: string): Promise<TelegraphAskResult> {
    this.calls.push("auto");
    return this.resultFor(this.miners[0], "FACT_CHECK", query);
  }

  async askDirect(minerValue: TelegraphMiner, intent: TelegraphIntent, query: string): Promise<TelegraphAskResult> {
    this.calls.push(`direct:${minerValue.id}:${intent}`);
    if (minerValue.id === this.failDirectMiner) throw new Error("fixture direct failure");
    return this.resultFor(minerValue, intent, query);
  }

  async verifySignal(signalHash: string): Promise<TelegraphSignalLookup> {
    this.calls.push(`verify:${signalHash.slice(-2)}`);
    const stored = this.results.get(signalHash);
    if (!stored) throw new Error("missing fixture signal");
    return {
      signal_hash: signalHash,
      signal: { subnet_id: stored.miner.id, miner_slug: stored.miner.slug, intent_id: stored.intent },
      payload: {
        request: stored.query,
        response: this.tamperVerification ? { ...stored.result, verdict: "REFUTED" } : stored.result,
        subnet_id: stored.miner.id,
        miner_slug: stored.miner.slug,
        intent_id: stored.intent,
      },
      verification: { algorithm: "keccak256", commitment: "payload", verified: true },
    };
  }

  private resultFor(provider: TelegraphMiner, intent: TelegraphIntent, query: string): TelegraphAskResult {
    const index = this.ordinal++;
    const signalHash = `0x${String(index + 1).padStart(64, "0")}`;
    const verdict = this.verdicts[index] ?? this.verdicts.at(-1) ?? "UNCERTAIN";
    const providerConfidence = Array.isArray(this.confidence)
      ? this.confidence[index] ?? this.confidence.at(-1) ?? 0
      : this.confidence;
    const result: Record<string, unknown> = {
      verdict,
      ...(index === this.missingConfidenceAt ? {} : { confidence: providerConfidence }),
      reason: `${verdict}: fixture Telegraph evidence.`,
    };
    this.results.set(signalHash, { miner: provider, result, intent, query });
    return {
      miner_id: provider.id,
      miner_name: provider.slug,
      endpoint: "/proof",
      result,
      cost_usd: 0.01,
      timestamp: NOW.toISOString(),
      ...(index === 0 ? { intent } : {}),
      signal_hash: signalHash,
      payment_response: `settlement-${index}`,
    };
  }
}

function run(client: TelegraphClient, policy = POLICY) {
  return buildPreflight({
    action: `Publish the claim: ${CLAIM}`,
    policy,
    request_id: "REQ-PROOFGATE-1",
  }, { client, now: () => NOW });
}

describe("ProofGate preflight pipeline", () => {
  it("parses the funded-demo call cap strictly within the 1-3 bound", () => {
    expect(resolveMaximumPaidCalls(undefined)).toBe(3);
    expect(resolveMaximumPaidCalls("1")).toBe(1);
    expect(resolveMaximumPaidCalls("2")).toBe(2);
    expect(resolveMaximumPaidCalls(3)).toBe(3);
    expect(() => resolveMaximumPaidCalls("0")).toThrow(/1 through 3/);
    expect(() => resolveMaximumPaidCalls("2.5")).toThrow(/1 through 3/);
    expect(() => resolveMaximumPaidCalls("many")).toThrow(/1 through 3/);
  });

  it("issues ALLOW only after one auto route and distinct, verified paid signals pass every hard rule", async () => {
    const client = new FakeTelegraphClient();
    const response = await run(client);
    expect(response.decision).toBe("ALLOW");
    expect(response.authorization_issued).toBe(true);
    expect(response.schema_version).toBe("proofgate.preflight.v1");
    expect(response.aggregate).toMatchObject({
      confidence: 0.92,
      supporting_signals: 3,
      refuting_signals: 0,
      distinct_miners: 3,
      verified_signals: 3,
      total_cost_usd: 0.03,
    });
    expect(response.signals.map((signal) => signal.miner_id)).toEqual(["101", "202", "303"]);
    expect(response.signals.every((signal) => signal.signal_verified)).toBe(true);
    expect(response.operational).toEqual({ telegraph_configured: true, paid_calls_attempted: 3, paid_calls_succeeded: 3 });
    expect(response.rules.every((rule) => rule.passed)).toBe(true);
    expect(verifyPreflightReceipt(response)).toBe(true);
    expect(validateProofGateChain(response.qarinah)).toHaveLength(5);
    expect(client.calls.slice(0, 4)).toEqual(["discover", "auto", "verify:01", "direct:202:FACT_CHECK"]);
  });

  it("honors a two-call funded-demo cap without attempting a third payment", async () => {
    const client = new FakeTelegraphClient();
    const response = await buildPreflight({
      action: `Publish the claim: ${CLAIM}`,
      policy: POLICY,
    }, { client, now: () => NOW, maximumPaidCalls: 2 });
    expect(response.operational).toEqual({ telegraph_configured: true, paid_calls_attempted: 2, paid_calls_succeeded: 2 });
    expect(response.signals).toHaveLength(2);
    expect(client.calls.some((call) => call === "direct:303:RESEARCH_SYNTHESIS")).toBe(false);
  });

  it("BLOCKs on credible independent refutation", async () => {
    const response = await run(new FakeTelegraphClient(["REFUTED", "REFUTED", "REFUTED"]));
    expect(response.decision).toBe("BLOCK");
    expect(response.authorization_issued).toBe(false);
    expect(response.claims[0].verdict).toBe("REFUTED");
    expect(response.reason_codes).toContain("CREDIBLE_REFUTATION");
  });

  it("ESCALATEs unsupported policy language before considering a BLOCK", async () => {
    const response = await run(
      new FakeTelegraphClient(["REFUTED", "REFUTED", "REFUTED"]),
      `${POLICY} Sources must be personally approved by Ada.`,
    );
    expect(response.claims[0].verdict).toBe("REFUTED");
    expect(response.decision).toBe("ESCALATE");
    expect(response.rules.find((rule) => rule.id === "POLICY_FULLY_COMPILED")?.passed).toBe(false);
  });

  it("BLOCKs a verified conflict only when the policy explicitly asks for it", async () => {
    const response = await run(
      new FakeTelegraphClient(["SUPPORTED", "REFUTED", "SUPPORTED"]),
      "Confidence at least 80%; at least two independent miners support the claim; block on any conflict; otherwise escalate to human review.",
    );
    expect(response.claims[0].verdict).toBe("CONFLICTED");
    expect(response.decision).toBe("BLOCK");
    expect(response.reason_codes).toContain("MATERIAL_CONFLICT");
  });

  it("ESCALATEs low confidence instead of manufacturing a confidence score", async () => {
    const response = await run(new FakeTelegraphClient(undefined, 0.41));
    expect(response.decision).toBe("ESCALATE");
    expect(response.aggregate.confidence).toBe(0.41);
    expect(response.rules.find((rule) => rule.id === "MIN_CONFIDENCE")?.passed).toBe(false);
  });

  it("does not let uncertain Miner confidence boost authorization", async () => {
    const response = await run(new FakeTelegraphClient(
      ["SUPPORTED", "SUPPORTED", "UNCERTAIN"],
      [0.6, 0.6, 1],
    ));
    expect(response.aggregate.confidence).toBe(0.6);
    expect(response.decision).toBe("ESCALATE");
    expect(response.rules.find((rule) => rule.id === "MIN_CONFIDENCE")?.passed).toBe(false);
  });

  it("permits one unmapped auxiliary signal when two aligned miners still map confidence", async () => {
    const response = await run(new FakeTelegraphClient(undefined, 0.95, true, null, false, 1));
    expect(response.decision).toBe("ALLOW");
    expect(response.aggregate.confidence).toBe(0.95);
    expect(response.rules.find((rule) => rule.id === "PROVIDER_CONFIDENCE_COVERAGE")).toMatchObject({
      passed: true,
      actual: 2,
      required: 2,
    });
  });

  it("does not promote an undeclared result confidence field into policy authority", async () => {
    const client = new FakeTelegraphClient(undefined, 0.95, true, null, false, null, 1);
    const response = await buildPreflight({
      action: `Publish the claim: ${CLAIM}`,
      policy: POLICY,
    }, { client, now: () => NOW, maximumPaidCalls: 2 });
    expect(response.signals[1].confidence).toBeNull();
    expect(response.decision).toBe("ESCALATE");
    expect(response.rules.find((rule) => rule.id === "PROVIDER_CONFIDENCE_COVERAGE")?.passed).toBe(false);
  });

  it("allows an auxiliary unmapped signal only when the corroboration floor still has mapped confidence", async () => {
    const response = await run(new FakeTelegraphClient(undefined, 0.95, true, null, false, null, 0));
    expect(response.signals[0].confidence).toBeNull();
    expect(response.rules.find((rule) => rule.id === "PROVIDER_CONFIDENCE_COVERAGE")).toMatchObject({
      passed: true,
      actual: 2,
      required: 2,
    });
    expect(response.decision).toBe("ALLOW");
  });

  it("ESCALATEs partial failures even when the surviving signals look supportive", async () => {
    const response = await run(new FakeTelegraphClient(undefined, 0.95, true, "202"));
    expect(response.decision).toBe("ESCALATE");
    expect(response.operational).toEqual({ telegraph_configured: true, paid_calls_attempted: 2, paid_calls_succeeded: 1 });
    expect(response.reason_codes).toContain("DIRECT_MINER_FAILED");
    expect(response.rules.find((rule) => rule.id === "NO_PARTIAL_FAILURES")?.passed).toBe(false);
  });

  it("stops spending after an auto-route failure makes authorization impossible", async () => {
    const client = new FakeTelegraphClient();
    client.askAuto = async () => {
      client.calls.push("auto");
      throw new Error("fixture auto failure");
    };
    const response = await run(client);
    expect(response.decision).toBe("ESCALATE");
    expect(response.operational).toEqual({ telegraph_configured: true, paid_calls_attempted: 1, paid_calls_succeeded: 0 });
    expect(client.calls.some((call) => call.startsWith("direct:"))).toBe(false);
  });

  it("ESCALATEs when x402 is not configured and attempts no paid call", async () => {
    const response = await run(new FakeTelegraphClient(undefined, 0.92, false));
    expect(response.decision).toBe("ESCALATE");
    expect(response.operational).toEqual({ telegraph_configured: false, paid_calls_attempted: 0, paid_calls_succeeded: 0 });
    expect(response.signals).toEqual([]);
    expect(response.reason_codes).toContain("TELEGRAPH_NOT_CONFIGURED");
    expect(verifyPreflightReceipt(response)).toBe(true);
  });

  it("does not alias different actions that reuse a caller request ID", async () => {
    const first = await buildPreflight({
      action: "Publish the claim: The telescope launched in 2021.",
      policy: POLICY,
      request_id: "REUSED-ID",
    }, { client: new FakeTelegraphClient(undefined, 0.92, false), now: () => NOW });
    const second = await buildPreflight({
      action: "Publish the claim: The telescope launched in 2020.",
      policy: POLICY,
      request_id: "REUSED-ID",
    }, { client: new FakeTelegraphClient(undefined, 0.92, false), now: () => NOW });
    expect(first.action_id).not.toBe(second.action_id);
    expect(first.qarinah.workspace_id).not.toBe(second.qarinah.workspace_id);
  });

  it("ESCALATEs when the node's lookup does not commit to the returned result", async () => {
    const response = await run(new FakeTelegraphClient(undefined, 0.92, true, null, true));
    expect(response.decision).toBe("ESCALATE");
    expect(response.signals.every((signal) => !signal.signal_verified)).toBe(true);
    expect(response.reason_codes).toContain("SIGNAL_VERIFICATION_FAILED");
  });

  it("routes final authorization through Maqam and fails closed on a policy denial", async () => {
    const response = await buildPreflight({
      action: `Publish the claim: ${CLAIM}`,
      policy: POLICY,
      request_id: "REQ-MAQAM-DENY",
    }, {
      client: new FakeTelegraphClient(),
      now: () => NOW,
      maqamPolicyEngine: {
        authorizeToolCall: (input) => {
          expect(input.toolName).toBe("proofgate.authorize-action");
          expect(input.metadata).toEqual({ effects: ["authorize"], risk: "low" });
          return { status: "deny", reason: "fixture deny", limits: {}, requiredApprovals: [] };
        },
      },
    });
    expect(response.decision).toBe("ESCALATE");
    expect(response.authorization_issued).toBe(false);
    expect(response.reason_codes).toContain("MAQAM_AUTHORIZATION_DENIED");
    expect(response.rules.find((rule) => rule.id === "MAQAM_AUTHORIZATION_BOUNDARY")).toMatchObject({
      passed: false,
      actual: "deny",
      required: "allow",
    });
  });

  it("counts distinct verified miners, not duplicate receipts, for credible refutation", async () => {
    const base = await run(new FakeTelegraphClient());
    const first = structuredClone(base.signals[0]);
    first.stance = "REFUTES";
    first.claim_assessments[0].stance = "REFUTES";
    const duplicate = structuredClone(first);
    duplicate.signal_hash = `0x${"f".repeat(64)}`;
    const normalizedClaim = base.claims[0].claim;
    const claims = buildClaimResults([normalizedClaim], [first, duplicate], 1);
    expect(claims[0]).toMatchObject({
      verdict: "UNCERTAIN",
      supporting_signals: 0,
      refuting_signals: 1,
    });
    expect(claims[0].signal_hashes).toHaveLength(2);
  });

  it("rejects a direct response whose miner identity differs from the requested miner", async () => {
    const client = new FakeTelegraphClient();
    const original = client.askDirect.bind(client);
    client.askDirect = async (provider: TelegraphMiner, intent: TelegraphIntent, query: string) => ({
      ...await original(provider, intent, query),
      miner_id: "unexpected-miner",
    });
    const response = await run(client);
    expect(response.decision).toBe("ESCALATE");
    expect(response.reason_codes).toContain("DIRECT_MINER_FAILED");
    expect(response.operational.paid_calls_attempted).toBe(2);
    expect(response.operational.paid_calls_succeeded).toBe(1);
  });

  it("verifies receipt metadata, exact signal list, and the embedded Qarinah chain", async () => {
    const response = await run(new FakeTelegraphClient());

    const canonicalization = structuredClone(response);
    (canonicalization.receipt as { canonicalization: string }).canonicalization = "other";
    expect(verifyPreflightReceipt(canonicalization)).toBe(false);

    const hashes = structuredClone(response);
    hashes.receipt.telegraph_signal_hashes.reverse();
    expect(verifyPreflightReceipt(hashes)).toBe(false);

    const chain = structuredClone(response);
    chain.qarinah.events[0].title = "tampered";
    expect(verifyPreflightReceipt(chain)).toBe(false);
  });
});
