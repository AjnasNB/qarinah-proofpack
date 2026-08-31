# Telegraph submission runbook

Qarinah ProofPack is a Telegraph Miner for `FACT_CHECK` and
`RESEARCH_SYNTHESIS`. It turns a claim or research question into a sealed,
machine-readable evidence contract: verdict, calculated confidence, coverage,
freshness, contradictions, source and evidence hashes, a Qarinah event-chain
head, and a Maqam abstention decision.

This is the registration and submission source of truth for the project. It
contains no wallet key, API key, access token, or hosted secret.

The offline verifier establishes internal consistency only. It does not
authenticate a self-contained pack, because an untrusted party can recompute
its hashes. For cross-system integrity, compare `verification.manifest_hash`
with the trusted Telegraph signal or on-chain commitment captured for that
request. Neither check certifies source truthfulness.

## Submission identity

| Field | Value |
|---|---|
| Name | Qarinah ProofPack |
| Tagline | Evidence-backed intelligence for autonomous agents |
| Telegraph kind | `miner` |
| Telegraph ID | `717190` |
| Slug | `qarinah-proofpack` |
| Endpoint | `POST /v1/proof` |
| Authentication | None |
| Primary intent | `FACT_CHECK` |
| Secondary intent | `RESEARCH_SYNTHESIS` |
| Floor price | `0.01` USDC |
| Repository | <https://github.com/AjnasNB/qarinah-proofpack> |

ID `717190` and slug `qarinah-proofpack` were checked against all 128 entries
returned by Telegraph's live Miner catalog at `2026-08-31T10:53:22Z`; neither
was present. The registration validator repeats that check at release time, so
this snapshot is evidence of selection rather than an assumption that the ID
can never be claimed later.

The same live check reported `FACT_CHECK` as canonical with two active Miners
and `RESEARCH_SYNTHESIS` as canonical with three active Miners. Activating this
Miner would bring `FACT_CHECK` to the hackathon's three-Miner eligibility
threshold. To qualify that Intent for global cash prizes, the separate
eligibility guardrail of 100 real Track-3 requests must still be met. This is
not a Track 3 application-entry requirement. Never manufacture traffic: the
rules prohibit metric inflation.

## Deadline interpretation

The official submission deadline API publishes these exact cutoffs:

- Track 1 Miners and Track 2 Scripts close **August 31, 2026 at 23:59:59 UTC**
  (**September 1 at 05:29:59 IST**).
- Track 3 Applications close **September 7, 2026 at 23:59:59 UTC**
  (**September 8 at 05:29:59 IST**).

Telegraph requires Miners to remain live throughout Track 3. Therefore the safe
execution rule is: register and reach `active` before the Track 1 cutoff, then
keep the exact registered YAML and API operational through the Track 3 cutoff.
Confirm announcements in the required Hackathon Discord before each cutoff.

## Release gate

Do not upload or register the tokenized template. The committed
`telegraph/miner.yaml` deliberately contains exactly one
`${PROOFPACK_PUBLIC_URL}` token. The validator accepts only a deployed public
HTTPS origin and creates the registration-ready file.

From the repository root in PowerShell, after production is deployed at the
canonical origin:

```powershell
$env:PROOFPACK_PUBLIC_URL = "https://qarinah-proofpack.vercel.app"
npm run check
node scripts/validate-telegraph.mjs --out telegraph/miner.rendered.yaml --official-source
```

If the hosting provider assigns a different canonical production origin, set
`PROOFPACK_PUBLIC_URL` to that exact origin. The validator rejects HTTP,
localhost, private IPs, reserved example domains, credentials, paths, queries,
fragments, and unresolved tokens.

The release gate must print all of the following:

1. local contract validation passed;
2. both intents are present in Telegraph's live canonical set;
3. ID `717190` and slug `qarinah-proofpack` are unused, or already belong to
   this exact Miner after registration;
