import { PolicyEngine } from "maqam";
import type { DeterministicScore } from "./scoring";

export type PolicyVerdict = "SUPPORTED" | "REFUTED" | "MIXED" | "INSUFFICIENT_EVIDENCE";

export interface ProofPolicyConfig {
  minimumCoverage: number;
  minimumConfidence: number;
  minimumIndependentSources: number;
  mixedConflictThreshold: number;
  decisiveMargin: number;
}

export interface ProofPolicyResult {
  verdict: PolicyVerdict;
  abstained: boolean;
  reason: string;
  reasonCodes: string[];
  thresholds: ProofPolicyConfig;
  governance: {
    engine: "maqam";
    policyVersion: "proofpack-policy.v1";
    decision: "allow-signal" | "abstain";
  };
}

export const DEFAULT_PROOF_POLICY: Readonly<ProofPolicyConfig> = Object.freeze({
  minimumCoverage: 0.5,
  minimumConfidence: 0.55,
  minimumIndependentSources: 2,
  mixedConflictThreshold: 0.48,
  decisiveMargin: 0.12
});

function boundedConfig(config: Partial<ProofPolicyConfig>): ProofPolicyConfig {
  const merged = { ...DEFAULT_PROOF_POLICY, ...config };
  const ratios = {
    minimumCoverage: merged.minimumCoverage,
    minimumConfidence: merged.minimumConfidence,
    mixedConflictThreshold: merged.mixedConflictThreshold,
    decisiveMargin: merged.decisiveMargin
  };
  for (const [key, value] of Object.entries(ratios)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new TypeError(`${key} must be a finite number from 0 to 1.`);
    }
  }
  if (!Number.isInteger(merged.minimumIndependentSources) || merged.minimumIndependentSources < 1) {
    throw new TypeError("minimumIndependentSources must be a positive integer.");
  }
  return Object.freeze(merged);
}

export function applyProofPolicy(
  score: DeterministicScore,
  config: Partial<ProofPolicyConfig> = {}
): ProofPolicyResult {
  const thresholds = boundedConfig(config);
  const reasonCodes: string[] = [];

  if (!score.evidence.length) reasonCodes.push("NO_EVIDENCE");
  if (score.evidenceCoverage < thresholds.minimumCoverage) reasonCodes.push("LOW_COVERAGE");
  if (score.independentSources < thresholds.minimumIndependentSources) reasonCodes.push("LOW_SOURCE_DIVERSITY");
  if (score.confidence < thresholds.minimumConfidence) reasonCodes.push("LOW_CONFIDENCE");

  const totalDecisiveWeight = score.supportWeight + score.refuteWeight;
  const supportShare = totalDecisiveWeight ? score.supportWeight / totalDecisiveWeight : 0;
  const refuteShare = totalDecisiveWeight ? score.refuteWeight / totalDecisiveWeight : 0;
  const margin = Math.abs(supportShare - refuteShare);
  const wellSupportedConflict =
    score.conflictScore >= thresholds.mixedConflictThreshold
    && score.independentSources >= thresholds.minimumIndependentSources
    && score.evidenceCoverage >= thresholds.minimumCoverage
    && totalDecisiveWeight > 0;

  let verdict: PolicyVerdict;
  let abstained: boolean;
  let reason: string;

  if (wellSupportedConflict) {
    verdict = "MIXED";
    abstained = true;
    reasonCodes.push("MATERIAL_CONTRADICTION");
    reason = "Material support and refutation remain across independent sources, so the policy blocks a decisive answer.";
  } else if (reasonCodes.length) {
    verdict = "INSUFFICIENT_EVIDENCE";
    abstained = true;
    reason = "The available evidence does not meet the configured coverage, diversity, and confidence requirements.";
  } else if (margin < thresholds.decisiveMargin || score.winner === "TIE") {
    verdict = "INSUFFICIENT_EVIDENCE";
    abstained = true;
    reasonCodes.push("NO_DECISIVE_MARGIN");
    reason = "The evidence does not produce a sufficiently decisive support or refutation margin.";
  } else if (score.winner === "SUPPORT") {
    verdict = "SUPPORTED";
    abstained = false;
    reasonCodes.push("EVIDENCE_THRESHOLD_MET");
    reason = "Independent sources support the claim and the evidence contract meets every configured threshold.";
  } else {
    verdict = "REFUTED";
    abstained = false;
    reasonCodes.push("EVIDENCE_THRESHOLD_MET");
    reason = "Independent sources refute the claim and the evidence contract meets every configured threshold.";
  }

  const policyEngine = new PolicyEngine({
    allowedTools: ["proofpack.emit-signal"],
    maxToolCalls: 1
  });
  const maqamDecision = policyEngine.authorizeToolCall({
    toolName: "proofpack.emit-signal",
    input: {
      verdict,
      confidence: score.confidence,
      evidenceCoverage: score.evidenceCoverage,
      independentSources: score.independentSources
    },
    metadata: {
      effects: [],
      risk: "low"
    }
  });

  if (maqamDecision.status !== "allow") {
    verdict = "INSUFFICIENT_EVIDENCE";
    abstained = true;
    reasonCodes.push("MAQAM_SIGNAL_DENIED");
    reason = "Maqam denied emission of the intelligence signal under the active policy boundary.";
  }

  return {
    verdict,
    abstained,
    reason,
    reasonCodes: [...new Set(reasonCodes)],
    thresholds,
    governance: {
      engine: "maqam",
      policyVersion: "proofpack-policy.v1",
      decision: abstained ? "abstain" : "allow-signal"
    }
  };
}
