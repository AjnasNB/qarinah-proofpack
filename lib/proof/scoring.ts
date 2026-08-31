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
  temporalPrecision: number;
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

const TEMPORAL_EVENT_FAMILIES = [
  { id: "launch", pattern: /\blaunch(?:ed|es|ing)?\b/giu },
  { id: "release", pattern: /\breleas(?:e|ed|es|ing)\b/giu },
  { id: "announce", pattern: /\bannounc(?:e|ed|es|ing)\b/giu },
  { id: "publish", pattern: /\bpublish(?:ed|es|ing)?\b/giu },
  { id: "schedule", pattern: /\bschedul(?:e|ed|es|ing)\b/giu },
  { id: "start", pattern: /\b(?:start|begin)(?:s|ning|ned|ed|ing)?\b/giu },
  { id: "open", pattern: /\bopen(?:ed|s|ing)?\b/giu },
  { id: "close", pattern: /\b(?:clos(?:e|ed|es|ing)|end(?:ed|s|ing)?)\b/giu },
  { id: "acquire", pattern: /\bacquir(?:e|ed|es|ing)\b/giu },
  { id: "merge", pattern: /\bmerg(?:e|ed|es|ing)\b/giu },
  { id: "file", pattern: /\bfil(?:e|ed|es|ing)\b/giu },
  { id: "disruption", pattern: /\b(?:delay(?:ed|s|ing)?|postpon(?:e|ed|es|ing)|reschedul(?:e|ed|es|ing)|push(?:ed|es|ing)?\s+back)\b/giu }
] as const;

const RESCHEDULE_DESTINATION_PATTERN = /\b(?:delay(?:ed|s|ing)?|postpon(?:e|ed|es|ing)|push(?:ed|es|ing)?|mov(?:e|ed|es|ing))\b[\s\S]{0,220}?\b(?:until|to)\b[\s\S]{0,48}?\b(1\d{3}|20\d{2})\b/giu;
const RESCHEDULE_FOR_DESTINATION_PATTERN = /\breschedul(?:e|ed|es|ing)\b[\s\S]{0,100}?\b(?:for|to)\b[\s\S]{0,48}?\b(1\d{3}|20\d{2})\b/giu;
const TARGETING_DESTINATION_PATTERN = /\b(?:now\s+(?:(?:is|are)\s+)?targeting|targeting)\b[\s\S]{0,64}?\b(1\d{3}|20\d{2})\b[\s\S]{0,48}?\bfor\s+(?:the\s+)?(launch(?:ed|es|ing)?|releas(?:e|ed|es|ing))\b/giu;
const EVENT_DATE_CUE_PATTERN = /\b(?:in|on|for|to|until|by|during|scheduled|expected|targeted|date)\b/iu;
const DISRUPTION_PATTERN = /\b(?:delay(?:ed|s|ing)?|postpon(?:e|ed|es|ing)|reschedul(?:e|ed|es|ing)|push(?:ed|es|ing)?\s+back)\b/iu;
const COMPLETED_EVENT_PATTERNS = new Map<string, RegExp>([
  ["launch", /\blaunch(?:ed|es)\b/iu],
  ["release", /\breleas(?:ed|es)\b/iu],
  ["announce", /\bannounc(?:ed|es)\b/iu],
  ["publish", /\bpublish(?:ed|es)\b/iu],
  ["start", /\b(?:started|began|begins)\b/iu],
  ["open", /\bopen(?:ed|s)\b/iu],
  ["close", /\b(?:clos(?:ed|es)|end(?:ed|s))\b/iu],
  ["acquire", /\bacquir(?:ed|es)\b/iu],
  ["merge", /\bmerg(?:ed|es)\b/iu],
  ["file", /\bfil(?:ed|es)\b/iu]
]);

interface LocatedMatch {
  value: string;
  start: number;
  end: number;
}

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

function locatedYears(value: string): LocatedMatch[] {
  return [...value.matchAll(/\b(?:1\d{3}|20\d{2})\b/gu)].map((match) => ({
    value: match[0],
    start: match.index,
    end: match.index + match[0].length
  }));
}

function spanDistance(left: LocatedMatch, right: LocatedMatch): number {
  if (left.end < right.start) return right.start - left.end;
  if (right.end < left.start) return left.start - right.end;
  return 0;
}

function focusedEventFamilyIds(query: string): Set<string> {
  const queryYears = locatedYears(query);
  if (!queryYears.length) return new Set();
  const matches: Array<LocatedMatch & { id: string }> = [];
  for (const family of TEMPORAL_EVENT_FAMILIES) {
    for (const match of query.matchAll(family.pattern)) {
      matches.push({
        id: family.id,
        value: match[0],
        start: match.index,
        end: match.index + match[0].length
      });
    }
  }
  if (!matches.length) return new Set();
  const minimumDistance = Math.min(...matches.map((match) => (
    Math.min(...queryYears.map((year) => spanDistance(match, year)))
  )));
  return new Set(matches
    .filter((match) => Math.min(...queryYears.map((year) => spanDistance(match, year))) === minimumDistance)
    .map((match) => match.id));
}

