import { describe, expect, it } from "vitest";
import { applyProofPolicy } from "@/lib/proof/policy";
import type { DeterministicScore } from "@/lib/proof/scoring";

function score(overrides: Partial<DeterministicScore> = {}): DeterministicScore {
  return {
    confidence: 0.84,
    entailment: 0.86,
    sourceDiversity: 0.85,
    evidenceCoverage: 0.82,
    freshness: 0.9,
    sourceAgreement: 0.94,
    conflictScore: 0.06,
    independentSources: 3,
    supportWeight: 2.2,
    refuteWeight: 0.1,
    uncertainWeight: 0.1,
    winner: "SUPPORT",
    evidence: [
      {
        url: "https://a.example",
        domain: "a.example",
        excerpt: "Example supporting evidence.",
        relevance: 0.9,
        quality: 0.9,
        freshness: 0.9,
        stance: "SUPPORT",
        stanceScore: 0.9,
        matchedTerms: ["example"]
      }
    ],
    ...overrides
  };
}

describe("applyProofPolicy", () => {
  it("allows a supported signal that meets every threshold", () => {
    const result = applyProofPolicy(score());
    expect(result.verdict).toBe("SUPPORTED");
    expect(result.abstained).toBe(false);
    expect(result.governance.engine).toBe("maqam");
  });

  it("abstains when source diversity is too low", () => {
    const result = applyProofPolicy(score({ independentSources: 1, sourceDiversity: 0.25 }));
    expect(result.verdict).toBe("INSUFFICIENT_EVIDENCE");
    expect(result.reasonCodes).toContain("LOW_SOURCE_DIVERSITY");
    expect(result.abstained).toBe(true);
  });

  it("returns mixed and blocks action for material conflict", () => {
    const result = applyProofPolicy(score({
      confidence: 0.73,
      supportWeight: 1.3,
      refuteWeight: 1.1,
      conflictScore: 0.91,
      sourceAgreement: 0.54
    }));
    expect(result.verdict).toBe("MIXED");
    expect(result.reasonCodes).toContain("MATERIAL_CONTRADICTION");
    expect(result.abstained).toBe(true);
  });
});
