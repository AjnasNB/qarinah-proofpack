# ProofGate Track 3 runbook

ProofGate is the main Telegraph **Track 3: Applications** submission.
Qarinah ProofPack is the supporting **Track 1: Miners** candidate.

> **No proof. No action.**

This document is the operating runbook for registration, funding, live
integration, testing, launch, adoption, and final submission. It describes only
real Telegraph calls. Fixtures are valid in automated tests, but they must never
appear as live demo data, usage, or submission evidence.

## Track decision

| Project surface | Track | Role | Status on 2026-08-31 |
|---|---|---|---|
| ProofGate | Track 3: Applications | Main submission | In development; not yet submitted |
| Qarinah ProofPack | Track 1: Miners | Supporting evidence Miner for `FACT_CHECK` and `RESEARCH_SYNTHESIS` | Public API is live, but the Miner is not yet registered in Telegraph |
| Evaluation WASM | Track 2: Script Authors | Out of scope | No Track 2 submission planned |

ProofGate is the stronger main entry because the official Track 3 criteria
reward real users, actual Telegraph call volume, usefulness, creativity, and
depth of integration. The product is also an application in the precise sense
used by the rules: it consumes live Miner intelligence and governs an agent
action with it.

ProofPack still matters. Once registered, it supplies evidence-rich
`FACT_CHECK` and `RESEARCH_SYNTHESIS` results that ProofGate can consume through
Telegraph. It also proves that the application is built on a real, separately
operated intelligence provider rather than a private internal mock.

Track 3 does not require the application team to own a Miner. It does require
the application to use real Telegraph Miners. Therefore ProofGate remains a
valid Track 3 direction even if ProofPack registration is delayed, provided
ProofGate consumes other active Miners through the live Telegraph Engine.

## Why the idea fits Track 3

The official rules identify autonomous agents, confidence thresholds, routing
behavior, multi-intent intelligence, and signal verification as high-value
areas. ProofGate combines all five in one narrow product:

1. An agent proposes an action.
2. A human-readable policy defines the evidence needed before that action.
3. Telegraph discovers and calls live, ranked Miners.
4. Each returned `signal_hash` is looked up and verified.
5. Qarinah records a hash-linked evidence event chain.
6. Maqam evaluates the compiled policy.
7. ProofGate returns `ALLOW`, `BLOCK`, or `ESCALATE` with a sealed receipt.

This is deeper than displaying a Telegraph response. The network decides which
intelligence provider should answer. ProofGate decides whether the resulting
evidence is sufficient for an autonomous system to act.

The main risk is not product fit. It is operational proof. A Track 3 entry with
no genuine users or only direct calls to the ProofPack URL will not satisfy the
rules. The final demo and adoption evidence must show paid calls made through
the live Telegraph Engine to active Miners.

## Official schedule

IST below means India Standard Time, UTC+05:30.

| Event | Official UTC schedule | IST | Operational interpretation |
|---|---|---|---|
| Track 1 Miners and Track 2 Scripts | **August 31, 2026 at 23:59:59 UTC** | **September 1, 2026 at 05:29:59 IST** | Exact cutoff returned by the official submission deadline API. Register ProofPack immediately. |
| Track 3 Applications | **September 7, 2026 at 23:59:59 UTC** | **September 8, 2026 at 05:29:59 IST** | Exact application cutoff returned by the official submission deadline API. Build and drive real usage as soon as the Track 3 portal opens. |
| Public landing-page close | September 7, 2026 at 23:59 UTC | September 8, 2026 at 05:29 IST | The public countdown rounds to the minute; use the submission deadline API value above for the exact cutoff. |
| Winner selection | September 8 through September 18, 2026 | Date range only | Keep the deployment and evidence accessible during review. |
| Announcement and prizes | September 19 through September 25, 2026 | Date range only | The official rules publish dates but no time of day. |

The official rules also require Miners and Script Authors to remain live
throughout Track 3. If ProofPack is registered, keep its exact registered API
and YAML available through at least September 7 at 23:59:59 UTC.

## Track 3 judging weights

The Track 3 tab on the official rules page assigns 100 points as follows:

