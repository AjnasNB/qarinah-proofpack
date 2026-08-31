import { createHash } from "node:crypto";

import { getDomain } from "tldts";

import { type AcquiredPage } from "./acquire";
import { canonicalizeUrl } from "./search";

const MAX_EVIDENCE = 30;
const MAX_SOURCE_TEXT_CHARS = 500_000;
const MAX_PASSAGES_PER_SOURCE = 60;
const MAX_PASSAGE_CHARS = 720;
const MIN_PASSAGE_CHARS = 60;

const STOP_WORDS = new Set([
  "a", "about", "an", "and", "are", "as", "at", "be", "been", "being", "by", "can", "could",
  "did", "do", "does", "for", "from", "had", "has", "have", "how", "if", "in", "is", "it", "its",
  "may", "might", "of", "on", "or", "should", "that", "the", "their", "there", "this", "to", "true",
  "was", "were", "what", "when", "where", "which", "who", "why", "will", "with", "would",
]);

export interface EvidenceCandidate {
  url: string;
  canonical: string;
  title: string;
  excerpt: string;
  retrievedAt: string;
  publishedAt: string | null;
  contentHash: string;
  domain: string;
  relevance: number;
  sourceType: AcquiredPage["sourceType"];
  quality: number;
  freshness: number;
}

export interface ExtractEvidenceOptions {
  maxEvidence?: number;
}

interface ScoredPassage {
  candidate: EvidenceCandidate;
  passageIndex: number;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function rounded(value: number): number {
  return Number(clamp(value).toFixed(4));
}

function positiveInteger(value: number | undefined): number {
  const candidate = value ?? 12;
  if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > MAX_EVIDENCE) {
    throw new TypeError(`maxEvidence must be an integer between 1 and ${MAX_EVIDENCE}.`);
  }
  return candidate;
}

