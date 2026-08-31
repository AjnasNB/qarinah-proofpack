export type ScoredStance = "SUPPORT" | "REFUTE" | "UNCERTAIN";

export interface ScoringCandidate {
  url: string;
  domain: string;
  excerpt: string;
  relevance: number;
  quality: number;
  freshness: number;
}

export interface ScoredCandidate extends ScoringCandidate {
  stance: ScoredStance;
  stanceScore: number;
  matchedTerms: string[];
}

export interface DeterministicScore {
  confidence: number;
  entailment: number;
  sourceDiversity: number;
  evidenceCoverage: number;
  freshness: number;
  sourceAgreement: number;
  conflictScore: number;
  independentSources: number;
  supportWeight: number;
  refuteWeight: number;
  uncertainWeight: number;
  winner: "SUPPORT" | "REFUTE" | "TIE";
  evidence: ScoredCandidate[];
}

const STOP_WORDS = new Set([
  "a", "about", "after", "all", "also", "an", "and", "are", "as", "at", "be", "because",
  "been", "before", "being", "but", "by", "can", "could", "did", "do", "does", "for", "from",
  "had", "has", "have", "how", "if", "in", "into", "is", "it", "its", "may", "might", "more",
  "most", "of", "on", "or", "our", "should", "so", "such", "than", "that", "the", "their",
  "then", "there", "these", "they", "this", "to", "true", "was", "were", "what", "when", "where",
  "which", "who", "why", "will", "with", "would", "yes"
]);

const NEGATION_PATTERNS = [
  /\b(?:did|does|do|is|are|was|were|has|have|had|will|would|can|could)\s+not\b/i,
  /\bno\s+(?:credible\s+)?evidence\b/i,
  /\b(?:false|incorrect|inaccurate|untrue|misleading|fabricated|debunked|refuted|denied|never)\b/i,
  /\bnot\s+(?:true|accurate|confirmed|supported|announced|released|launched)\b/i,
  /\b(?:hasn['’]t|haven['’]t|isn['’]t|aren['’]t|wasn['’]t|weren['’]t|didn['’]t|won['’]t)\b/i
];

const SUPPORT_PATTERNS = [
  /\b(?:confirmed|confirms|announced|announces|verified|officially|reported|published|released|launched)\b/i,
  /\b(?:according to|statement from|press release|scheduled for|will be available)\b/i
];

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function round(value: number): number {
  return Math.round(clamp(value) * 10_000) / 10_000;
}

