import { NextResponse } from "next/server";

import { spendGuardStatus } from "@/lib/proofgate/spend-guard";
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
  const guard = spendGuardStatus();
  const paidReady = payerConfigured && guard.configured;
  return NextResponse.json(
    {
      ok: true,
      service: "proofgate",
      version: "0.1.0",
      surfaces: {
        preflight: {
          path: "/api/preflight",
          payer_configured: payerConfigured,
          spend_guard_configured: guard.configured,
          spend_guard_status: guard.readiness,
          access_required: paidReady,
          runtime_mode: paidReady ? "x402-ready" : payerConfigured ? "payer-locked" : "safety-mode",
          note: paidReady
            ? "The guarded payer is configured; readiness still requires a successful paid Telegraph preflight."
            : payerConfigured
              ? "The payer is locked. Durable budget and tester access controls must be valid before any payment is attempted."
              : "Safety mode is active: no valid server-side Telegraph payer is configured, so every action fails closed without payment.",
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
