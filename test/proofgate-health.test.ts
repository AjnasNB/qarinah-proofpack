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
      payer_configured: false,
      runtime_mode: "safety-mode",
    });
  });

  it("does not claim live x402 when a valid-looking key has an invalid payment cap", async () => {
    vi.stubEnv("TELEGRAPH_EVM_PRIVATE_KEY", `0x${"1".repeat(64)}`);
    vi.stubEnv("TELEGRAPH_MAX_PAYMENT_USDC_MICROS", "0");
    const response = await GET();
    expect((await response.json()).surfaces.preflight).toMatchObject({
      payer_configured: false,
      runtime_mode: "safety-mode",
    });
  });

  it("locks a valid payer until the durable spend guard is configured", async () => {
    vi.stubEnv("TELEGRAPH_EVM_PRIVATE_KEY", `0x${"1".repeat(64)}`);
    vi.stubEnv("TELEGRAPH_MAX_PAYMENT_USDC_MICROS", "50000");
    const response = await GET();
    expect((await response.json()).surfaces.preflight).toMatchObject({
      payer_configured: true,
      spend_guard_configured: false,
      runtime_mode: "payer-locked",
      note: expect.stringContaining("payer is locked"),
    });
  });

  it("reports x402-ready only when payer, durable store, and tester keys are valid", async () => {
    vi.stubEnv("TELEGRAPH_EVM_PRIVATE_KEY", `0x${"1".repeat(64)}`);
    vi.stubEnv("TELEGRAPH_MAX_PAYMENT_USDC_MICROS", "50000");
    vi.stubEnv("PROOFGATE_REDIS_REST_URL", "https://example.upstash.io");
    vi.stubEnv("PROOFGATE_REDIS_REST_TOKEN", "token-with-at-least-sixteen-characters");
    vi.stubEnv("PROOFGATE_ACCESS_KEY_HASHES", `sha256:${"a".repeat(64)}`);
    const response = await GET();
    expect((await response.json()).surfaces.preflight).toMatchObject({
      payer_configured: true,
      spend_guard_configured: true,
      access_required: true,
      runtime_mode: "x402-ready",
      note: expect.stringContaining("successful paid Telegraph preflight"),
    });
  });
});
