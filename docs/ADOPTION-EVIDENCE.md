# ProofGate Track 3 adoption evidence

This ledger is intentionally honest. It records only real external ProofGate
use through Telegraph. Unit tests, health probes, developer retries, demo
rehearsals, direct calls to `/v1/proof`, and synthetic traffic are excluded.

## Current public snapshot

Updated: **2026-09-01**

| Metric | Evidenced total | Notes |
|---|---:|---|
| Consented external testers | 0 | Recruitment has not started |
| External ProofGate integrations | 0 | No downstream agent integration is claimed yet |
| Completed guarded preflights | 0 | Production remains in Safety mode |
| Successful paid Telegraph calls | 0 | No dedicated x402 burner is configured |
| Telegraph-node-attested signals | 0 | No funded production receipt exists yet |
| Settled test USDC cost | $0.00 | No payment is claimed |
| `ALLOW` / `BLOCK` / `ESCALATE` from paid runs | 0 / 0 / 0 | Unfunded fail-closed previews are excluded |

The deployed [health route](https://qarinah-proofpack.vercel.app/health) is the
runtime source of truth. A real paid run is eligible for this ledger only when
the route reports `x402-ready`, the response contains a decoded successful Base
Sepolia settlement, and the exact signal lookup is retained.

## Counting method

- One completed preflight is one unique approved tester principal plus one
  completed `request_id`. Idempotent replays never add another run.
- A successful paid call requires a validated x402 settlement header, exact
  Base Sepolia network, expected payer, bounded amount, and transaction hash.
- An attested signal requires the official Telegraph lookup to bind the exact
  query (including the per-run nonce), Miner, Intent, and result hash.
- Unique users come only from consented tester records or public integrations;
  IP addresses and action hashes are never used to infer identity.
- Aggregate logs omit action text, claims, policy text, access keys, raw Miner
  output, payment headers, and wallet secrets.

## Receipt register

Add a row only after validating and redacting a real run.

| UTC time | Tester/integration evidence | Deployment commit | Decision | Calls | Miner IDs / Intents | Signal lookups | Settlements | Cost | Redacted receipt |
|---|---|---|---|---:|---|---|---|---:|---|
| _No qualifying runs yet_ | | | | | | | | | |

## External feedback register

Permission is required before publishing a tester name, quote, issue, or
integration link.

| Date | Builder or integration | Real pre-action need | Outcome | Permissioned evidence |
|---|---|---|---|---|
| _No entries yet_ | | | | |

## Release evidence required for each demo

Retain the UTC timestamp, production origin, deployment commit, redacted
request, decision, route mode, Miner ID and slug, Intent, rank, response status,
settlement transaction and amount, `signal_hash`, official lookup response,
Qarinah chain head, receipt root, and policy thresholds. The Qarinah root is an
unsigned internal-consistency seal; it is not presented as issuer authentication.

Never inflate usage. The [official Track 3 rules](https://hackathon.telegraphprotocol.com/rules)
make real usage and adoption 45% of judging and disqualify metric gaming.
