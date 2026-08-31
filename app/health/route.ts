import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(
    {
      ok: true,
      service: "qarinah-proofpack",
      version: "0.1.0",
      timestamp: new Date().toISOString()
    },
    {
      headers: {
        "cache-control": "no-store"
      }
    }
  );
}
