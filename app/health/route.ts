import { NextResponse } from "next/server";

import { createTelegraphClient } from "@/lib/proofgate/telegraph";

export const dynamic = "force-dynamic";

function telegraphConfigurationReady(): boolean {
  try {
    return createTelegraphClient().configured;
  } catch {
    return false;
  }
}

export function GET() {
  const telegraphConfigured = telegraphConfigurationReady();
  return NextResponse.json(
    {
      ok: true,
      service: "proofgate",
      version: "0.1.0",
      surfaces: {
        preflight: {
          path: "/api/preflight",
          telegraph_configured: telegraphConfigured,
          authorization_mode: telegraphConfigured ? "live-x402" : "escalate-only",
        },
        proofpack: {
          path: "/v1/proof",
          ready: true,
        },
        verifier: {
          path: "/v1/verify",
          ready: true,
        },
      },
      timestamp: new Date().toISOString()
    },
    {
      headers: {
        "cache-control": "no-store"
      }
    }
  );
}
