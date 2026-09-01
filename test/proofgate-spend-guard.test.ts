import { afterEach, describe, expect, it, vi } from "vitest";

import {
  authenticateSpendPrincipal,
  finalizePaidPreflight,
  hashAccessKey,
  readSpendGuardConfig,
  reservePaidPreflight,
  spendGuardStatus,
} from "@/lib/proofgate/spend-guard";
import type { PreflightResponse } from "@/lib/proofgate/types";

afterEach(() => {
  vi.unstubAllEnvs();
});

function configure() {
  const secret = "pg_test_abcdefghijklmnopqrstuvwxyz";
  vi.stubEnv("PROOFGATE_REDIS_REST_URL", "https://example.upstash.io");
  vi.stubEnv("PROOFGATE_REDIS_REST_TOKEN", "token-with-at-least-sixteen-characters");
  vi.stubEnv("PROOFGATE_ACCESS_KEY_HASHES", hashAccessKey(secret));
  const config = readSpendGuardConfig();
  if (!config) throw new Error("fixture guard configuration failed");
  return { config, secret };
}

function redisResult(result: unknown): Response {
  return new Response(JSON.stringify({ result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("ProofGate durable spend guard", () => {
  it("requires both a durable store and hashed tester access keys", () => {
    expect(spendGuardStatus()).toMatchObject({ configured: false });
    const { config, secret } = configure();
    expect(spendGuardStatus()).toEqual({ readiness: "ready", configured: true, access_required: true });
    expect(authenticateSpendPrincipal(secret, config)).toBe(hashAccessKey(secret));
    expect(authenticateSpendPrincipal(`${secret}-wrong`, config)).toBeNull();
  });

  it("atomically reserves worst-case spend and finalizes a replayable receipt", async () => {
    const { config } = configure();
    const calls: unknown[][] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)) as unknown[]);
      return redisResult(calls.length === 1 ? ["RESERVED"] : ["OK"]);
    }) as unknown as typeof globalThis.fetch;
    const reservation = await reservePaidPreflight({
      config,
      principal: `sha256:${"b".repeat(64)}`,
      requestId: "REQ-1",
      request: { action: "Publish a supported claim.", policy: "Require two miners." },
      maximumPaidCalls: 3,
      maximumPaymentMicros: 50_000,
      now: new Date("2026-09-01T10:20:30.000Z"),
      fetchImpl,
    });
    expect(reservation.status).toBe("reserved");
    expect(calls[0]).toContain(150_000);
    expect(calls[0]).toContain("pg:budget:2026-09-01");

    if (reservation.status !== "reserved") throw new Error("expected reservation");
    await finalizePaidPreflight({
      config,
      reservation,
      response: { schema_version: "proofgate.preflight.v1" } as PreflightResponse,
      fetchImpl,
    });
    expect(calls[1]).toContain("COMPLETE");
    expect(calls[1].join(" ")).not.toContain("token-with-at-least");
  });

  it.each([
    ["CONFLICT", "conflict"],
    ["PENDING", "pending"],
    ["FAILED", "failed"],
    ["BUDGET_EXHAUSTED", "budget_exhausted"],
    ["PRINCIPAL_LIMITED", "principal_limited"],
    ["BUSY", "busy"],
  ] as const)("maps Redis state %s to %s", async (redisState, expected) => {
    const { config } = configure();
    const fetchImpl = vi.fn(async () => redisResult([redisState])) as unknown as typeof globalThis.fetch;
    const result = await reservePaidPreflight({
      config,
      principal: `sha256:${"c".repeat(64)}`,
      requestId: "REQ-state",
      request: { action: "Publish a supported claim.", policy: "Require two miners." },
      maximumPaidCalls: 3,
      maximumPaymentMicros: 50_000,
      fetchImpl,
    });
    expect(result.status).toBe(expected);
  });
});
