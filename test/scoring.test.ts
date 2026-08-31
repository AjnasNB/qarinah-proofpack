import { describe, expect, it } from "vitest";
import { scoreEvidence, tokenizeClaim } from "@/lib/proof/scoring";

describe("scoreEvidence", () => {
  it("computes the documented weighted confidence components", () => {
    const score = scoreEvidence("Company X announced Product Y for September 2026", [
      {
        url: "https://company.example/news/product-y",
        domain: "company.example",
        excerpt: "Company X officially announced Product Y for September 2026 in its press release.",
        relevance: 0.96,
        quality: 0.98,
        freshness: 0.99
      },
      {
        url: "https://wire.example/company-x-product-y",
        domain: "wire.example",
        excerpt: "Company X confirmed Product Y will be released in September 2026.",
        relevance: 0.91,
        quality: 0.88,
        freshness: 0.97
      },
      {
        url: "https://trade.example/product-y-launch",
        domain: "trade.example",
        excerpt: "The Product Y launch announced by Company X is scheduled for September 2026.",
        relevance: 0.86,
        quality: 0.8,
        freshness: 0.94
      }
    ]);

    expect(score.winner).toBe("SUPPORT");
    expect(score.independentSources).toBe(3);
    expect(score.evidenceCoverage).toBeGreaterThanOrEqual(0.75);
    expect(score.confidence).toBeGreaterThan(0.7);
    expect(score.conflictScore).toBe(0);
    expect(score.evidence.every((item) => item.stance === "SUPPORT")).toBe(true);
  });

  it("recognizes direct negation as refuting evidence", () => {
    const score = scoreEvidence("Company X announced Product Y for September 2026", [
      {
        url: "https://company.example/corrections/product-y",
        domain: "company.example",
        excerpt: "Company X did not announce Product Y for September 2026 and called the claim false.",
        relevance: 0.98,
        quality: 0.98,
        freshness: 1
      },
      {
        url: "https://fact.example/product-y",
        domain: "fact.example",
        excerpt: "There is no evidence Company X announced Product Y for September 2026.",
        relevance: 0.9,
        quality: 0.9,
        freshness: 0.96
      }
    ]);

    expect(score.winner).toBe("REFUTE");
    expect(score.refuteWeight).toBeGreaterThan(score.supportWeight);
  });

  it("penalizes a single source", () => {
    const score = scoreEvidence("Company X announced Product Y for September 2026", [
      {
        url: "https://only.example/product-y",
        domain: "only.example",
        excerpt: "Company X announced Product Y for September 2026.",
        relevance: 0.95,
        quality: 0.9,
        freshness: 1
      }
    ]);
    expect(score.sourceDiversity).toBe(0.25);
    expect(score.confidence).toBeLessThan(0.7);
  });
});

describe("tokenizeClaim", () => {
  it("removes boilerplate and preserves distinct factual terms", () => {
    expect(tokenizeClaim("Is Product Y launching in September 2026?")).toEqual([
      "product",
      "launching",
      "september",
      "2026"
    ]);
  });
});
