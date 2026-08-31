import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_RATE_LIMIT_BUCKETS,
  checkRateLimit,
  clearRateLimits
} from "@/lib/rate-limit";

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

  it("evicts the least-recently-used active buckets when capacity is reached", () => {
    for (let index = 0; index < MAX_RATE_LIMIT_BUCKETS; index += 1) {
      checkRateLimit(`client-${index}`, {
        limit: 1,
        windowMs: 60_000,
        now: 1_000
      });
    }

    checkRateLimit("overflow-client", { limit: 1, windowMs: 60_000, now: 1_001 });

    expect(checkRateLimit("client-0", { limit: 1, now: 1_002 }).allowed).toBe(true);
    expect(
      checkRateLimit(`client-${MAX_RATE_LIMIT_BUCKETS - 1}`, { limit: 1, now: 1_002 }).allowed
    ).toBe(false);
  });

  it("retains a recently touched bucket during deterministic LRU eviction", () => {
    for (let index = 0; index < MAX_RATE_LIMIT_BUCKETS; index += 1) {
      checkRateLimit(`client-${index}`, {
        limit: 2,
        windowMs: 60_000,
        now: 1_000
      });
    }

    expect(checkRateLimit("client-0", { limit: 2, now: 1_001 }).allowed).toBe(true);
    checkRateLimit("overflow-client", { limit: 1, windowMs: 60_000, now: 1_002 });

    expect(checkRateLimit("client-0", { limit: 2, now: 1_003 }).allowed).toBe(false);
    expect(checkRateLimit("client-1", { limit: 1, now: 1_003 }).allowed).toBe(true);
  });
});