4. current official Telegraph YAML docs and reference-source checks passed;
5. the rendered YAML path;
6. both the SHA-256 content hash and `0x`-prefixed `bytes32` value.

`--official-source` reads Telegraph's current public YAML Standard, annotated
reference YAML, and docs commit SHA. The developer console's complete schema and
endpoint sandbox is authenticated and remains a required interactive release
step below. The script intentionally does not accept a console session, wallet
credential, or API key.

For a no-network structural check during development:

```powershell
$env:PROOFPACK_PUBLIC_URL = "https://qarinah-proofpack.vercel.app"
node scripts/validate-telegraph.mjs --offline
npx vitest run test/telegraph-config.test.ts
```

Do not use `--offline` for the registration build. Do not edit
`telegraph/miner.rendered.yaml` after hashing it. Any byte change, including a
trailing newline change, creates a different on-chain commitment.

## Exact registration sequence

1. **Deploy and probe production.** Confirm `GET /health` returns success and
   send at least one real `POST /v1/proof` request to the same HTTPS origin that
   will appear in the YAML. Confirm the response includes `verdict`,
   `confidence`, `reason`, `verification.manifest_hash`, and
   `verification.event_chain_head`.
2. **Freeze the release.** Run `npm run check`, then the release-gate command
   above. Save its SHA-256 and `bytes32` output with the release evidence.
3. **Open the official registration interface.** Go to
   <https://integrate.telegraphprotocol.com>, sign in, connect the registering
   wallet on Base Sepolia, select **Connect API**, then **Import & Upload**.
4. **Import the rendered file.** Paste or upload
   `telegraph/miner.rendered.yaml`, not `telegraph/miner.yaml`. Choose the
   no-API-key path. Run validation and require every endpoint sandbox result to
   pass. Resolve every error before continuing; read warnings rather than
   dismissing them.
5. **Pin the exact validated bytes.** Let the interface upload the YAML to
   IPFS. Confirm the shown YAML hash equals the validator's `bytes32` output.
   Save the IPFS URL and content identifier.
6. **Register on-chain.** Use fee address controlled by the project, floor
   price `0.01` USDC, and exactly these case-sensitive intents:
   `FACT_CHECK`, `RESEARCH_SYNTHESIS`. Submit the `registerMiner` transaction
   from the connected wallet. There is no API secret in this transaction.
7. **Capture immutable evidence.** Save the BaseScan transaction URL,
   transaction hash, registration ID, YAML URL, YAML SHA-256, fee address, and
   activation timestamp. Do not record the wallet's private key or seed phrase.
8. **Wait for activation, not an epoch.** Nodes process the registration event
   and normally activate it within about a minute. Query the exact registration
   ID until `activation_status` is `active`:

   ```powershell
   $registrationId = Read-Host "Decimal registrationId emitted by MinerRegistered"
   Invoke-RestMethod "https://devnode.telegraphprotocol.com/api/miners/$registrationId"
   ```

   Copy the decimal ID from the transaction receipt into the prompt. If status
   is `rejected`, use the returned `rejection_reason`, correct the YAML,
   revalidate, repin, and use the interface's update flow. Never wait on a
   terminal rejection.
9. **Confirm discovery.** Read the live catalog and verify ID `717190`, slug,
   endpoint, schemas, signal mapping, price, and both intents match the rendered
   YAML:

   ```powershell
   $miners = Invoke-RestMethod "https://devnode.telegraphprotocol.com/api/miners?limit=1000"
   $miners | Where-Object { [string]$_.id -eq "717190" }
   ```

10. **Serve real Telegraph requests.** Exercise a true claim, a false claim,
    and a conflicting/current claim through Telegraph, not only against the
    upstream API. Preserve the routed result and signal hash. Track-3
    applications must use real Miners; mocks do not qualify.
