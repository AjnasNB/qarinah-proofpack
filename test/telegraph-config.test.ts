import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  parseMinerYaml,
  renderMinerYaml,
  sha256Yaml,
  TELEGRAPH_INTENTS,
  TELEGRAPH_MINER_ID,
  TELEGRAPH_MINER_SLUG,
  TELEGRAPH_TEMPLATE_TOKEN,
  validateLiveIntents,
  validateMinerConfig,
  validatePublicBaseUrl,
  validateRegistryAvailability,
} from "../telegraph/config.mjs";

interface SchemaNode {
  type?: string;
  maxLength?: number;
  enum?: string[];
  items?: SchemaNode;
  properties?: Record<string, SchemaNode>;
  required?: string[];
}

interface TelegraphConfigShape {
  version: string;
  kind: string;
  id: number;
  slug: string;
  protocol: string;
  base_url: string;
  auth: Record<string, unknown>;
  docs: Record<string, unknown>;
  endpoints: Array<{
    path: string;
    external_path: string;
    method: string;
    content_type: string;
    intents: string[];
    params: {
      body: {
        required: Array<{ name: string; type: string; intents: string[] }>;
      };
    };
  }>;
  input_schema: SchemaNode & { additionalProperties: boolean };
  output_schema: SchemaNode & { additionalProperties: boolean };
  semantics: {
    signal_mapping: Record<string, string>;
    supported_intents: string[];
  };
  on_chain: {
    transform: string;
    min_price_usdc: number;
    fields: Record<string, Array<{
      index: number;
      name: string;
      source_path: string;
      multiplier?: number;
    }>>;
    request: Array<{
      endpoint: string;
      method: string;
      body: Record<string, { source: string }>;
    }>;
  };
}

const templatePath = resolve(process.cwd(), "telegraph", "miner.yaml");
const template = readFileSync(templatePath, "utf8");
const publicUrl = "https://proofpack.qarinah.dev";

function configured(): TelegraphConfigShape {
  const rendered = renderMinerYaml(template, publicUrl);
  return validateMinerConfig(parseMinerYaml(rendered)) as unknown as TelegraphConfigShape;
}

describe("Telegraph Miner template", () => {
  it("contains one deliberate deployment token and renders a public HTTPS origin", () => {
    expect(template.split(TELEGRAPH_TEMPLATE_TOKEN)).toHaveLength(2);
    const rendered = renderMinerYaml(template, `${publicUrl}/`);

    expect(rendered).not.toContain("${");
    expect(configured().base_url).toBe(publicUrl);
  });

  it("declares the exact ProofPack identity and one intent-routable endpoint", () => {
    const config = configured();
    const endpoint = config.endpoints[0];

    expect(config).toMatchObject({
      version: "1",
      kind: "miner",
      protocol: "generic",
      id: TELEGRAPH_MINER_ID,
      slug: TELEGRAPH_MINER_SLUG,
      auth: { type: "none" },
    });
    expect(config.docs.repository).toBe("https://github.com/AjnasNB/qarinah-proofpack");
    expect(endpoint).toMatchObject({
      path: "/v1/proof",
      external_path: "/v1/proof",
      method: "POST",
      content_type: "application/json",
      intents: [...TELEGRAPH_INTENTS],
    });
    expect(endpoint.params.body.required).toEqual([
      expect.objectContaining({ name: "query", type: "string", intents: ["*"] }),
    ]);
  });

  it("keeps schemas top-level and matches the implemented request contract", () => {
    const config = configured();

    expect(config.input_schema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: { type: "string", maxLength: 2048 },
      },
    });
    expect(config.output_schema.required).toEqual(expect.arrayContaining([
      "verdict",
      "confidence",
      "evidence",
      "contradictions",
      "qarinah",
      "abstained",
      "verification",
    ]));
    expect(
      config.output_schema.properties?.evidence?.items?.properties?.source_type?.enum,
    ).toEqual([
      "official",
      "government",
      "academic",
      "news",
      "primary",
      "secondary",
      "crawler",
      "rendered",
      "other",
    ]);
    expect(config.endpoints[0]).not.toHaveProperty("input_schema");
    expect(config.endpoints[0]).not.toHaveProperty("output_schema");
  });

  it("uses only Telegraph's three supported signal-mapping fields", () => {
    const mapping = configured().semantics.signal_mapping;

    expect(mapping).toEqual({
      confidence_field: "confidence",
      label_field: "verdict",
      reason_field: "reason",
    });
    expect(Object.keys(mapping).sort()).toEqual([
      "confidence_field",
      "label_field",
      "reason_field",
    ]);
  });

  it("projects the evidence gate through a deterministic direct on-chain transform", () => {
    const onChain = configured().on_chain;

    expect(onChain.transform).toBe("direct");
    expect(onChain.min_price_usdc).toBe(0.01);
    expect(onChain.fields.strings.map((field) => field.source_path)).toEqual([
      "verdict",
      "pack_id",
      "verification.manifest_hash",
      "verification.event_chain_head",
    ]);
    expect(onChain.fields.integers.map((field) => [field.source_path, field.multiplier])).toEqual([
      ["confidence", 10_000],
      ["coverage_score", 10_000],
      ["freshness_score", 10_000],
      ["conflict_score", 10_000],
    ]);
    expect(onChain.fields.bools.map((field) => field.source_path)).toEqual(["abstained"]);
    expect(onChain.request).toEqual([
      { endpoint: "proof", method: "POST", body: { query: { source: "strings.0" } } },
    ]);
  });

  it("produces a deterministic SHA-256 registration commitment", () => {
    const rendered = renderMinerYaml(template, publicUrl);
    const first = sha256Yaml(rendered);
    const second = sha256Yaml(rendered);

    expect(first).toEqual(second);
    expect(first.digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(first.prefixed).toBe(`0x${first.digest}`);
    expect(first.contentHash).toBe(`sha256:${first.digest}`);
  });
});

