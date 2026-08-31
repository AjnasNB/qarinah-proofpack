import { NextResponse } from "next/server";

import { createTelegraphClient } from "@/lib/proofgate/telegraph";

export const dynamic = "force-dynamic";

function telegraphPayerConfigured(): boolean {
  try {
    return createTelegraphClient().configured;
  } catch {
    return false;
  }
}

export function GET() {
  const payerConfigured = telegraphPayerConfigured();
  return NextResponse.json(
    {
      ok: true,
      service: "proofgate",
      version: "0.1.0",
      surfaces: {
        preflight: {
          path: "/api/preflight",
          payer_configured: payerConfigured,
          runtime_mode: payerConfigured ? "x402-configured" : "escalate-only",
          note: payerConfigured
            ? "Configuration is valid; readiness still requires a successful paid Telegraph preflight."
            : "No valid server-side Telegraph payer is configured.",
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