| Weight | Criterion | ProofGate evidence to produce |
|---:|---|---|
| 45% | Real Usage and Adoption | Genuine users, actual volume of paid Telegraph calls, retained anonymized usage records, and integrations by other builders |
| 25% | Usefulness, Creativity and Depth of Integration | Pre-action control, multi-Miner evidence, verified signal lookups, deterministic policy checks, and sealed Qarinah receipts |
| 25% | Engagement and Updates on X | Public build and launch updates with working links, honest metrics, and `@Telegraphprotoc` tagged |
| 5% | Technical Execution and Integration Quality | Reliable live endpoint, bounded payments, tests, failure handling, documentation, and reproducible verification |

The application strategy follows those weights. Ship a working integration
early, put it in front of real builders, and document genuine calls. Do not
spend the week polishing a prerecorded demo while adoption remains zero.

The separate Miner Track guardrail says an Intent needs at least three active
Miners and at least 100 real requests from Track 3 applications to qualify for
global cash prizes. As of the catalog snapshot on **2026-08-31**,
`FACT_CHECK` has **2** active Miners and `RESEARCH_SYNTHESIS` has **3**. A live
ProofPack registration could bring `FACT_CHECK` to three, but the 100-request
requirement would still need genuine Track 3 demand. Never generate artificial
traffic to meet it.

## Architecture

```text
Autonomous agent
      |
      | action + natural-language evidence policy + claims
      v
POST /api/preflight
      |
      +--> deterministic Maqam policy compilation
      |
      +--> Telegraph live Miner discovery
      |       GET /api/miners?intent=...&status=active
      |
      +--> real x402-gated Engine calls
      |       POST /engine/v1/ask
      |       POST /engine/v1/ask/{minerId}
      |
      +--> signal verification
      |       GET /engine/v1/signal/{signal_hash}
      |
      +--> normalized claims, confidence, conflicts, and source Miner identity
      |
      +--> Qarinah hash-linked preflight chain
      |
      +--> Maqam policy evaluation
      v
ALLOW | BLOCK | ESCALATE
      |
      v
SHA-256 receipt + Telegraph signal hashes + policy results
```

The application uses the public Telegraph node origin:

```text
https://devnode.telegraphprotocol.com
```

The current implementation supports both route modes:

- `AUTO` uses `POST /engine/v1/ask` so Telegraph classifies the query and
  selects a ranked Miner.
- `DIRECT` uses a Miner ID and endpoint discovered from the live catalog. It
  never uses a hardcoded fake Miner.

Distinct Miner counts are based on returned Miner IDs, not on the number of
HTTP calls. Two calls to one Miner are one independent Miner for policy
purposes.

## Truthful decision semantics

`ALLOW`, `BLOCK`, and `ESCALATE` are authorization states, not decorative
labels.

### ALLOW

ProofGate returns `ALLOW` only when every compiled policy rule passes using
successfully returned and verified Telegraph signals. The response sets:

```json
{
  "decision": "ALLOW",
  "authorization_issued": true
}
```

The minimum rules can include distinct Miner count, verified signal count,
supporting signal count, mapped provider confidence, all-claims coverage, and maximum
conflict score. Unsupported natural-language policy clauses cannot silently
pass. They force escalation.

### BLOCK

ProofGate returns `BLOCK` only for affirmative evidence-based denial, such as:

- a required claim is credibly refuted and the compiled policy enables
  `block_on_credible_refutation`; or
- material conflict is present and the policy enables
  `block_on_any_conflict`.

`BLOCK` never means that the network timed out or the wallet was empty. Those
are operational uncertainty and must be distinguishable from evidence that an
action violates policy.

### ESCALATE

ProofGate returns `ESCALATE` and `authorization_issued: false` whenever it
cannot justify either an allow or an evidence-based block. Examples include:

- the Telegraph payer is not configured;
- no suitable active Miner is discovered;
- an x402 payment or request fails;
- a returned result has no valid `signal_hash`;
- signal lookup cannot verify the call;
- too few distinct Miners or verified signals respond;
- too few distinct aligned Miners expose catalog-mapped confidence, or their
  mapped-confidence mean is below the policy threshold;
- evidence is insufficient, uncertain, or conflicts beyond the threshold;
- the policy contains unsupported clauses; or
- the preflight deadline expires.

Operational failure is fail-closed. ProofGate does not replace it with a
fixture, cached sample, optimistic default, or synthetic confidence score.

## Confidence and evidence rules