describe("Telegraph validation guardrails", () => {
  it.each([
    "http://proofpack.qarinah.dev",
    "https://localhost",
    "https://127.0.0.1",
    "https://192.168.1.5",
    "https://proofpack.example",
    "https://example.com",
    "https://proofpack.qarinah.dev/path",
    TELEGRAPH_TEMPLATE_TOKEN,
  ])("rejects a non-registration base URL: %s", (value) => {
    expect(() => validatePublicBaseUrl(value)).toThrow();
  });

  it("rejects unresolved, missing, or repeated template tokens", () => {
    expect(() => renderMinerYaml("base_url: https://proofpack.qarinah.dev", publicUrl)).toThrow(
      "exactly once",
    );
    expect(() => renderMinerYaml(`${template}\nmirror: "${TELEGRAPH_TEMPLATE_TOKEN}"\n`, publicUrl)).toThrow(
      "exactly once",
    );
  });

  it("rejects semantic fields outside Telegraph's closed signal_mapping set", () => {
    const config = structuredClone(configured());
    config.semantics.signal_mapping.type = "fact_check";

    expect(() => validateMinerConfig(config)).toThrow("unsupported field type");
  });

  it("validates canonical intents from the live endpoint shape", () => {
    const counts = validateLiveIntents({
      intents: [
        { intent_id: "FACT_CHECK", canonical: true, miner_count: 2 },
        { intent_id: "RESEARCH_SYNTHESIS", canonical: true, miner_count: 3 },
      ],
    });

    expect(counts).toEqual({ FACT_CHECK: 2, RESEARCH_SYNTHESIS: 3 });
    expect(() => validateLiveIntents({
      intents: [{ intent_id: "FACT_CHECK", canonical: true, miner_count: 2 }],
    })).toThrow("RESEARCH_SYNTHESIS");
  });

  it("detects ID and slug collisions but recognizes the same registered Miner", () => {
    const config = configured();

    expect(validateRegistryAvailability([], config)).toEqual({
      available: true,
      alreadyRegistered: false,
      minerCount: 0,
    });
    expect(() => validateRegistryAvailability([
      { id: String(TELEGRAPH_MINER_ID), slug: "another-miner" },
    ], config)).toThrow("already used");
    expect(() => validateRegistryAvailability([
      { id: "42", slug: TELEGRAPH_MINER_SLUG },
    ], config)).toThrow("already registered");
    expect(validateRegistryAvailability([
      { id: String(TELEGRAPH_MINER_ID), slug: TELEGRAPH_MINER_SLUG },
    ], config)).toMatchObject({ available: false, alreadyRegistered: true });
  });
});
