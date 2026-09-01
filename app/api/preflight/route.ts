import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { buildPreflight, resolveMaximumPaidCalls } from "@/lib/proofgate/pipeline";
import {
  authenticateSpendPrincipal,
  finalizePaidPreflight,
  readSpendGuardConfig,
  reservePaidPreflight,
  type SpendReservation,
} from "@/lib/proofgate/spend-guard";
import { createTelegraphClient } from "@/lib/proofgate/telegraph";
import type { PreflightRequest } from "@/lib/proofgate/types";
import { checkRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 24 * 1024;
const requestSchema = z.object({
  action: z.string().min(3).max(2_048),
  policy: z.string().min(3).max(4_096),
  claims: z.array(z.string().min(8).max(1_024)).min(1).max(3).optional(),
  request_id: z.string().min(1).max(256).optional(),
}).strict();

function responseHeaders(rateLimit?: ReturnType<typeof checkRateLimit>): Record<string, string> {
  return {
    "Access-Control-Allow-Headers": "Content-Type, X-Request-Id, X-ProofGate-Key",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Cache-Control": "no-store, max-age=0",
    ...(rateLimit ? {
      "RateLimit-Limit": String(rateLimit.limit),
      "RateLimit-Remaining": String(rateLimit.remaining),
      "RateLimit-Reset": String(Math.ceil(rateLimit.resetAt / 1_000)),
    } : {}),
  };
}

function clientKey(request: Request): string {
  const address = request.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim()
    || request.headers.get("cf-connecting-ip")
    || request.headers.get("x-real-ip")
    || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || "anonymous";
  return `preflight:${address}`;
}

function errorResponse(status: number, code: string, message: string, headers = responseHeaders()) {
  return NextResponse.json({ error: { code, message } }, { status, headers });
}

function paidRuntimeConfigured(): boolean {
  try {
    return createTelegraphClient().configured;
  } catch {
    return false;
  }
}

function maximumPaymentMicros(): number {
  const value = process.env.TELEGRAPH_MAX_PAYMENT_USDC_MICROS ?? "50000";
  if (!/^\d+$/.test(value)) throw new TypeError("Invalid Telegraph payment cap.");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100_000) {
    throw new TypeError("Invalid Telegraph payment cap.");
  }
  return parsed;
}

function reservationError(
  reservation: Exclude<SpendReservation, { status: "reserved" | "complete" }>,
  headers: ReturnType<typeof responseHeaders>,
) {
  if (reservation.status === "conflict") {
    return errorResponse(409, "IDEMPOTENCY_CONFLICT", "This request_id was already used for different preflight content.", headers);
  }
  if (reservation.status === "pending") {
    return errorResponse(425, "PREFLIGHT_IN_PROGRESS", "This request_id is already in progress. Retry it shortly.", { ...headers, "Retry-After": "5" });
  }
  if (reservation.status === "budget_exhausted") {
    return errorResponse(429, "DAILY_BUDGET_EXHAUSTED", "The guarded daily testnet budget is exhausted. No payment was attempted.", headers);
  }
  if (reservation.status === "principal_limited") {
    return errorResponse(429, "PRINCIPAL_LIMITED", "This tester has reached the guarded preflight limit. No payment was attempted.", headers);
  }
  if (reservation.status === "busy") {
    return errorResponse(503, "PREFLIGHT_BUSY", "The guarded paid-call concurrency limit is active. Retry shortly.", { ...headers, "Retry-After": "5" });
  }
  return errorResponse(409, "REQUEST_ALREADY_PROCESSED", "This request_id ended without a replayable receipt. Use a new request_id only for an intentional new run.", headers);
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: responseHeaders() });
}

