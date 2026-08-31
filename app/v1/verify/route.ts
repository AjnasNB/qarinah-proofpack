import { NextResponse } from "next/server";
import { verifyProofPack } from "@/lib/proof/verify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 2 * 1024 * 1024;

const headers = {
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "no-store, max-age=0",
};

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers });
}

export async function POST(request: Request) {
  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return NextResponse.json({ error: { code: "UNSUPPORTED_MEDIA_TYPE", message: "Use application/json." } }, { status: 415, headers });
  }
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: { code: "PAYLOAD_TOO_LARGE", message: "The ProofPack is too large to verify here." } }, { status: 413, headers });
  }

  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
    return NextResponse.json({ error: { code: "PAYLOAD_TOO_LARGE", message: "The ProofPack is too large to verify here." } }, { status: 413, headers });
  }
  try {
    const result = verifyProofPack(JSON.parse(raw));
    return NextResponse.json(result, { status: result.valid ? 200 : 422, headers });
  } catch {
    return NextResponse.json({ error: { code: "INVALID_JSON", message: "The request body is not valid JSON." } }, { status: 400, headers });
  }
}