ProofGate must not treat an LLM-authored number as ground truth.

- A signal confidence value is accepted only when the live Miner catalog
  declares a `confidence_field` and the real result contains a valid bounded
  value at that field.
- Missing confidence remains `null`. It is never replaced with a guessed
  `0.5`, `0.9`, or other plausible-looking value.
- Aggregate confidence is the explicitly labeled mean of usable,
  catalog-mapped provider confidence values from distinct Miners aligned with
  the dominant stance. Uncertain and opposing signals cannot raise the score.
  A separate coverage rule requires enough distinct aligned Miners to supply
  such values before the threshold can pass.
- Claim stance comes from declared label semantics and actual returned fields.
- A Miner result without enough machine-readable semantics remains uncertain.
- Proposed claims are serialized inside an explicit untrusted JSON data
  boundary before they reach a Miner. Cross-Miner agreement still is not
  prompt-injection immunity, so free-form refusals or narrative text cannot be
  promoted into directional verdicts.
- Conflicts are derived from supporting and refuting signals.
- A result counts as verified only after its `signal_hash` succeeds through
  the live signal lookup.
- Every public demo displays the actual live outcome, including `ESCALATE`.

The ProofPack Miner has its own calculated evidence confidence and abstention
policy. ProofGate does not overwrite that contract. It treats ProofPack as one
Telegraph signal and applies the action policy across all qualifying signals.

## Real Telegraph and x402 contract

### Discovery

Discovery is public and does not require payment:

```http
GET https://devnode.telegraphprotocol.com/api/miners?intent=FACT_CHECK&status=active&limit=100
GET https://devnode.telegraphprotocol.com/api/miners?intent=RESEARCH_SYNTHESIS&status=active&limit=100
GET https://devnode.telegraphprotocol.com/engine/v1/intents
```

The live catalog is authoritative for Miner IDs, activation state, endpoints,
schemas, signal mappings, supported intents, ranks, and prices. Examples in
documentation are not a stable routing registry.

### Auto-routed ask

```http
POST https://devnode.telegraphprotocol.com/engine/v1/ask
Content-Type: application/json

{
  "query": "Is the claim supported by current evidence?",
  "context": {
    "claim": "..."
  }
}
```

The Engine classifies the query, selects ranked Miners, tries its primary and
fallback route, and returns the result with Miner, intent, cost, duration, and
signal metadata.

### Direct ask

```http
POST https://devnode.telegraphprotocol.com/engine/v1/ask/{minerId}
Content-Type: application/json

{
  "method": "POST",
  "endpoint": "/the-live-catalog-endpoint",
  "payload": {
    "query": "Is the claim supported by current evidence?"
  }
}
```

The `{minerId}`, method, endpoint, and parameter names must come from live
discovery. Direct asks skip the router, so ProofGate records `route_mode` to
make that distinction visible.

### Payment handshake

The official x402 v2 flow is:

1. Send the exact request without a payment proof.
2. Receive HTTP `402` and decode the `PAYMENT-REQUIRED` challenge header.
3. Let the official x402 client sign the accepted payment option.
4. Retry the same request with `PAYMENT-SIGNATURE`.
5. On success, retain the `PAYMENT-RESPONSE` settlement header and returned
   `signal_hash`.

The application uses `@x402/core`, `@x402/evm`, and `@x402/fetch`. It does not
construct payment signatures manually. The challenge is authoritative for the
network, asset, amount, and receiving address. Never hardcode `payTo`.

Current official Base Sepolia details are:

| Field | Value |
|---|---|
| CAIP-2 network | `eip155:84532` |
| Chain | Base Sepolia |
| USDC contract | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| USDC decimals | 6 |
| Example floor | `10000` micro-USDC, equal to $0.01 |

Prices are dynamic. ProofGate enforces a server-side maximum payment selector,
but the received challenge remains the source of truth for the actual call.
Failed calls are not supposed to settle, according to the official x402 guide.
The application still records failures and never retries without its bounded
call policy.

### Signal verification

Every successful paid call should include a `signal_hash`:

```http
GET https://devnode.telegraphprotocol.com/engine/v1/signal/{signal_hash}
```

ProofGate keeps the returned signal, result, and commitment metadata needed to
check the hash. If the lookup fails or does not establish the expected signal,
the signal is not counted as verified.

