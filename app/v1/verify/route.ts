import { NextResponse } from "next/server";
import { verifyProofPack } from "@/lib/proof/verify";
import { checkRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const VERIFY_RATE_LIMIT = 30;

class PayloadTooLargeError extends Error {}

function responseHeaders(rateLimit?: ReturnType<typeof checkRateLimit>) {
  return {
    "Access-Control-Allow-Headers": "Content-Type",
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

function clientKey(request: Request): string {
  const address = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || request.headers.get("x-real-ip")
    || "anonymous";
  return `verify:${address}`;
}

function errorResponse(status: number, code: string, message: string, headers = responseHeaders()) {
  return NextResponse.json({ error: { code, message } }, { status, headers });
}

async function readBoundedBody(request: Request): Promise<string> {
  const declaredHeader = request.headers.get("content-length");
  if (declaredHeader !== null) {
    const declaredLength = Number(declaredHeader);
    if (!Number.isSafeInteger(declaredLength) || declaredLength < 0) {
      throw new TypeError("Content-Length must be a non-negative integer.");
    }
    if (declaredLength > MAX_BODY_BYTES) throw new PayloadTooLargeError();
  }

  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new PayloadTooLargeError();
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: responseHeaders() });
}

export async function POST(request: Request) {
  const rateLimit = checkRateLimit(clientKey(request), { limit: VERIFY_RATE_LIMIT, windowMs: 60_000 });
  const headers = responseHeaders(rateLimit);
  if (!rateLimit.allowed) {
    return errorResponse(429, "RATE_LIMITED", "Too many verification requests. Retry after the rate-limit window resets.", headers);
  }

  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return errorResponse(415, "UNSUPPORTED_MEDIA_TYPE", "Use application/json.", headers);
  }

  let raw: string;
  try {
    raw = await readBoundedBody(request);
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      return errorResponse(413, "PAYLOAD_TOO_LARGE", "The ProofPack is too large to verify here.", headers);
    }
    return errorResponse(400, "INVALID_BODY", "The request body could not be read as bounded UTF-8.", headers);
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return errorResponse(400, "INVALID_JSON", "The request body is not valid JSON.", headers);
  }


  try {
    const result = verifyProofPack(value);
    return NextResponse.json(result, { status: result.valid ? 200 : 422, headers });
  } catch {
    return errorResponse(422, "VERIFICATION_FAILED_SAFELY", "The payload exceeded the verifier's bounded contract checks.", headers);
  }
}
