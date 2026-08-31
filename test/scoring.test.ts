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

  it("does not treat unrelated sentence negation as claim refutation", () => {
    const score = scoreEvidence(
      "Did the James Webb Space Telescope launch in 2021?",
      [{
        url: "https://science.nasa.gov/mission/webb/",
        domain: "nasa.gov",
        excerpt: "The James Webb Space Telescope launched on December 25, 2021. It does not orbit Earth like the Hubble Space Telescope.",
        relevance: 0.95,
        quality: 0.98,
        freshness: 0.7
      }]
    );

    expect(score.evidence[0].stance).toBe("SUPPORT");
    expect(score.refuteWeight).toBe(0);
  });

  it("treats an incompatible reported year as refuting evidence", () => {
    const score = scoreEvidence(
      "The James Webb Space Telescope launched in 2020",
      [{
        url: "https://science.nasa.gov/mission/webb/",
        domain: "nasa.gov",
        excerpt: "The James Webb Space Telescope launched on December 25, 2021.",
        relevance: 0.92,
        quality: 0.98,
        freshness: 0.7
      }]
    );

    expect(score.evidence[0].stance).toBe("REFUTE");
    expect(score.winner).toBe("REFUTE");
  });

  it("does not confuse an article publication year with the reported launch year", () => {
    const score = scoreEvidence(
      "Did the James Webb Space Telescope launch in 2020?",
      [{
        url: "https://science.nasa.gov/mission/webb/launch-update",
        domain: "nasa.gov",
        excerpt: "A NASA update published in 2020 said the James Webb Space Telescope was scheduled to launch in 2021.",
        relevance: 0.96,
        quality: 0.98,
        freshness: 0.7
      }]
    );

    expect(score.evidence[0].stance).toBe("REFUTE");
    expect(score.supportWeight).toBe(0);
    expect(score.winner).toBe("REFUTE");
  });

  it("uses a postponed event's destination year instead of its former target", () => {
    const score = scoreEvidence(
      "Did the James Webb Space Telescope launch in 2020?",
      [{
        url: "https://science.nasa.gov/mission/webb/schedule",
        domain: "nasa.gov",
        excerpt: "The James Webb Space Telescope launch, initially targeted for 2020, was postponed until 2021.",
        relevance: 0.97,
        quality: 0.98,
        freshness: 0.7
      }]
    );

    expect(score.evidence[0].stance).toBe("REFUTE");
    expect(score.supportWeight).toBe(0);
  });

  it("preserves support when the event itself is explicitly dated to the claim year", () => {
    const score = scoreEvidence(
      "Did the James Webb Space Telescope launch in 2020?",
      [{
        url: "https://example.test/direct-event-date",
        domain: "example.test",
        excerpt: "An article published in 2021 states that the James Webb Space Telescope launched in 2020.",
        relevance: 0.96,
        quality: 0.9,
        freshness: 0.7
      }]
    );

    expect(score.evidence[0].stance).toBe("SUPPORT");
    expect(score.refuteWeight).toBe(0);
  });

  it("refutes the 2020 JWST claim from the exact NASA delay and target-date passages", () => {
    const score = scoreEvidence(
      "Did the James Webb Space Telescope launch in 2020?",
      [
        {
          url: "https://www.nasa.gov/news-release/nasa-announces-seven-month-launch-delay-for-jwst/",
          domain: "nasa.gov",
          excerpt: "NASA announces seven-month launch delay for JWST July 16, 2020. NASA officials said Thursday the launch will be delayed seven months to Oct. 31, 2021.",
          relevance: 0.95,
          quality: 0.98,
          freshness: 0.35
        },
        {
          url: "https://www.nasa.gov/news-release/nasa-announces-new-james-webb-space-telescope-target-launch-date/",
          domain: "nasa.gov",
          excerpt: "NASA Announces New James Webb Space Telescope Target Launch Date. Jul 16, 2020. NASA now is targeting Oct. 31, 2021, for the launch. Previously, Webb was scheduled to launch in March 2021.",
          relevance: 0.99,
          quality: 0.98,
          freshness: 0.35
        }
      ]
    );

    expect(score.evidence.map((item) => item.stance)).toEqual(["REFUTE", "REFUTE"]);
    expect(score.supportWeight).toBe(0);
    expect(score.winner).toBe("REFUTE");
  });

  it("ranks a precise alternate event year above a multi-year index passage", () => {
    const score = scoreEvidence(
      "The James Webb Space Telescope launched in 2020",
      [
        {
          url: "https://science.nasa.gov/mission/webb/index",
          domain: "nasa.gov",
          excerpt: "April 2025 Webb monitoring update. November 2024 Webb imagery. The James Webb Space Telescope is the largest telescope ever launched. Latest 2026 images are available.",
          relevance: 0.99,
          quality: 0.99,
          freshness: 0.9
        },
        {
          url: "https://science.nasa.gov/mission/webb/launch",
          domain: "nasa.gov",
          excerpt: "The James Webb Space Telescope launched on December 25, 2021.",
          relevance: 0.9,
          quality: 0.95,
          freshness: 0.7
        }
      ]
    );

    expect(score.evidence[0].url).toContain("/launch");
    expect(score.evidence[0].temporalPrecision).toBe(1);
    expect(score.evidence[1].temporalPrecision).toBeLessThan(0.5);
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