## Receipt contract

The response schema is `proofgate.preflight.v1`. Its public fields include:

- `action_id` and `generated_at`;
- `decision` and `authorization_issued`;
- the proposed `action`;
- compiled Maqam policy, recognized constraints, unsupported clauses, and
  `policy_hash`;
- per-claim verdict, confidence, signal counts, and signal hashes;
- aggregate confidence, support, refutation, uncertainty, distinct Miner
  count, verified signal count, conflict score, and total paid cost;
- each policy rule with `passed`, `actual`, and `required`;
- human-readable `reason` plus machine-readable `reason_codes`;
- operational state and paid call attempt and success counts;
- Qarinah events, event count, and `head_hash`; and
- the sealed `proofgate.receipt.v1` receipt.

Each `signals[]` entry records:

- `receipt_id` and `route_mode`;
- requested and returned Intent;
- Miner ID, slug, name, and rank at request time;
- endpoint, timestamp, cost, and result hash;
- Telegraph `signal_hash` and `signal_verified`;
- verification algorithm, commitment, and check time;
- SHA-256 digest of the `PAYMENT-RESPONSE`, never the runtime private key;
- declared confidence, label, and reason field mappings;
- extracted confidence, label, reason, stance, and claim assessments; and
- live warnings returned by Telegraph.

The final receipt records:

```json
{
  "schema_version": "proofgate.receipt.v1",
  "algorithm": "SHA-256",
  "canonicalization": "proofgate.canonical-json.v1",
  "scope": "preflight-without-receipt",
  "root_hash": "sha256:...",
  "qarinah_head_hash": "sha256:...",
  "telegraph_signal_hashes": ["0x..."]
}
```

The root hash proves internal consistency of the returned preflight payload.
It does not by itself prove that every source statement is true. Telegraph
signal verification, trusted network records, and source provenance provide
the external anchors.

## Wallet and funding plan

Use separate wallets for separate risks.

| Purpose | Wallet requirement | Funding | Secret handling |
|---|---|---|---|
| Hackathon participant registration | Base wallet field is optional in the official form | None required for registration | Do not invent or submit an address if the participant chooses not to provide one |
| ProofPack Miner registration | Base-compatible registering wallet plus a fee address | Small amount of Base Sepolia ETH for gas; no bond, stake, or protocol registration fee | User connects and confirms the on-chain transaction in the official registration interface |
| ProofGate runtime payer | Dedicated server-side EVM burner wallet | Small, capped Base Sepolia USDC test budget | Store only as a deployment secret named `TELEGRAPH_EVM_PRIVATE_KEY` |
| ProofGate end user | No wallet in the current server-paid design | None | The server handles x402; a future bring-your-own-payment mode is out of scope |

The Miner owner wallet and runtime payer should not be the same key. The owner
wallet controls registration identity. The runtime wallet is exposed to normal
application operational risk and should hold only the minimum testnet budget.

The official x402 guide lists a USDC balance as the runtime prerequisite. The
facilitator handles settlement after the signed authorization. Follow the live
challenge instead of sending USDC manually to a copied address.

Do not commit, print, log, paste into client-side code, or expose either private
key. Never name a browser variable `NEXT_PUBLIC_TELEGRAPH_EVM_PRIVATE_KEY`.
Obtain testnet funds only from official or team-confirmed sources. Ask in the
mandatory Hackathon Discord if the current faucet or funding path is unclear.

The rules say prizes are paid in USD after final results, but they do not
publish a prize payout wallet flow. Do not assume that the optional participant
wallet field is the final payout method. Follow official Discord instructions.

## Environment variables

Set secrets in `.env.local` for local work and in the deployment provider's
encrypted environment settings for production. Never commit a populated file.

