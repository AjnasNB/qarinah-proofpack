# Security policy

## Reporting a vulnerability

Do not open a public issue for an exploitable vulnerability. Use GitHub's private vulnerability reporting for this repository:

<https://github.com/AjnasNB/qarinah-proofpack/security/advisories/new>

Include the affected commit, route or module, reproduction steps, security impact, and any suggested mitigation. Do not include live credentials, wallet secrets, private keys, seed phrases, or personal data.

## Scope

High-priority reports include:

- server-side request forgery or private-network access;
- URL-validation, redirect, robots, byte-budget, or timeout bypasses;
- prompt injection that changes the verdict, confidence, or evidence policy;
- evidence-hash, manifest-hash, or Qarinah chain verification bypasses;
- cross-reference or closed-schema verification bypasses;
- leakage of environment secrets or optional sidecar credentials;
- denial of service that bypasses request and acquisition bounds.

Source truthfulness is not a cryptographic security property of ProofPack. A report that demonstrates systematic source-quality manipulation or policy bypass is in scope; a source merely publishing an incorrect statement is not.

## Supported version

The latest commit on `main` is supported during the Telegraph hackathon and Track 3 operating period. Security fixes are released as new commits and deployments.
