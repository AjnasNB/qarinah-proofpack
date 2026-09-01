import { describe, expect, it } from "vitest";

import { deterministicSynthesis } from "@/lib/proof/synthesis";

describe("deterministic synthesis", () => {
  it("uses one clean evidence sentence when crawled text lacks sentence spacing", () => {
    const result = deterministicSynthesis({
      query: "Did the James Webb Space Telescope launch in 2021?",
      verdict: "SUPPORTED",
      reason: "The evidence contract passed.",
      confidence: 0.82,
      evidence: [{
        url: "https://science.nasa.gov/mission/webb/launch/",
        domain: "nasa.gov",
        excerpt: "NASA's James Webb Space Telescope launched on December 25, 2021 from French Guiana.NASA published additional mission details after launch.",
        relevance: 0.9,
        quality: 0.95,
        freshness: 0.5,
        stance: "SUPPORT",
        stanceScore: 0.9,
        matchedTerms: ["james", "webb", "launch", "2021"],
        temporalPrecision: 1,
      }],
    });
    expect(result.answer).toContain("French Guiana.");
    expect(result.answer).not.toContain("additional mission details");
    expect(result.answer).not.toContain("Guiana.NASA");
  });
});
