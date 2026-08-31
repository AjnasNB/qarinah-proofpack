import { describe, expect, it } from "vitest";
import { hashText } from "../lib/proof/canonical";
import type { EvidenceCandidate } from "../lib/proof/extract";
import { buildProofPack } from "../lib/proof/pipeline";
import { verifyProofPack } from "../lib/proof/verify";

function candidate(index: number, excerpt: string): EvidenceCandidate {
  const url = `https://source-${index}.example${index % 2 ? ".org" : ".net"}/record`;
  return {
    url,
    canonical: url,
    title: `Independent record ${index}`,
    excerpt,
    retrievedAt: "2026-08-31T10:00:00.000Z",
    publishedAt: "2026-08-30T10:00:00.000Z",
    contentHash: hashText(excerpt),
    domain: `example${index % 2 ? ".org" : ".net"}`,
    relevance: 0.96,
    sourceType: "crawler",
    quality: 0.92,
    freshness: 0.99,
  };
}

describe("ProofPack pipeline", () => {
  it("seals and verifies a supported claim from independent evidence", async () => {
    const query = "Python was first released in 1991";
    const evidence = [1, 2, 3].map((index) => candidate(
      index,
      "Python was first released in 1991, according to the published language history.",
    ));
    const pack = await buildProofPack({ query, intent: "FACT_CHECK" }, { evidence });

    expect(pack.verdict).toBe("SUPPORTED");
    expect(pack.abstained).toBe(false);
    expect(pack.evidence).toHaveLength(3);
    expect(verifyProofPack(pack).valid).toBe(true);
  });

  it("fails closed with a valid sealed pack when no evidence exists", async () => {
    const pack = await buildProofPack(
      { query: "A claim without any retrievable public evidence", intent: "FACT_CHECK" },
      { evidence: [] },
    );

    expect(pack.verdict).toBe("INSUFFICIENT_EVIDENCE");
    expect(pack.abstained).toBe(true);
    expect(pack.evidence).toEqual([]);
    expect(verifyProofPack(pack).valid).toBe(true);
  });

  it("links material support and refutation as a contradiction", async () => {
    const query = "Product Y was released in August 2026";
    const evidence = [
      candidate(1, "Company records confirmed Product Y was released in August 2026."),
      candidate(2, "The filing announced Product Y was released in August 2026."),
      candidate(3, "Product Y was not released in August 2026, according to the updated notice."),
      candidate(4, "The official correction said Product Y was never released in August 2026."),
    ];
    const pack = await buildProofPack({ query, intent: "FACT_CHECK" }, { evidence });

    expect(pack.abstained).toBe(true);
    expect(["MIXED", "INSUFFICIENT_EVIDENCE"]).toContain(pack.verdict);
    expect(pack.contradictions).toHaveLength(1);
    expect(verifyProofPack(pack).valid).toBe(true);
  });
});
