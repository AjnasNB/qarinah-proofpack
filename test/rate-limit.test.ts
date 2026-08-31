import { beforeEach, describe, expect, it } from "vitest";
import { checkRateLimit, clearRateLimits } from "@/lib/rate-limit";

describe("checkRateLimit", () => {
  beforeEach(clearRateLimits);

  it("blocks requests above the fixed window limit", () => {
    expect(checkRateLimit("client", { limit: 2, now: 1_000 }).allowed).toBe(true);
    expect(checkRateLimit("client", { limit: 2, now: 1_001 }).allowed).toBe(true);
    expect(checkRateLimit("client", { limit: 2, now: 1_002 }).allowed).toBe(false);
  });

  it("starts a fresh bucket after reset", () => {
    checkRateLimit("client", { limit: 1, windowMs: 10, now: 1_000 });
    expect(checkRateLimit("client", { limit: 1, windowMs: 10, now: 1_011 }).allowed).toBe(true);
  });
});