| Variable | Required | Purpose |
|---|---|---|
| `TELEGRAPH_EVM_PRIVATE_KEY` | Required for real Track 3 preflights | Server-only Base Sepolia burner key used by the x402 client |
| `TELEGRAPH_NODE_URL` | Optional | Telegraph node origin; defaults to `https://devnode.telegraphprotocol.com` |
| `TELEGRAPH_MAX_PAYMENT_USDC_MICROS` | Optional | Maximum accepted payment per call in 6-decimal USDC units; current default is `50000` and values above `100000` are rejected as likely misconfiguration |
| `PROOFGATE_MAX_CALLS` | Optional | Hard cap of 1 through 3 paid Telegraph calls per preflight |
| `PROOFPACK_PUBLIC_URL` | Required for release rendering | Canonical public HTTPS origin used by ProofPack metadata and Miner YAML rendering |
| `BRAVE_SEARCH_API_KEY` | Optional | Higher-recall ProofPack search provider |
| `TAVILY_API_KEY` | Optional | Alternate higher-recall ProofPack search provider |
| `OPENAI_API_KEY` | Optional | Bounded ProofPack synthesis provider; not a source of ProofGate authorization |
| `OPENAI_MODEL` | Required only with `OPENAI_API_KEY` | Explicit synthesis model |
| `COCKROACH_BROWSER_ENDPOINT` | Optional | Separate Cockroach Browser sidecar origin |
| `COCKROACH_BROWSER_TOKEN` | Required only with the browser endpoint | Server-only bearer token for the sidecar |

Recommended production limits for the first public release:

```dotenv
TELEGRAPH_NODE_URL=https://devnode.telegraphprotocol.com
TELEGRAPH_MAX_PAYMENT_USDC_MICROS=50000
PROOFGATE_MAX_CALLS=2
PROOFPACK_PUBLIC_URL=https://qarinah-proofpack.vercel.app
```

The private key is intentionally absent from that example.

## Registration checklist

### 1. Register the participant

