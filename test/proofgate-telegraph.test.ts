import { describe, expect, it } from "vitest";

import { hashCanonical } from "@/lib/proof/canonical";
import { inferSignalStance, normalizeSignalReceipt } from "@/lib/proofgate/normalize";
import {
  buildDirectRequest,
  parseMinerCatalog,
  selectCappedBaseSepoliaPayment,
  selectDirectMiners,
  TelegraphHttpClient,
} from "@/lib/proofgate/telegraph";
import type { PaymentRequirements } from "@x402/fetch";
import type { TelegraphMiner } from "@/lib/proofgate/types";

function miner(id: string, slug: string, intent: "FACT_CHECK" | "RESEARCH_SYNTHESIS", rank: number): TelegraphMiner {
  return {
    id,
    slug,
    name: slug,
    endpoints: [{ path: "/check", method: "POST" }],
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    output_schema: null,
    signal_mapping: { confidence_field: "confidence", label_field: "verdict", reason_field: "reason" },
    supported_intents: [intent],
    activation_status: "active",
    min_price_usdc: 10_000,
    scores: [{ intent_id: intent, rank }],
  };
}

describe("Telegraph discovery and normalization", () => {
  it("accepts only exact official Base Sepolia USDC challenges within the cap", () => {
    const base = {
      scheme: "exact",
      network: "eip155:84532",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      amount: "10000",
      payTo: "0x5a2324aA18613FAD4e44bDF0d6c73Ec1f6D87ff8",
      maxTimeoutSeconds: 60,
      extra: {},
    } as PaymentRequirements;
    const zeroAmount = { ...base, amount: "0" };
    const wrongScheme = { ...base, scheme: "upto", amount: "1" };
    const wrongAsset = { ...base, asset: "0x0000000000000000000000000000000000000000", amount: "2" };
    expect(selectCappedBaseSepoliaPayment([zeroAmount, wrongScheme, wrongAsset, base], 50_000n)).toBe(base);
    expect(() => selectCappedBaseSepoliaPayment([zeroAmount, wrongScheme, wrongAsset], 50_000n)).toThrow(/exact Base Sepolia USDC/);
    expect(() => selectCappedBaseSepoliaPayment([base], 9_999n)).toThrow(/payment cap/);
    expect(() => new TelegraphHttpClient({
      privateKey: `0x${"1".repeat(64)}`,
      maximumPaymentMicros: 100_001n,
    })).toThrow(/between 1 and 100000/);
  });

  it("parses catalog data and plans direct calls from declared schema rather than IDs", () => {
    const parsed = parseMinerCatalog([{
      id: "dynamic-91",
      slug: "current-miner",
      name: "Current Miner",
      endpoints: [{ path: "/search", method: "POST" }],
      input_schema: { type: "object", properties: { question: { type: "string" } }, required: ["question"] },
      signal_mapping: { label_field: "verdict" },
      supported_intents: ["FACT_CHECK"],
      activation_status: "active",
    }]);
    expect(parsed).toHaveLength(1);
    expect(buildDirectRequest(parsed[0], "Is the claim true?")).toEqual({
      method: "POST",
      endpoint: "/search",
      payload: { question: "Is the claim true?" },
    });
  });

  it("refuses to guess payloads for miners with absent or unmet schemas", () => {
    const missing = { ...miner("1", "missing", "FACT_CHECK", 1), input_schema: null };
    const required = {
      ...miner("2", "required", "FACT_CHECK", 2),
      input_schema: {
        type: "object",
        properties: { query: { type: "string" }, api_token: { type: "string" } },
        required: ["query", "api_token"],
      },
    };
    expect(buildDirectRequest(missing, "claim")).toBeNull();
    expect(buildDirectRequest(required, "claim")).toBeNull();
    expect(buildDirectRequest({ ...miner("3", "network-path", "FACT_CHECK", 3), endpoints: [{ path: "//attacker.test", method: "POST" }] }, "claim")).toBeNull();
    expect(buildDirectRequest({ ...miner("4", "dot-path", "FACT_CHECK", 4), endpoints: [{ path: "/safe/../admin", method: "POST" }] }, "claim")).toBeNull();
  });

  it("selects current, distinct miners by live rank across the two supported intents", () => {
    const miners = [
      miner("auto", "auto", "FACT_CHECK", 1),
      miner("fact-2", "fact-2", "FACT_CHECK", 2),
      miner("research-1", "research-1", "RESEARCH_SYNTHESIS", 1),
    ];
    expect(selectDirectMiners(miners, new Set(["auto"]), "Verify the telescope launch date.")).toEqual([
      { miner: miners[1], intent: "FACT_CHECK" },
      { miner: miners[2], intent: "RESEARCH_SYNTHESIS" },
    ]);
  });

  it("does not pay a declared employment-only miner for general research", () => {
    const jobMiner = {
      ...miner("jobs", "legwork-job-hunter", "RESEARCH_SYNTHESIS", 1),
      description: "Live job search and application writing. Do not route here for general web search or academic research.",
      endpoints: [{ path: "/job-hunt", method: "POST", description: "Search job boards for open roles." }],
    };
    const generalMiner = {
      ...miner("research", "general-research", "RESEARCH_SYNTHESIS", 2),
      description: "Evidence-aware general web research and source-backed synthesis.",
      endpoints: [{ path: "/synthesis", method: "POST" }],
    };
    expect(selectDirectMiners(
      [jobMiner, generalMiner],
      new Set(),
      "Verify when the James Webb Space Telescope launched.",
    )).toEqual([{ miner: generalMiner, intent: "RESEARCH_SYNTHESIS" }]);
    expect(selectDirectMiners(
      [jobMiner, generalMiner],
      new Set(),
      "Verify which companies are hiring backend engineers for remote jobs.",
      1,
    )).toEqual([{ miner: jobMiner, intent: "RESEARCH_SYNTHESIS" }]);
  });

  it("prefers a confidence-mapped corroborator over an auxiliary higher-ranked result", () => {
    const auxiliary = {
      ...miner("aux", "auxiliary-search", "FACT_CHECK", 1),
      signal_mapping: { label_field: "answer", reason_field: "results" },
    };
    const authoritative = miner("mapped", "mapped-proof", "FACT_CHECK", 9);
    expect(selectDirectMiners(
      [auxiliary, authoritative],
      new Set(),
      "Verify the launch date.",
      1,
    )).toEqual([{ miner: authoritative, intent: "FACT_CHECK" }]);
  });

  it("accepts a signal only when the lookup commits to the exact returned result", () => {
    const provider = miner("42", "proof-miner", "FACT_CHECK", 4);
    const result = { verdict: "SUPPORTED", confidence: 0.94, reason: "Two sources confirm the claim." };
    const signalHash = `0x${"a".repeat(64)}`;
    const expectedQuery = "FACT_CHECK this claim.";
    const receipt = normalizeSignalReceipt({
      ask: {
        miner_id: provider.id,
        miner_name: provider.slug,
        endpoint: "/check",
        result,
        cost_usd: 0.01,
        timestamp: "2026-08-31T12:00:00Z",
        intent: "FACT_CHECK",
        signal_hash: signalHash,
        payment_response: "settlement-proof",
      },
      lookup: {
        signal_hash: signalHash,
        signal: { subnet_id: provider.id, miner_slug: provider.slug, intent_id: "FACT_CHECK" },
        payload: { request: expectedQuery, response: result, subnet_id: provider.id, miner_slug: provider.slug, intent_id: "FACT_CHECK" },
        verification: { algorithm: "keccak256", commitment: "payload", verified: true },
      },
      miner: provider,
      routeMode: "AUTO",
      requestedIntent: "FACT_CHECK",
      claims: ["The telescope launched in 2021."],
      expectedQuery,
      checkedAt: "2026-08-31T12:00:01Z",
    });
    expect(receipt).toMatchObject({
      miner_id: "42",
      rank_at_request: 4,
      signal_verified: true,
      confidence: 0.94,
      stance: "SUPPORTS",
      result_hash: hashCanonical(result),
    });
    expect(receipt?.payment_response_hash).toMatch(/^sha256:/);

    const malformedMetadata = normalizeSignalReceipt({
      ask: {
        miner_id: provider.id,
        miner_name: provider.slug,
        result,
        cost_usd: -7,
        timestamp: "not-a-timestamp",
        intent: "FACT_CHECK",
        signal_hash: signalHash,
      },
      lookup: {
        signal_hash: signalHash,
        signal: { subnet_id: provider.id, miner_slug: provider.slug, intent_id: "FACT_CHECK" },
        payload: { request: expectedQuery, response: result, subnet_id: provider.id, miner_slug: provider.slug, intent_id: "FACT_CHECK" },
        verification: { algorithm: "keccak256", commitment: "payload", verified: true },
      },
      miner: { ...provider, scores: [{ intent_id: "FACT_CHECK", rank: -1.5 }] },
      routeMode: "AUTO",
      requestedIntent: "FACT_CHECK",
      claims: ["The telescope launched in 2021."],
      expectedQuery,
      checkedAt: "2026-08-31T12:00:01Z",
    });
    expect(malformedMetadata).toMatchObject({ cost_usd: null, timestamp: null, rank_at_request: null });

    const tampered = normalizeSignalReceipt({
      ask: {
        miner_id: provider.id,
        miner_name: provider.slug,
        result,
        intent: "FACT_CHECK",
        signal_hash: signalHash,
      },
      lookup: {
        signal_hash: signalHash,
        signal: { subnet_id: provider.id, miner_slug: provider.slug, intent_id: "FACT_CHECK" },
        payload: { request: expectedQuery, response: { ...result, verdict: "REFUTED" }, subnet_id: provider.id, miner_slug: provider.slug, intent_id: "FACT_CHECK" },
        verification: { algorithm: "keccak256", commitment: "payload", verified: true },
      },
      miner: provider,
      routeMode: "AUTO",
      requestedIntent: "FACT_CHECK",
      claims: ["The telescope launched in 2021."],
      expectedQuery,
      checkedAt: "2026-08-31T12:00:01Z",
    });
    expect(tampered?.signal_verified).toBe(false);

    const missingIdentity = normalizeSignalReceipt({
      ask: {
        miner_id: provider.id,
        miner_name: provider.slug,
        result,
        intent: "FACT_CHECK",
        signal_hash: signalHash,
      },
      lookup: {
        signal_hash: signalHash,
        signal: { miner_slug: provider.slug, intent_id: "FACT_CHECK" },
        payload: { request: expectedQuery, response: result, subnet_id: provider.id, miner_slug: provider.slug, intent_id: "FACT_CHECK" },
        verification: { algorithm: "keccak256", commitment: "payload", verified: true },
      },
      miner: provider,
      routeMode: "AUTO",
      requestedIntent: "FACT_CHECK",
      claims: ["The telescope launched in 2021."],
      expectedQuery,
      checkedAt: "2026-08-31T12:00:01Z",
    });
    expect(missingIdentity?.signal_verified).toBe(false);

    const replayedForAnotherQuery = normalizeSignalReceipt({
      ask: {
        miner_id: provider.id,
        miner_name: provider.slug,
        result,
        intent: "FACT_CHECK",
        signal_hash: signalHash,
      },
      lookup: {
        signal_hash: signalHash,
        signal: { subnet_id: provider.id, miner_slug: provider.slug, intent_id: "FACT_CHECK" },
        payload: {
          request: "FACT_CHECK a different claim.",
          response: result,
          subnet_id: provider.id,
          miner_slug: provider.slug,
          intent_id: "FACT_CHECK",
        },
        verification: { algorithm: "keccak256", commitment: "payload", verified: true },
      },
      miner: provider,
      routeMode: "AUTO",
      requestedIntent: "FACT_CHECK",
      claims: ["The telescope launched in 2021."],
      expectedQuery,
      checkedAt: "2026-08-31T12:00:01Z",
    });
    expect(replayedForAnotherQuery?.signal_verified).toBe(false);
  });

  it("treats negated labels and reason-only refusals conservatively", () => {
    const claim = "The telescope launched in 2021";
    expect(inferSignalStance("not supported", "", claim)).toBe("UNCERTAIN");
    expect(inferSignalStance("Evidence does not support the claim", "", claim)).toBe("UNCERTAIN");
    expect(inferSignalStance("not supported by available sources", "", claim)).toBe("UNCERTAIN");
    expect(inferSignalStance("unsupported", "", claim)).toBe("UNCERTAIN");
    expect(inferSignalStance("No credible source confirms the claim", "", claim)).toBe("UNCERTAIN");
    expect(inferSignalStance("The claim is not true", "", claim)).toBe("REFUTES");
    expect(inferSignalStance(null, `Insufficient evidence for ${claim}`, claim)).toBe("UNCERTAIN");
    expect(inferSignalStance(`Insufficient evidence for ${claim}`, null, claim)).toBe("UNCERTAIN");
    expect(inferSignalStance(`I cannot verify whether ${claim}`, null, claim)).toBe("UNCERTAIN");
    expect(inferSignalStance(`There is no clear information that ${claim}`, null, claim)).toBe("UNCERTAIN");
    expect(inferSignalStance(`There is no support for ${claim}`, null, claim)).toBe("UNCERTAIN");
    expect(inferSignalStance("SUPPORTED: multiple sources confirm the date.", null, claim)).toBe("SUPPORTS");
    expect(inferSignalStance("REFUTED: the actual date differs.", null, claim)).toBe("REFUTES");
  });
});
