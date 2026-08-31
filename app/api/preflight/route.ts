import { NextResponse } from "next/server";
import { z } from "zod";

import { buildPreflight } from "@/lib/proofgate/pipeline";
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

function responseHeaders(rateLimit?: ReturnType<typeof checkRateLimit>) {
  return {
    "Access-Control-Allow-Headers": "Content-Type, X-Request-Id",
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

  const requestId = request.headers.get("x-request-id")?.trim();
  try {
    const signal = AbortSignal.timeout(50_000);
    const result = await buildPreflight({
      ...parsed.data,
      request_id: parsed.data.request_id ?? (requestId || undefined),
    }, { signal });
    console.info("[proofgate:usage]", JSON.stringify({
      schema_version: "proofgate.usage.v1",
      action_id: result.action_id,
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
