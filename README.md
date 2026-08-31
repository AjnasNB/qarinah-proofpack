# Qarinah ProofPack

Evidence-backed, hash-verifiable research intelligence for autonomous agents.

Qarinah ProofPack is a standalone Telegraph Miner and web application. It accepts a factual claim or research question and returns a structured proof pack with a verdict, computed confidence, evidence provenance, source hashes, contradictions, coverage, freshness, and explicit abstention.

This repository is independent from the upstream Qarinah ecosystem repositories. It consumes their public packages and contracts without changing their source trees.

## Development

```bash
npm install
npm run dev
```

Open `http://localhost:3000` and check `http://localhost:3000/health`.

## Open-source foundation

- [Qarinah](https://github.com/AjnasNB/qarinah) supplies evidence-linked event envelopes and hash-chain provenance.
- [Cockroach Crawler](https://github.com/AjnasNB/cockroach-crawler) supplies bounded, robots-aware web acquisition and content hashes.
- [Maqam](https://github.com/AjnasNB/maqam) supplies policy and abstention governance.
- [Cockroach Browser](https://github.com/AjnasNB/cockroach-browser) is supported as an optional governed sidecar for JavaScript-heavy evidence sources.

## License

Apache-2.0. Third-party packages retain their own licenses.
