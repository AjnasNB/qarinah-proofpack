import { afterEach, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/api/preflight/route";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/preflight", () => {
  it("requires application/json", async () => {
    const response = await POST(new Request("http://localhost/api/preflight", {
      method: "POST",
      headers: { "content-type": "text/plain", "x-forwarded-for": "proofgate-route-media" },
      body: "action=publish",
    }));
    expect(response.status).toBe(415);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(await response.json()).toMatchObject({ error: { code: "UNSUPPORTED_MEDIA_TYPE" } });
  });

  it("rejects unknown fields and oversized claim sets before any paid call", async () => {
    const response = await POST(new Request("http://localhost/api/preflight", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "proofgate-route-schema" },
      body: JSON.stringify({ action: "Publish a factual claim", policy: "Require two miners", admin: true }),
    }));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });
  });

  it("locks a configured payer when the durable spend guard is absent", async () => {
    vi.stubEnv("TELEGRAPH_EVM_PRIVATE_KEY", `0x${"1".repeat(64)}`);
    vi.stubEnv("TELEGRAPH_MAX_PAYMENT_USDC_MICROS", "50000");
    const response = await POST(new Request("http://localhost/api/preflight", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "proofgate-route-guard" },
      body: JSON.stringify({
        action: "Publish the claim: The telescope launched in 2021.",
        policy: "Require two miners and otherwise escalate.",
        request_id: "guard-required-1",
      }),
    }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "SPEND_GUARD_NOT_READY" } });
  });

  it("requires an idempotency key before guarded paid execution", async () => {
    vi.stubEnv("TELEGRAPH_EVM_PRIVATE_KEY", `0x${"1".repeat(64)}`);
    vi.stubEnv("TELEGRAPH_MAX_PAYMENT_USDC_MICROS", "50000");
    const response = await POST(new Request("http://localhost/api/preflight", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "proofgate-route-idempotency" },
      body: JSON.stringify({
        action: "Publish the claim: The telescope launched in 2021.",
        policy: "Require two miners and otherwise escalate.",
      }),
    }));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { code: "REQUEST_ID_REQUIRED" } });
  });
});
