import { describe, expect, it } from "vitest";

import { inferProofIntent } from "@/lib/proof/intent";

describe("inferProofIntent", () => {
  it.each([
    "Did the James Webb Space Telescope launch in 2021?",
    "Is the claim about Product Y true?",
    "What year was Python first released?",
  ])("keeps direct factual questions on FACT_CHECK: %s", (query) => {
    expect(inferProofIntent(query)).toBe("FACT_CHECK");
  });

  it.each([
    "Summarize the state of the evidence on room-temperature superconductors.",
    "Compare the safety evidence for Product A versus Product B.",
    "Research synthesis: what are the key findings on urban heat islands?",
  ])("recognizes explicit synthesis requests: %s", (query) => {
    expect(inferProofIntent(query)).toBe("RESEARCH_SYNTHESIS");
  });
});