11. **Submit the separate Track 1 entry.** Registration and activation do not
    complete the hackathon submission. Open
    <https://submissions.telegraphprotocol.com/>, choose **Track 1: Miner
    Submission**, connect and sign with the owner wallet, provide the active
    Miner ID, upload the exact registered YAML, enter the required X username,
    and select **Sign & Submit** before August 31 at 23:59:59 UTC. Reopen the
    entry and verify every recorded field.
12. **Complete the community requirements.** Join the required official
    Discord and post genuine progress updates publicly on X with
    `@Telegraphprotoc` tagged, as required by the judging rules.
13. **Keep it operational.** Monitor health, endpoint success, latency, and
    Telegraph activation through September 7 at 23:59:59 UTC. An active Miner
    that goes offline during Track 3 violates the rules.

The official protocol details behind this sequence are the
[YAML Miner Standard](https://github.com/telegraphprotocol/telegraph-docs/blob/main/miners/yaml-config.md),
[Miner registration guide](https://github.com/telegraphprotocol/telegraph-docs/blob/main/miners/miner-registration.md),
[live intents endpoint](https://devnode.telegraphprotocol.com/engine/v1/intents),
and [live Miner catalog](https://devnode.telegraphprotocol.com/api/miners).

## Demo evidence to preserve

Use three concise, dated demonstrations:

1. **Supported:** at least two independent sources support the claim; show the
   verdict, calculated confidence, coverage, source domains, evidence hashes,
   and verification result.
2. **Refuted:** independent sources contradict the claim; show refuting evidence
   IDs and the resulting `REFUTED` verdict.
3. **Abstained:** current evidence is sparse or materially conflicting; show
   `MIXED` or `INSUFFICIENT_EVIDENCE`, `abstained: true`, triggered Maqam rules,
   and why the system refused a decisive answer.

The third case is the product proof: autonomous agents should not act on a
plausible sentence when the evidence contract fails.

For each case retain the request JSON, response JSON, HTTP status, response
time, Telegraph Miner ID, routed intent, Telegraph signal hash or receipt,
ProofPack manifest hash, and the output of the offline ProofPack verifier.
Remove personal data and credentials before publishing evidence.

## Submission copy

> Autonomous agents should act on evidence, not plausible answers. Qarinah
> ProofPack is a Telegraph `FACT_CHECK` and `RESEARCH_SYNTHESIS` Miner that turns
> live web research into machine-verifiable evidence packs containing source
> provenance, SHA-256 content and manifest hashes, calculated confidence,
> contradictions, evidence coverage, freshness, and explicit abstention.
> Cockroach gathers evidence, Qarinah preserves its provenance, Maqam enforces
> the evidence threshold, and Telegraph verifies and routes the resulting
> intelligence.

## Open-source foundation

Qarinah ProofPack is a new, isolated public repository. It builds on released
open-source components rather than changing their repositories:

- [Qarinah](https://github.com/AjnasNB/qarinah) supplies the append-only,
  hash-linked evidence-event model and provenance vocabulary.
- [Cockroach Crawler](https://github.com/AjnasNB/cockroach-crawler) supplies the
  live web acquisition layer.
- [Cockroach Browser](https://github.com/AjnasNB/cockroach-browser) is the public
  browser and research automation companion used by the wider acquisition
  stack.
- [Maqam](https://github.com/AjnasNB/maqam) supplies the policy boundary that
  turns weak coverage, low confidence, or material conflict into abstention.

The integration is intentionally Telegraph-native: Telegraph answers “which
Miner should receive this intent?”, while the ProofPack answers “is the
evidence strong enough for an agent to trust the result?”

## Post-registration application track

The same endpoint can power a separate `Qarinah Decision Gate` application
during Track 3: obtain real routed Telegraph intelligence, verify the ProofPack,
compare its evidence metrics with an action-specific threshold, then allow or
block the proposed action. Keep that application submission separate from this
Miner registration and use real Telegraph requests only.
