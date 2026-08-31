import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";

import { buildPreflight } from "@/lib/proofgate/pipeline";
import type { TelegraphClient } from "@/lib/proofgate/types";

const offlineClient: TelegraphClient = {
  configured: false,
  async discoverMiners() { return []; },
  async askAuto() { throw new Error("must not be called"); },
  async askDirect() { throw new Error("must not be called"); },
  async verifySignal() { throw new Error("must not be called"); },
};

describe("ProofGate public JSON contract", () => {
  it("ships a closed Draft 2020-12 schema that validates a sealed fail-closed response", async () => {
    const schema = JSON.parse(
      readFileSync(resolve(process.cwd(), "schemas/proofgate.preflight.v1.schema.json"), "utf8"),
    ) as Record<string, unknown>;
    const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true, strict: true });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    const response = await buildPreflight({
      action: "Publish the claim: The James Webb Space Telescope launched in 2021.",
      policy: "Allow only when mapped provider confidence is at least 80%, at least two independent miners support the claim, and there is no material conflict. Otherwise escalate to human review.",
      request_id: "SCHEMA-CHECK",
    }, { client: offlineClient, now: () => new Date("2026-08-31T12:00:00.000Z") });

    expect(validate(response), JSON.stringify(validate.errors, null, 2)).toBe(true);
    expect(validate({ ...response, unexpected: true })).toBe(false);
    expect(schema.additionalProperties).toBe(false);
    expect(schema).toHaveProperty("$defs.signal.additionalProperties", false);
    expect(schema).toHaveProperty("$defs.qarinahEvent.additionalProperties", false);
  });
});
