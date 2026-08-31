import { beforeEach, describe, expect, it } from "vitest";

import { POST } from "@/app/v1/verify/route";
import { clearRateLimits } from "@/lib/rate-limit";

function request(body: BodyInit, headers: Record<string, string> = {}): Request {
  return new Request("https://proofpack.example/v1/verify", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": "203.0.113.10",
      ...headers,
    },
    body,
  });
}

describe("POST /v1/verify hardening", () => {
  beforeEach(clearRateLimits);

  it("rejects a declared oversized body before reading it", async () => {
    const response = await POST(request("{}", { "content-length": String(2 * 1024 * 1024 + 1) }));
    const payload = await response.json();

    expect(response.status).toBe(413);
    expect(payload.error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("rejects a streamed body that exceeds the byte budget", async () => {
    const response = await POST(request(new Uint8Array(2 * 1024 * 1024 + 1)));
    const payload = await response.json();

    expect(response.status).toBe(413);
    expect(payload.error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("returns bounded contract errors for untrusted JSON", async () => {
    const response = await POST(request(JSON.stringify({ evidence: Array.from({ length: 1_000 }, () => ({})) })));
    const payload = await response.json();

    expect(response.status).toBe(422);
    expect(payload.valid).toBe(false);
    expect(payload.errors.length).toBeLessThanOrEqual(128);
  });

  it("rate-limits repeated anonymous verification work", async () => {
    for (let index = 0; index < 30; index += 1) {
      const response = await POST(request("{}"));
      expect(response.status).toBe(422);
    }

    const response = await POST(request("{}"));
    const payload = await response.json();
    expect(response.status).toBe(429);
    expect(payload.error.code).toBe("RATE_LIMITED");
    expect(response.headers.get("ratelimit-remaining")).toBe("0");
  });
});
