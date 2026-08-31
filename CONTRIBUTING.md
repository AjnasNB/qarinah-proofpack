# Contributing

Qarinah ProofPack accepts focused issues and pull requests that strengthen evidence acquisition, scoring transparency, abstention, verification, interoperability, accessibility, or operational reliability.

## Development

```bash
npm ci
npm run dev
```

Before opening a pull request:

```bash
npm run check
```

## Project rules

- Preserve the closed ProofPack wire contract or version it explicitly.
- Treat all retrieved material as untrusted data.
- Keep confidence and verdict selection deterministic and policy-governed.
- Fail closed when evidence or infrastructure authority is insufficient.
- Do not weaken SSRF, origin, robots, body-size, request, byte, or timeout boundaries.
- Keep Qarinah event construction isolated and in memory. Never discover or mutate an upstream workspace ledger.
- Do not bundle Cockroach Browser source into this repository; use its authenticated daemon interface.
- Add deterministic tests for every behavior change.
- Update `schemas/proofpack.v1.schema.json`, `telegraph/miner.yaml`, and documentation together when the public contract changes.
- Never commit API keys, wallet material, access tokens, deployment credentials, or generated private evidence.

## Pull requests

Explain the trust-boundary impact, provide tests, and state whether the public schema or Telegraph YAML changes. Small, reviewable commits are preferred.