1. Open [hackathon.telegraphprotocol.com](https://hackathon.telegraphprotocol.com/).
2. Select **Register Now**.
3. Verify the participant email with the one-time code.
4. Complete the official project form. The current form requires the
   participant name, Discord handle, and project name. It labels the Base wallet
   and X handle as optional.
5. Use `ProofGate` as the project name and describe it as a pre-action trust
   firewall powered by real Telegraph Miner signals.
6. Save the confirmation email or screenshot privately as registration proof.

Participant registration and final project submission are different steps.
The optional wallet field does not waive later wallet requirements for a Miner
registration.

### 2. Join the mandatory community channels

1. Join the [official Hackathon Discord](https://discord.gg/telegraphprotocol).
2. Read the hackathon announcement and Track 3 channels.
3. Confirm any cutoff that the public rules describe only by date.
4. Follow [@Telegraphprotoc on X](https://x.com/Telegraphprotoc).
5. Publish only genuine progress and launch updates. Tag `@Telegraphprotoc` in
   every post intended for judging.

The registration form currently labels X as optional, but the rules assign 25%
of Track 3 judging to X engagement and require public, properly tagged updates
used for judging. Treat X as operationally required for a competitive entry.

### 3. Register ProofPack as a Miner

This step is time-sensitive because Track 1 ends August 31.

1. Run the complete repository gate and official-source YAML validation.
2. Confirm the deployed ProofPack endpoint and health route are responding.
3. Open [integrate.telegraphprotocol.com](https://integrate.telegraphprotocol.com/).
4. Sign in, connect the owner wallet on Base Sepolia, and choose **Connect API**.
5. Import the rendered `telegraph/miner.rendered.yaml`, not the tokenized
   template.
6. Run the official schema and endpoint sandbox until every required test
   passes.
7. Pin the validated bytes to IPFS and compare the displayed hash with the
   local SHA-256.
8. Submit the `registerMiner` transaction and confirm it in the wallet.
9. Save the transaction hash, BaseScan URL, YAML CID and URL, YAML hash, fee
   address, registration ID, and activation time.
10. Poll `GET /api/miners/{registrationId}` until `activation_status` is
    `active`. A terminal `rejected` status must be corrected with the official
    update flow.
11. Confirm the Miner appears in the live catalog with intended YAML ID
    `717190`, slug `qarinah-proofpack`, and both exact Intent strings.
12. Send real Telegraph-routed calls and keep the service live through Track 3.

Miner registration needs a small amount of Base Sepolia ETH for gas. The
official registration guide says there is no bond, stake, or registration fee.
The intended YAML ID is not the same thing as the on-chain sequential
`registrationId` returned by the transaction.

Registering a Miner through the developer console automatically enters it into
the Miner Track. It does not submit ProofGate to Track 3.

### 4. Submit ProofGate to Track 3

The official [submission portal](https://submissions.telegraphprotocol.com/)
currently shows **Track 3: Coming Soon** and disables the Track 3 tab. This is
the current portal state on 2026-08-31, not a completed submission.

Until the tab opens:

1. Keep the live app, repository, runbook, receipt examples, and usage evidence
   ready.
2. Watch Discord and the portal for the Track 3 form and required fields.
3. Do not submit ProofGate under Track 1 or Track 2 as a workaround.
4. When Track 3 opens, submit the public repository, production URL, concise
   product description, architecture, real-use evidence, and X update links.
5. Reopen the submitted entry and verify every link and displayed field before
   September 7 at 23:59:59 UTC.

## Local verification checklist

### Static and automated gate

```powershell
npm ci
npm run check
```

Require lint, type checking, unit tests, and the production build to pass.

### Fail-closed check without a payment key

1. Start the app without `TELEGRAPH_EVM_PRIVATE_KEY`.
2. Call `GET /health` and require:
   `telegraph_configured: false` and `authorization_mode: "escalate-only"`.
3. Send a valid `POST /api/preflight` request.
4. Require HTTP 200 with `decision: "ESCALATE"`,
   `authorization_issued: false`, zero successful paid calls, and a sealed
   receipt.
5. Confirm there are no fixture signals and no fabricated confidence.

An unconfigured development environment returning a safe receipt is expected,
not a failed demo.

### Live discovery check

```powershell
$miners = Invoke-RestMethod 'https://devnode.telegraphprotocol.com/api/miners?status=active&limit=1000'
$intents = Invoke-RestMethod 'https://devnode.telegraphprotocol.com/engine/v1/intents'
```

Require at least one suitable active Miner before running a paid preflight.
Record the live counts with a UTC timestamp. Never copy the 2026-08-31 snapshot
forward as if it were current.

### Funded local x402 check

1. Put a dedicated, minimally funded key in `.env.local`.
2. Set `PROOFGATE_MAX_CALLS=2` and a conservative payment cap.
3. Restart the server so secrets are loaded.
4. Send one preflight through the local application.
5. Require at least one real paid call to succeed.
6. Require every counted signal to include a valid `signal_hash` and
   `signal_verified: true`.
7. Look up each hash independently at
   `GET /engine/v1/signal/{signal_hash}`.
8. Compare returned Miner IDs with the live catalog.
9. Confirm the aggregate distinct Miner count does not double-count one Miner.
10. Confirm the receipt root changes if any covered field is modified.
11. Confirm the private key and raw payment authorization never appear in logs,
    JSON, HTML, or browser network responses.

### Negative-path checks

Test all of these before production:

- invalid JSON and unsupported content type;
- oversized request body;
- unknown policy clause;
- no suitable active Miner;
- HTTP 402 that cannot be paid within the configured cap;
- Engine timeout and upstream 5xx;
- missing or malformed `signal_hash`;
- failed signal lookup;
- only one distinct Miner when two are required;
- conflicting live results;
- low or missing confidence;
- repeated requests beyond the rate limit; and
- a tampered receipt.

Every operational negative path must withhold authorization. None may fall
back to a sample answer.

## Production verification checklist

1. Deploy the exact tested commit to the canonical public origin.
2. Configure server-only secrets in the hosting dashboard.
3. Redeploy after adding or rotating a secret.
4. Confirm `GET https://qarinah-proofpack.vercel.app/health` reports
   `live-x402` for ProofGate and ready state for ProofPack and the verifier.
5. Run a real preflight from an external client, not only from the hosting
   provider's internal network.
6. Verify every returned Telegraph signal by hash.
7. Confirm `Cache-Control: no-store` on preflight responses.
8. Confirm rate-limit headers and bounded paid call count.
9. Confirm mobile and desktop users can read the decision, rules, signals, and
   receipt without opening developer tools.
10. Confirm `/proofpack`, `/verify`, `/v1/proof`, and `/v1/verify` remain
    operational.
11. Re-run `npm run check` against the release commit.
12. Save a UTC-dated evidence bundle containing request, response, signal
    lookups, app commit, deployment URL, and redacted payment settlement proof.

Do not publish raw private keys, signed payment payloads, personal email,
participant OTPs, access tokens, or unredacted wallet operational data.

## Three live demonstrations

These are demo scripts, not prerecorded outputs. The presenter runs each case
live and shows whatever the real network returns. The expected branch is a
policy hypothesis, not a hardcoded result.

Use a policy within the supported deterministic grammar, for example:

```text
Only allow when at least two distinct miners, at least two verified signals,
mapped provider confidence at least 70%, all claims supported, and no material conflicts.
Block on credible refutation. Escalate to a human reviewer.
```

### Demo 1: supported claim, candidate for ALLOW

Proposed action: publish a factual timeline statement.

Claim: `The James Webb Space Telescope launched in 2021.`

Show live discovery, paid signal hashes, Miner identities, verification state,
policy checks, and the sealed receipt. If the available live signals do not
satisfy every threshold, accept `ESCALATE` and explain which rule withheld
authorization.

### Demo 2: refuted claim, candidate for BLOCK

Proposed action: publish a factual timeline statement.

Claim: `The James Webb Space Telescope launched in 2020.`

Show the real refuting signals and the compiled
`block_on_credible_refutation` rule. If the network cannot provide enough
verified refutation, the correct outcome is `ESCALATE`, not a staged `BLOCK`.

### Demo 3: sparse or current claim, candidate for ESCALATE

Proposed action: authorize a public launch announcement.

Claim: `Company X has officially confirmed Product Y will launch this month.`

Use the exact claim supplied at demo time. Show missing support, uncertainty,
conflict, or insufficient independent Miner coverage. This is the product's
money shot only if the refusal is produced by the real live pipeline.

For every demo retain:

- UTC request time and public app URL;
- request and response JSON;
- Miner IDs, Intents, route modes, and ranks;
- Telegraph `signal_hash` values and lookup responses;
- paid cost and duration;
- Qarinah chain head and receipt root;
- policy rule results; and
- the release commit SHA.

Never publish a stored result as a fresh live call. If a live dependency fails,
show the truthful `ESCALATE` receipt and rerun only after the cause is fixed.

## Real adoption plan

Because 45% of Track 3 scoring is real usage and adoption, distribution is part
of the build.

### Launch target

- Recruit 10 to 20 genuine builders, agent developers, researchers, or
  operators who have an actual pre-action verification need.
- Ask at least 5 users to run their own claims and policies, not prompts written
  by the project team.
- Publish the API contract and one small integration snippet so another agent
  can call `/api/preflight` without using the web interface.
- Invite one other Track 3 builder to place ProofGate immediately before a real
  non-destructive workflow, such as publishing a draft, sending an internal
  alert, or creating a review ticket.
- Collect permissioned short feedback, issue links, or pull requests as
  adoption evidence.

### Metrics to retain

- genuine unique users using a privacy-preserving anonymous identifier;
- completed preflights;
- actual Telegraph paid call attempts and successes;
- verified signals and distinct Miner IDs used;
- ALLOW, BLOCK, and ESCALATE counts;
- average latency and cost;
- repeat users and external integrations; and
- failure reasons and fixes.

Metrics must come from application events tied to real user requests. Exclude
unit tests, health probes, internal retries, developer smoke tests, and demo
rehearsals from adoption totals. Document the counting method in the final
submission.

The MVP emits one privacy-safe `proofgate.usage.v1` structured server log for
each completed preflight. It keeps only the opaque action ID, decision, call and
Miner counts, stance counts, total cost, reason codes, latency, and deployment
version. It does not log actions, policies, claims, IP addresses, raw Miner
outputs, payment headers, receipt IDs derived from signal hashes, or wallet
material. Platform retention is finite, so export dated logs and pair them with
the corresponding public receipts before submission.

### Public update sequence

1. Build update: problem, architecture, repository, and honest current status.
2. Live integration update: first verified Telegraph signal hash and what was
   learned.
3. Product update: first external user and a redacted real receipt.
4. Reliability update: a real failure that produced `ESCALATE` and the fix.
5. Launch update: production link, repository, demo, genuine totals, and call
   for users.
6. Final update: deadline-safe submission link and final honest metrics.

Tag `@Telegraphprotoc` on every post used for judging. Do not buy engagement,
loop self-requests, coordinate synthetic traffic, or ask users to produce empty
calls only to inflate totals. The rules explicitly disqualify metric gaming.

## Current readiness snapshot

This section must be updated before final submission.

| Item | Current state on 2026-08-31 | Exit condition |
|---|---|---|
| Standalone public repository | Live at `AjnasNB/qarinah-proofpack` | Keep public and clean |
| ProofPack production API | Live at `https://qarinah-proofpack.vercel.app` | Reconfirm after ProofGate deployment |
| ProofGate application | In development | Deploy tested Track 3 UI and `/api/preflight` |
| Telegraph live x402 configuration | Not yet proven in production | Add funded burner secret and retain a verified paid receipt |
| ProofPack Miner registration | Not registered | Complete official sandbox, on-chain registration, and activation |
| Participant registration | Not evidenced in this repository | Complete the official email-verified form |
| Required Discord membership | Not evidenced in this repository | Join and monitor official Hackathon Discord |
| X update campaign | Not evidenced in this repository | Publish genuine tagged updates |
| Track 3 submission | Portal currently says Coming Soon | Submit when enabled and verify before deadline |
| Live Miner counts | `FACT_CHECK`: 2; `RESEARCH_SYNTHESIS`: 3 | Refresh from catalog before every release claim |

Do not change `Not registered`, `Not evidenced`, or `Coming Soon` to a success
claim until the corresponding external action has actually completed.

## Submission positioning

### Name

**ProofGate by Qarinah**

### Tagline

**No proof. No action.**

### Short description

ProofGate is a pre-action trust firewall for autonomous agents. It turns a
proposed action and a plain-English evidence policy into real Telegraph Miner
requests, verifies the returned signal hashes, records a Qarinah provenance
chain, applies Maqam policy rules, and returns an auditable `ALLOW`, `BLOCK`, or
`ESCALATE` receipt. It never invents confidence and never authorizes an action
when evidence or infrastructure is insufficient.

### Open-source provenance

The application repository is
[Qarinah ProofPack](https://github.com/AjnasNB/qarinah-proofpack). It is a new,
isolated public project and does not modify the upstream repositories.

It is built openly on four public foundations:

- [Qarinah](https://github.com/AjnasNB/qarinah) for hash-linked evidence events
  and provenance;
- [Cockroach Crawler](https://github.com/AjnasNB/cockroach-crawler) for live web
  evidence acquisition;
- [Cockroach Browser](https://github.com/AjnasNB/cockroach-browser) for governed
  browser-assisted acquisition when needed; and
- [Maqam](https://github.com/AjnasNB/maqam) for policy boundaries, thresholds,
  and abstention.

The public repositories should be linked in the submission and README so
judges can inspect the lineage instead of taking the architecture claim on
trust.

## Official sources

- [Telegraph Hackathon landing page](https://hackathon.telegraphprotocol.com/)
- [Official rules and judging criteria](https://hackathon.telegraphprotocol.com/rules)
- [Official supported intents](https://hackathon.telegraphprotocol.com/supported-intents)
- [Developer integration console](https://integrate.telegraphprotocol.com/)
- [Hackathon submission portal](https://submissions.telegraphprotocol.com/)
- [Official submission deadline API](https://submissions.telegraphprotocol.com/api/api/deadlines)
- [Official Hackathon Discord](https://discord.gg/telegraphprotocol)
- [Telegraph X account](https://x.com/Telegraphprotoc)
- [Engine inference guide](https://github.com/telegraphprotocol/telegraph-docs/blob/main/using/engine-ask.md)
- [x402 inference and signal verification guide](https://github.com/telegraphprotocol/telegraph-docs/blob/main/using/x402-inference.md)
- [Miner registration guide](https://github.com/telegraphprotocol/telegraph-docs/blob/main/miners/miner-registration.md)
- [YAML Miner Standard](https://github.com/telegraphprotocol/telegraph-docs/blob/main/miners/yaml-config.md)
- [Telegraph Engine OpenAPI specification](https://github.com/telegraphprotocol/telegraph-api-docs/blob/main/openapi/engine.yaml)
- [Live Miner catalog](https://devnode.telegraphprotocol.com/api/miners)
- [Live Intent registry](https://devnode.telegraphprotocol.com/engine/v1/intents)

Operational values such as Miner IDs, prices, payment recipients, activation
state, and Intent coverage can change. Use the live catalog, live Intent
registry, received x402 challenge, signed-in consoles, and official Discord as
the source of truth at execution time.
