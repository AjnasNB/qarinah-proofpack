import { afterEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/health/route";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /health ProofGate configuration", () => {
  it("reports escalate-only for a malformed Telegraph payer key", async () => {
    vi.stubEnv("TELEGRAPH_EVM_PRIVATE_KEY", "not-a-private-key");
    const response = await GET();
    expect((await response.json()).surfaces.preflight).toMatchObject({
      telegraph_configured: false,
      authorization_mode: "escalate-only",
    });
  });

  it("does not claim live x402 when a valid-looking key has an invalid payment cap", async () => {
    vi.stubEnv("TELEGRAPH_EVM_PRIVATE_KEY", `0x${"1".repeat(64)}`);
    vi.stubEnv("TELEGRAPH_MAX_PAYMENT_USDC_MICROS", "0");
    const response = await GET();
    expect((await response.json()).surfaces.preflight).toMatchObject({
      telegraph_configured: false,
      authorization_mode: "escalate-only",
    });
  });
});
