import { describe, expect, it } from "vitest";

import { POST } from "@/app/api/preflight/route";

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
});