function normalizedText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/gu, " ")
    .replace(/[\t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function token(value: string): string {
  let output = value.toLocaleLowerCase("en-US").replace(/['’]s$/u, "");
  if (output.length > 5 && output.endsWith("ies")) output = `${output.slice(0, -3)}y`;
  else if (output.length > 5 && output.endsWith("ing")) output = output.slice(0, -3);
  else if (output.length > 4 && output.endsWith("ed")) output = output.slice(0, -2);
  else if (output.length > 4 && output.endsWith("s")) output = output.slice(0, -1);
  return output;
}

function tokenize(value: string, removeStopWords = false): string[] {
  const words = value.normalize("NFKC").match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu) ?? [];
  const result = words.map(token).filter((item) => item.length >= 2);
  return removeStopWords ? result.filter((item) => !STOP_WORDS.has(item)) : result;
}

function queryTerms(query: string): string[] {
  if (typeof query !== "string" || !query.normalize("NFKC").trim()) {
    throw new TypeError("Evidence extraction query must be a non-empty string.");
  }
  if (query.length > 2_048) throw new TypeError("Evidence extraction query cannot exceed 2048 characters.");
  const useful = tokenize(query, true);
  return [...new Set(useful.length ? useful : tokenize(query))].slice(0, 64);
}

function splitLongText(value: string): string[] {
  const sentences = value.split(/(?<=[.!?])\s+(?=[\p{Lu}\p{N}\["'])/gu).filter(Boolean);
  if (sentences.length <= 1) {
    const chunks: string[] = [];
    let remaining = value;
    while (remaining.length > MAX_PASSAGE_CHARS) {
      const boundary = remaining.lastIndexOf(" ", MAX_PASSAGE_CHARS);
      const cut = boundary >= 320 ? boundary : MAX_PASSAGE_CHARS;
      chunks.push(remaining.slice(0, cut).trim());
      remaining = remaining.slice(cut).trim();
    }
    if (remaining) chunks.push(remaining);
    return chunks;
  }

  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    if (sentence.length > MAX_PASSAGE_CHARS) {
      if (current) chunks.push(current);
      chunks.push(...splitLongText(sentence));
      current = "";
      continue;
    }
    const combined = current ? `${current} ${sentence}` : sentence;
    if (combined.length > MAX_PASSAGE_CHARS) {
      if (current) chunks.push(current);
      current = sentence;
    } else {
      current = combined;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function passages(text: string): string[] {
  const normalized = normalizedText(text.slice(0, MAX_SOURCE_TEXT_CHARS));
  const blocks = normalized.split(/\n{2,}|(?<=[.!?])\n+/gu);
  const output: string[] = [];
  const observed = new Set<string>();
  for (const block of blocks) {
    const clean = block.replace(/\s+/g, " ").trim();
    if (!clean) continue;
    for (const passage of clean.length > MAX_PASSAGE_CHARS ? splitLongText(clean) : [clean]) {
      const bounded = passage.trim();
      if (bounded.length < MIN_PASSAGE_CHARS || observed.has(bounded)) continue;
      observed.add(bounded);
      output.push(bounded);
      if (output.length >= MAX_PASSAGES_PER_SOURCE) return output;
    }
  }
  return output;
}

function relevanceScore(value: string, title: string, terms: readonly string[]): number {
  const passageTokens = tokenize(value);
  if (!passageTokens.length || !terms.length) return 0;
  const counts = new Map<string, number>();
  for (const item of passageTokens) counts.set(item, (counts.get(item) ?? 0) + 1);
  const matched = terms.filter((term) => counts.has(term));
  if (!matched.length) return 0;
  const coverage = matched.length / terms.length;
  const frequency = Math.min(1, matched.reduce((sum, term) => sum + Math.min(2, counts.get(term) ?? 0), 0) / terms.length);
  const density = Math.min(1, matched.length / Math.max(6, Math.sqrt(passageTokens.length) * 2));
  const normalizedPassage = passageTokens.join(" ");
  const phrase = terms.length > 1 && normalizedPassage.includes(terms.join(" ")) ? 1 : 0;
  const titleTokens = new Set(tokenize(title));
  const titleCoverage = matched.filter((term) => titleTokens.has(term)).length / terms.length;
  return rounded(coverage * 0.62 + frequency * 0.17 + density * 0.09 + phrase * 0.07 + titleCoverage * 0.05);
}

function sourceQuality(page: AcquiredPage, domain: string): number {
  let score = 0.42;
  if (page.canonical.startsWith("https://")) score += 0.1;
  if (domain.endsWith(".gov") || domain.endsWith(".gov.uk")) score += 0.18;
  else if (domain.endsWith(".edu") || domain.endsWith(".ac.uk")) score += 0.13;
  if (page.title.trim()) score += 0.05;
  if (page.description.trim()) score += 0.04;
  if (page.text.length >= 1_500) score += 0.08;
  if (page.text.length >= 8_000) score += 0.04;
  if (page.robotsAllowed === true) score += 0.04;
  if (page.robotsAllowed === false) score -= 0.25;
  if (page.sourceType === "rendered") score -= 0.03;
  score += Math.max(0, 0.05 - Math.max(0, page.searchRank - 1) * 0.006);
  return rounded(score);
}

function freshnessScore(publishedAt: string | null, retrievedAt: string): number {
  if (!publishedAt || !Number.isFinite(Date.parse(publishedAt))) return 0.5;
  const published = Date.parse(publishedAt);
  const retrieved = Number.isFinite(Date.parse(retrievedAt)) ? Date.parse(retrievedAt) : published;
  const ageDays = (retrieved - published) / 86_400_000;
  if (ageDays < -7) return 0.35;
  if (ageDays <= 7) return 1;
  if (ageDays <= 30) return 0.92;
  if (ageDays <= 90) return 0.82;
  if (ageDays <= 180) return 0.72;
  if (ageDays <= 365) return 0.62;
  if (ageDays <= 730) return 0.48;
  return 0.35;
}

function sourceDomain(url: string): string {
  const hostname = new URL(url).hostname.toLowerCase();
  return getDomain(hostname, { allowPrivateDomains: false }) ?? hostname;
}

function validContentHash(page: AcquiredPage): string {
  return /^sha256:[a-f0-9]{64}$/iu.test(page.contentHash)
    ? page.contentHash.toLowerCase()
    : `sha256:${createHash("sha256").update(page.text || page.markdown || page.canonical).digest("hex")}`;
}

function canonicalPages(pagesInput: readonly AcquiredPage[]): AcquiredPage[] {
  if (!Array.isArray(pagesInput)) throw new TypeError("Acquired pages must be an array.");
  const byUrl = new Map<string, AcquiredPage>();
  for (const page of pagesInput) {
    const canonical = canonicalizeUrl(page?.canonical || page?.url);
    if (!canonical || typeof page?.text !== "string") continue;
    const normalized = { ...page, canonical, url: canonicalizeUrl(page.url) ?? canonical };
    const current = byUrl.get(canonical);
    if (!current || normalized.text.length > current.text.length) byUrl.set(canonical, normalized);
  }
  return [...byUrl.values()].sort((left, right) => (
    left.searchRank - right.searchRank || left.canonical.localeCompare(right.canonical)
  ));
}

function comparePassages(left: ScoredPassage, right: ScoredPassage): number {
  return (
    right.candidate.relevance - left.candidate.relevance ||
    right.candidate.quality - left.candidate.quality ||
    right.candidate.freshness - left.candidate.freshness ||
    left.candidate.canonical.localeCompare(right.candidate.canonical) ||
    left.passageIndex - right.passageIndex ||
    left.candidate.excerpt.localeCompare(right.candidate.excerpt)
  );
}

/** Rank bounded, citation-ready passages without a generative extraction step. */
export function extractEvidence(
  query: string,
  pagesInput: readonly AcquiredPage[],
  options: ExtractEvidenceOptions = {},
): EvidenceCandidate[] {
  const terms = queryTerms(query);
  const maxEvidence = positiveInteger(options.maxEvidence);
  const pages = canonicalPages(pagesInput);
  const scored: ScoredPassage[] = [];

  for (const page of pages) {
    const domain = sourceDomain(page.canonical);
    const quality = sourceQuality(page, domain);
    const freshness = freshnessScore(page.publishedAt, page.retrievedAt);
    const contentHash = validContentHash(page);
    const ranked = passages(page.text || page.markdown)
      .map((excerpt, passageIndex) => ({
        candidate: {
          url: page.url,
          canonical: page.canonical,
          title: page.title,
          excerpt,
          retrievedAt: page.retrievedAt,
          publishedAt: page.publishedAt,
          contentHash,
          domain,
          relevance: relevanceScore(excerpt, page.title, terms),
          sourceType: page.sourceType,
          quality,
          freshness,
        } satisfies EvidenceCandidate,
        passageIndex,
      }))
      .filter((item) => item.candidate.relevance >= 0.08)
      .sort(comparePassages)
      .slice(0, 3);
    scored.push(...ranked);
  }

  scored.sort(comparePassages);
  const selected: ScoredPassage[] = [];
  const selectedKeys = new Set<string>();
  const selectedSources = new Set<string>();

  // First pass guarantees source diversity before any source contributes a
  // second passage. The second pass fills remaining capacity by score.
  for (const item of scored) {
    if (selected.length >= maxEvidence) break;
    if (selectedSources.has(item.candidate.canonical)) continue;
    const key = `${item.candidate.canonical}\0${item.candidate.excerpt}`;
    if (selectedKeys.has(key)) continue;
    selected.push(item);
    selectedKeys.add(key);
    selectedSources.add(item.candidate.canonical);
  }
  for (const item of scored) {
    if (selected.length >= maxEvidence) break;
    const key = `${item.candidate.canonical}\0${item.candidate.excerpt}`;
    if (selectedKeys.has(key)) continue;
    selected.push(item);
    selectedKeys.add(key);
  }

  return selected.sort(comparePassages).map((item) => item.candidate);
}
