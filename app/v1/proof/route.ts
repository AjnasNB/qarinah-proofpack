import { NextResponse } from "next/server";
import { z } from "zod";
import { buildProofPack } from "@/lib/proof/pipeline";
import { checkRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 16 * 1024;
const requestSchema = z.object({
  query: z.string().min(3).max(2_048),
  intent: z.enum(["FACT_CHECK", "RESEARCH_SYNTHESIS"]).optional().default("FACT_CHECK"),
  request_id: z.string().min(1).max(256).optional(),
  as_of: z.iso.datetime().nullable().optional(),
}).strict();

function responseHeaders(rateLimit?: ReturnType<typeof checkRateLimit>) {
  return {
    "Access-Control-Allow-Headers": "Content-Type, X-Request-Id",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store, max-age=0",
    ...(rateLimit ? {
      "RateLimit-Limit": String(rateLimit.limit),
      "RateLimit-Remaining": String(rateLimit.remaining),
      "RateLimit-Reset": String(Math.ceil(rateLimit.resetAt / 1_000)),
    } : {}),
  };
}

function clientKey(request: Request) {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || request.headers.get("x-real-ip")
    || "anonymous";
}

function errorResponse(status: number, code: string, message: string, headers = responseHeaders()) {
  return NextResponse.json({ error: { code, message } }, { status, headers });
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: responseHeaders() });
}

export async function POST(request: Request) {
  const rateLimit = checkRateLimit(clientKey(request), { limit: 12, windowMs: 60_000 });
  const headers = responseHeaders(rateLimit);
  if (!rateLimit.allowed) {
    return errorResponse(429, "RATE_LIMITED", "Too many proof requests. Retry after the rate-limit window resets.", headers);
  }

  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return errorResponse(415, "UNSUPPORTED_MEDIA_TYPE", "Use application/json for proof requests.", headers);
  }
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return errorResponse(413, "PAYLOAD_TOO_LARGE", "The proof request body is too large.", headers);
  }

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return errorResponse(400, "INVALID_BODY", "The request body could not be read.", headers);
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
    return errorResponse(413, "PAYLOAD_TOO_LARGE", "The proof request body is too large.", headers);
  }

  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    return errorResponse(400, "INVALID_JSON", "The request body is not valid JSON.", headers);
  }
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) {
    return errorResponse(422, "INVALID_REQUEST", parsed.error.issues[0]?.message || "The proof request is invalid.", headers);
  }

  const query = parsed.data.query
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (query.length < 3) {
    return errorResponse(422, "INVALID_QUERY", "The normalized query must contain at least three characters.", headers);
  }

  try {
    const signal = AbortSignal.timeout(50_000);
    const pack = await buildProofPack({ ...parsed.data, query }, { signal });
    return NextResponse.json(pack, { status: 200, headers });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The ProofPack pipeline failed safely.";
    return errorResponse(500, "PROOF_PIPELINE_ERROR", message.slice(0, 500), headers);
  }
}