function hasCompletedFocusedEvent(value: string, focusedIds: ReadonlySet<string>): boolean {
  return [...focusedIds].some((id) => COMPLETED_EVENT_PATTERNS.get(id)?.test(value) === true);
}

/**
 * Find years attached to the event the claim dates, rather than treating an
 * article's publication/update year as the event year. The caller deliberately
 * falls back to passage-level years when this conservative relation finder has
 * no result.
 */
function eventYears(value: string, query: string, allowHeuristic = true): Set<string> {
  const focusedIds = focusedEventFamilyIds(query);
  if (!focusedIds.size) return new Set();
  const anchors: LocatedMatch[] = [];
  for (const family of TEMPORAL_EVENT_FAMILIES) {
    if (!focusedIds.has(family.id)) continue;
    for (const match of value.matchAll(family.pattern)) {
      anchors.push({
        value: match[0],
        start: match.index,
        end: match.index + match[0].length
      });
    }
  }
  if (!anchors.length) return new Set();

  // A rescheduling destination supersedes an earlier target year. Require the
  // rescheduling phrase to occur near the queried event so unrelated dates do
  // not influence classification.
  const destinations = [
    ...value.matchAll(RESCHEDULE_DESTINATION_PATTERN),
    ...value.matchAll(RESCHEDULE_FOR_DESTINATION_PATTERN)
  ]
    .filter((match) => anchors.some((anchor) => spanDistance(anchor, {
      value: match[0],
      start: match.index,
      end: match.index + match[0].length
    }) <= 120))
    .map((match) => match[1]);
  if (destinations.length) return new Set(destinations);

  const targetedDestinations = [...value.matchAll(TARGETING_DESTINATION_PATTERN)]
    .filter((match) => {
      const eventId = match[2].toLocaleLowerCase("en-US").startsWith("launch") ? "launch" : "release";
      return focusedIds.has(eventId);
    })
    .map((match) => match[1]);
  if (targetedDestinations.length) return new Set(targetedDestinations);
  if (!allowHeuristic) return new Set();

  const foundYears = locatedYears(value);
  if (!foundYears.length) return new Set();
  const associated = new Set<string>();
  for (const anchor of anchors) {
    const ranked = foundYears
      .map((year) => {
        const after = year.start >= anchor.end;
        const between = after
          ? value.slice(anchor.end, year.start)
          : value.slice(year.end, anchor.start);
        const distance = spanDistance(anchor, year);
        const cue = after && distance <= 100 && EVENT_DATE_CUE_PATTERN.test(between);
        const eligible = cue || distance <= (after ? 60 : 80);
        return {
          year,
          eligible,
          rank: (cue ? 0 : 1) + distance / 1_000
        };
      })
      .filter((item) => item.eligible)
      .sort((left, right) => left.rank - right.rank || left.year.start - right.year.start);
    if (ranked.length) associated.add(ranked[0].year.value);
  }
  return associated;
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
  const focusedEventIds = focusedEventFamilyIds(query);
  const localYears = years(localEvidence);
  const authoritativeEventYears = eventYears(excerpt, query, false);
  const localEventYears = eventYears(localEvidence, query);
  const allRelevantYears = relevantYears(excerpt, claimTerms);
  const allMentionedYears = years(excerpt);
  const evidenceYears = authoritativeEventYears.size
    ? authoritativeEventYears
    : localEventYears.size
      ? localEventYears
      : localYears.size
        ? localYears
        : allRelevantYears;
  const temporalPrecision = claimYears.size
    ? 1 / Math.max(1, allMentionedYears.size)
    : 1;
  const matchingYear = claimYears.size === 0
    || [...claimYears].some((year) => evidenceYears.has(year));
  const yearConflict = claimYears.size > 0
    && evidenceYears.size > 0
    && !matchingYear;
  const lexicalSupport = lexicalCoverage >= 0.75;
  const supportSufficient = matchingYear
    && (explicitSupport || evidenceNegative || (claimYears.size === 0 && lexicalSupport));
  const unresolvedDisruption = claimYears.size > 0
    && !focusedEventIds.has("disruption")
    && authoritativeEventYears.size === 0
    && DISRUPTION_PATTERN.test(excerpt)
    && !hasCompletedFocusedEvent(excerpt, focusedEventIds);

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
  } else if (unresolvedDisruption && stance === "SUPPORT") {
    // A dated delay/postponement headline is not evidence that the event
    // happened in the publication year. Without a stated destination year or
    // explicit completed-event verb, keep it neutral instead of manufacturing
    // support from the dateline.
    stance = "UNCERTAIN";
    stanceScore = 0.24 + relevance * 0.3;
  }

  return {
    ...candidate,
    relevance: round(relevance),
    quality: round(candidate.quality),
    freshness: round(candidate.freshness),
    stance,
    stanceScore: round(stanceScore),
    matchedTerms,
    temporalPrecision: round(temporalPrecision)
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
      const rightRank = right.relevance * right.quality * right.stanceScore * (0.4 + 0.6 * right.temporalPrecision);
      const leftRank = left.relevance * left.quality * left.stanceScore * (0.4 + 0.6 * left.temporalPrecision);
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