export function tokenizeClaim(value: string): string[] {
  const normalized = value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[’']/g, "")
    .match(/[\p{L}\p{N}][\p{L}\p{N}-]{1,}/gu) ?? [];
  return [...new Set(normalized.filter((token) => !STOP_WORDS.has(token) && token.length > 2))].slice(0, 64);
}

function hasNegation(value: string): boolean {
  return NEGATION_PATTERNS.some((pattern) => pattern.test(value));
}

function stanceWindow(value: string, claimTerms: readonly string[]): string {
  const fragments = value
    .normalize("NFKC")
    .split(/(?<=[.!?])\s+|[\r\n]+/u)
    .map((fragment) => fragment.trim())
    .filter(Boolean);
  if (!fragments.length || !claimTerms.length) return value;
  let best = fragments[0];
  let bestMatches = -1;
  for (const fragment of fragments) {
    const lower = fragment.toLocaleLowerCase("en-US");
    const matches = claimTerms.reduce((count, term) => count + (lower.includes(term) ? 1 : 0), 0);
    if (matches > bestMatches) {
      best = fragment;
      bestMatches = matches;
    }
  }
  return bestMatches >= Math.min(2, Math.max(1, claimTerms.length)) ? best : value;
}

function years(value: string): Set<string> {
  return new Set(value.match(/\b(?:1\d{3}|20\d{2})\b/gu) ?? []);
}

function relevantYears(value: string, claimTerms: readonly string[]): Set<string> {
  const found = new Set<string>();
  const minimumMatches = Math.min(2, Math.max(1, claimTerms.length));
  for (const fragment of value.split(/(?<=[.!?])\s+|[\r\n]+/u)) {
    const lower = fragment.toLocaleLowerCase("en-US");
    const matches = claimTerms.reduce((count, term) => count + (lower.includes(term) ? 1 : 0), 0);
    if (matches < minimumMatches) continue;
    for (const year of years(fragment)) found.add(year);
  }
  return found;
}

function classifyStance(query: string, candidate: ScoringCandidate, claimTerms: string[]): ScoredCandidate {
  const excerpt = candidate.excerpt.normalize("NFKC");
  const excerptLower = excerpt.toLocaleLowerCase("en-US");
  const matchedTerms = claimTerms.filter((term) => excerptLower.includes(term));
  const lexicalCoverage = claimTerms.length ? matchedTerms.length / claimTerms.length : 0;
  const relevance = clamp(Math.max(candidate.relevance, lexicalCoverage));
  const claimNegative = hasNegation(query);
  const localEvidence = stanceWindow(excerpt, claimTerms);
  const evidenceNegative = hasNegation(localEvidence);
  const explicitSupport = SUPPORT_PATTERNS.some((pattern) => pattern.test(localEvidence));
  const claimYears = years(query);
  const localYears = years(localEvidence);
  const evidenceYears = localYears.size ? localYears : relevantYears(excerpt, claimTerms);
  const matchingYear = claimYears.size === 0
    || [...claimYears].some((year) => evidenceYears.has(year));
  const yearConflict = claimYears.size > 0
    && evidenceYears.size > 0
    && !matchingYear;
  const lexicalSupport = lexicalCoverage >= 0.75;
  const supportSufficient = matchingYear
    && (explicitSupport || evidenceNegative || (claimYears.size === 0 && lexicalSupport));

  let stance: ScoredStance = "UNCERTAIN";
  let stanceScore = 0.25 + relevance * 0.25;

  if (relevance >= 0.34 && yearConflict) {
    stance = claimNegative ? "SUPPORT" : "REFUTE";
    stanceScore = localYears.size
      ? 0.68 + relevance * 0.28
      : 0.48 + relevance * 0.2;
  } else if (relevance >= 0.34 && evidenceNegative !== claimNegative) {
    stance = "REFUTE";
    stanceScore = 0.58 + relevance * 0.36;
  } else if (relevance >= 0.34 && evidenceNegative === claimNegative && supportSufficient) {
    stance = "SUPPORT";
    stanceScore = (explicitSupport || evidenceNegative ? 0.62 : 0.52) + relevance * 0.34;
  }

  if (relevance < 0.34 || matchedTerms.length < Math.min(2, Math.max(1, claimTerms.length))) {
    stance = "UNCERTAIN";
    stanceScore = 0.2 + relevance * 0.35;
  }

  return {
    ...candidate,
    relevance: round(relevance),
    quality: round(candidate.quality),
    freshness: round(candidate.freshness),
    stance,
    stanceScore: round(stanceScore),
    matchedTerms
  };
}

function diversityScore(count: number): number {
  if (count <= 0) return 0;
  if (count === 1) return 0.25;
  if (count === 2) return 0.6;
  if (count === 3) return 0.85;
  return 1;
}

export function scoreEvidence(query: string, candidates: readonly ScoringCandidate[]): DeterministicScore {
  const claimTerms = tokenizeClaim(query);
  const evidence = candidates
    .map((candidate) => classifyStance(query, candidate, claimTerms))
    .sort((left, right) => {
      const rightRank = right.relevance * right.quality * right.stanceScore;
      const leftRank = left.relevance * left.quality * left.stanceScore;
      return rightRank - leftRank || left.url.localeCompare(right.url);
    });

  const weights = evidence.map((item) => clamp(item.relevance * (0.55 + item.quality * 0.45)));
  const supportWeight = evidence.reduce(
    (sum, item, index) => sum + (item.stance === "SUPPORT" ? weights[index] * item.stanceScore : 0),
    0
  );
  const refuteWeight = evidence.reduce(
    (sum, item, index) => sum + (item.stance === "REFUTE" ? weights[index] * item.stanceScore : 0),
    0
  );
  const uncertainWeight = evidence.reduce(
    (sum, item, index) => sum + (item.stance === "UNCERTAIN" ? weights[index] * item.stanceScore : 0),
    0
  );
  const decisiveWeight = supportWeight + refuteWeight;
  const winner = Math.abs(supportWeight - refuteWeight) < 0.08
    ? "TIE"
    : supportWeight > refuteWeight
      ? "SUPPORT"
      : "REFUTE";
  const winningEvidence = evidence.filter((item) => item.stance === winner);
  const entailment = winningEvidence.length
    ? winningEvidence.reduce((sum, item) => sum + item.stanceScore * item.relevance, 0)
      / winningEvidence.reduce((sum, item) => sum + item.relevance, 0)
    : 0;

  const covered = new Set(evidence.filter((item) => item.relevance >= 0.34).flatMap((item) => item.matchedTerms));
  const evidenceCoverage = claimTerms.length ? covered.size / claimTerms.length : 0;
  const domains = new Set(evidence.filter((item) => item.stance !== "UNCERTAIN").map((item) => item.domain));
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  const freshness = totalWeight
    ? evidence.reduce((sum, item, index) => sum + item.freshness * weights[index], 0) / totalWeight
    : 0;
  const sourceAgreement = decisiveWeight ? Math.max(supportWeight, refuteWeight) / decisiveWeight : 0;
  const conflictScore = decisiveWeight ? 1 - Math.abs(supportWeight - refuteWeight) / decisiveWeight : 0;
  let confidence =
    0.35 * entailment
    + 0.2 * diversityScore(domains.size)
    + 0.2 * evidenceCoverage
    + 0.15 * freshness
    + 0.1 * sourceAgreement;
  if (domains.size < 2) confidence = Math.max(0, confidence - 0.18);
  if (!evidence.length) confidence = 0;

  return {
    confidence: round(confidence),
    entailment: round(entailment),
    sourceDiversity: round(diversityScore(domains.size)),
    evidenceCoverage: round(evidenceCoverage),
    freshness: round(freshness),
    sourceAgreement: round(sourceAgreement),
    conflictScore: round(conflictScore),
    independentSources: domains.size,
    supportWeight: Math.round(supportWeight * 10_000) / 10_000,
    refuteWeight: Math.round(refuteWeight * 10_000) / 10_000,
    uncertainWeight: Math.round(uncertainWeight * 10_000) / 10_000,
    winner,
    evidence
  };
}