export async function POST(request: Request) {
  const startedAt = Date.now();
  // Protect the server-funded Base Sepolia burner from accidental rapid drain.
  // The deliberately small wallet balance remains the ultimate spend cap.
  const rateLimit = checkRateLimit(clientKey(request), { limit: 5, windowMs: 60_000 });
  const headers = responseHeaders(rateLimit);
  if (!rateLimit.allowed) {
    return errorResponse(429, "RATE_LIMITED", "Too many preflight requests. Retry after the rate-limit window resets.", headers);
  }

  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return errorResponse(415, "UNSUPPORTED_MEDIA_TYPE", "Use application/json for preflight requests.", headers);
  }
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return errorResponse(413, "PAYLOAD_TOO_LARGE", "The preflight request body is too large.", headers);
  }

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return errorResponse(400, "INVALID_BODY", "The preflight request body could not be read.", headers);
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
    return errorResponse(413, "PAYLOAD_TOO_LARGE", "The preflight request body is too large.", headers);
  }

  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    return errorResponse(400, "INVALID_JSON", "The request body is not valid JSON.", headers);
  }
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) {
    return errorResponse(422, "INVALID_REQUEST", parsed.error.issues[0]?.message || "The preflight request is invalid.", headers);
  }

  const headerRequestId = request.headers.get("x-request-id")?.normalize("NFKC").trim();
  const bodyRequestId = parsed.data.request_id?.normalize("NFKC").trim();
  const requestId = bodyRequestId || headerRequestId || undefined;
  if ((parsed.data.request_id !== undefined || headerRequestId !== undefined) && !requestId) {
    return errorResponse(422, "INVALID_REQUEST_ID", "request_id must contain a non-whitespace value.", headers);
  }
  const preflightRequest: PreflightRequest = {
    ...parsed.data,
    ...(requestId ? { request_id: requestId } : {}),
  };
  let guard: ReturnType<typeof readSpendGuardConfig> = null;
  let reservation: Extract<SpendReservation, { status: "reserved" }> | null = null;

  try {
    if (paidRuntimeConfigured()) {
      if (!requestId) {
        return errorResponse(422, "REQUEST_ID_REQUIRED", "A unique request_id is required for guarded paid preflights.", headers);
      }
      guard = readSpendGuardConfig();
      if (!guard) {
        return errorResponse(503, "SPEND_GUARD_NOT_READY", "The x402 payer is locked because its durable spend guard is not ready.", headers);
      }
      const principal = authenticateSpendPrincipal(request.headers.get("x-proofgate-key"), guard);
      if (!principal) {
        return errorResponse(401, "PROOFGATE_ACCESS_REQUIRED", "A valid ProofGate tester access key is required for paid preflights.", {
          ...headers,
          "WWW-Authenticate": "ProofGate-Key",
        });
      }
      const reserved = await reservePaidPreflight({
        config: guard,
        principal,
        requestId,
        request: preflightRequest,
        maximumPaidCalls: resolveMaximumPaidCalls(process.env.PROOFGATE_MAX_CALLS),
        maximumPaymentMicros: maximumPaymentMicros(),
      });
      if (reserved.status === "complete") {
        return NextResponse.json(reserved.response, {
          status: 200,
          headers: { ...headers, "X-ProofGate-Idempotent-Replay": "true" },
        });
      }
      if (reserved.status !== "reserved") return reservationError(reserved, headers);
      reservation = reserved;
    }

    const signal = AbortSignal.timeout(50_000);
    const result = await buildPreflight(preflightRequest, { signal });
    if (guard && reservation) {
      await finalizePaidPreflight({ config: guard, reservation, response: result });
    }
    console.info("[proofgate:usage]", JSON.stringify({
      schema_version: "proofgate.usage.v1",
      usage_id: randomUUID(),
      generated_at: result.generated_at,
      decision: result.decision,
      authorization_issued: result.authorization_issued,
      paid_calls_attempted: result.operational.paid_calls_attempted,
      paid_calls_succeeded: result.operational.paid_calls_succeeded,
      verified_signals: result.aggregate.verified_signals,
      distinct_miners: result.aggregate.distinct_miners,
      supporting_signals: result.aggregate.supporting_signals,
      refuting_signals: result.aggregate.refuting_signals,
      total_cost_usd: result.aggregate.total_cost_usd,
      reason_codes: result.reason_codes,
      latency_ms: Date.now() - startedAt,
      deployment_version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 40) ?? null,
    }));
    return NextResponse.json(result, { status: 200, headers });
  } catch (error) {
    if (guard && reservation) {
      try {
        await finalizePaidPreflight({ config: guard, reservation });
      } catch {
        // The reservation and worst-case budget intentionally expire without
        // refund when settlement state is uncertain.
      }
    }
    console.error("[proofgate:error]", JSON.stringify({
      schema_version: "proofgate.error.v1",
      code: "PREFLIGHT_PIPELINE_ERROR",
      error_name: error instanceof Error ? error.name : "UnknownError",
      latency_ms: Date.now() - startedAt,
      deployment_version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 40) ?? null,
    }));
    return errorResponse(500, "PREFLIGHT_PIPELINE_ERROR", "ProofGate failed safely before emitting an authorization.", headers);
  }
}
