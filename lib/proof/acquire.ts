import { createHash } from "node:crypto";

import {
  PolicyEngine,
  ToolGateway,
  type AgentExecutionContext,
} from "maqam";
import {
  crawlDetailed,
  type CrawlDetailedResult,
  type CrawlFailure,
  type CrawlPage,
  type CrawlStats,
} from "cockroach-crawler";

import { canonicalizeUrl, type SearchResult } from "./search";

const MAX_ACQUISITION_PAGES = 15;
const MAX_RENDERED_FALLBACKS = 2;
const CRAWL_TIMEOUT_MS = 8_000;
const CRAWL_DURATION_MS = 25_000;
const CRAWL_PAGE_BYTES = 2 * 1024 * 1024;
const CRAWL_TOTAL_BYTES = 12 * 1024 * 1024;
const BROWSER_TIMEOUT_MS = 20_000;
const BROWSER_RESPONSE_BYTES = 1_500_000;
const BROWSER_TOOL_NAME = "research.render.cockroach-browser";

export interface AcquiredPage {
  url: string;
  canonical: string;
  title: string;
  description: string;
  language: string | null;
  text: string;
  markdown: string;
  retrievedAt: string;
  publishedAt: string | null;
  contentHash: string;
  contentType: string | null;
  bytes: number;
  status: number | null;
  robotsAllowed: boolean | null;
  sourceType: "crawler" | "rendered";
  searchRank: number;
  searchProvider: SearchResult["provider"];
}

export interface AcquisitionFailure {
  url: string;
  phase: string;
  code: string;
  error: string;
  source: "validation" | "crawler" | "cockroach-browser";
  renderedFallbackAttempted: boolean;
  recovered: boolean;
}

export interface AcquisitionStats {
  requested: number;
  accepted: number;
  crawlerPages: number;
  renderedPages: number;
  crawlFailures: number;
  failures: number;
  requests: number;
  bytes: number;
  skippedRobots: number;
  durationMs: number;
}

export interface AcquisitionResult {
  pages: AcquiredPage[];
  failures: AcquisitionFailure[];
  stats: AcquisitionStats;
  governanceTrace: Record<string, unknown>[];
}

export interface AcquireSourcesOptions {
  maxPages?: number;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
}

interface ValidatedSource {
  result: SearchResult;
  url: string;
  origin: string;
}

interface CrawlerAggregate {
  pages: CrawlPage[];
  failures: AcquisitionFailure[];
  stats: Pick<CrawlStats, "requests" | "bytes" | "skippedRobots" | "durationMs">;
}

interface BrowserSessionResponse {
  id: string;
}

interface BrowserSnapshotResponse {
  url: string;
  title: string;
  capturedAt: string;
  text: string;
  digest?: string;
  truncated?: boolean;
}

function positiveInteger(value: number | undefined, fallback: number, maximum: number, label: string): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > maximum) {
    throw new TypeError(`${label} must be an integer between 1 and ${maximum}.`);
  }
  return candidate;
}

function safeMessage(value: unknown): string {
  return (value instanceof Error ? value.message : String(value)).replace(/[\r\n]+/g, " ").slice(0, 1_000);
}

function safeCode(value: unknown, fallback = "CRAWL_ERROR"): string {
  if (!value || typeof value !== "object" || !("code" in value) || typeof value.code !== "string") {
    return fallback;
  }
  return value.code.replace(/[^A-Z0-9_-]/giu, "_").slice(0, 100) || fallback;
}

function isoTimestamp(value: string | undefined): string | null {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function acquisitionFailure(
  failure: Pick<CrawlFailure, "url" | "phase" | "code" | "error">,
  source: AcquisitionFailure["source"] = "crawler",
): AcquisitionFailure {
  return {
    url: failure.url,
    phase: failure.phase,
    code: failure.code,
    error: failure.error,
    source,
    renderedFallbackAttempted: false,
    recovered: false,
  };
}

function validateSources(results: readonly SearchResult[], maxPages: number): {
  sources: ValidatedSource[];
  failures: AcquisitionFailure[];
} {
  if (!Array.isArray(results)) throw new TypeError("Search results must be an array.");
  const sources: ValidatedSource[] = [];
  const failures: AcquisitionFailure[] = [];
  const observed = new Set<string>();

  for (const result of results) {
    if (sources.length >= maxPages) break;
    const candidate = typeof result?.canonical === "string" && result.canonical
      ? result.canonical
      : result?.url;
    const url = typeof candidate === "string" ? canonicalizeUrl(candidate) : null;
    if (!url) {
      failures.push({
        url: typeof candidate === "string" ? candidate.slice(0, 2_048) : "invalid-search-result",
        phase: "validation",
        code: "INVALID_SEARCH_RESULT_URL",
        error: "Search result did not contain a valid public HTTP(S) URL.",
        source: "validation",
        renderedFallbackAttempted: false,
        recovered: false,
      });
      continue;
    }
    if (observed.has(url)) continue;
    observed.add(url);
    sources.push({ result, url, origin: new URL(url).origin });
  }
  return { sources, failures };
}

function groupedByOrigin(sources: readonly ValidatedSource[]): ValidatedSource[][] {
  const groups = new Map<string, ValidatedSource[]>();
  for (const source of sources) {
    const group = groups.get(source.origin) ?? [];
    group.push(source);
    groups.set(source.origin, group);
  }
  return [...groups.values()];
}

function crawlOptions(group: readonly ValidatedSource[], signal: AbortSignal | undefined) {
  const pageCount = group.length;
  return {
    seeds: group.map((source) => source.url),
    allowedOrigins: [group[0].origin],
    maxPages: pageCount,
    maxSeeds: pageCount,
    maxRequests: pageCount * 3 + 1,
    maxQueue: pageCount,
    maxLinksPerPage: 32,
    maxUrlLength: 4_096,
    maxDepth: 0,
    concurrency: Math.min(3, pageCount),
    sameOrigin: true,
    includeSitemaps: false,
    obeyRobots: true,
    allowPrivateNetworks: false,
    skipSensitivePaths: true,
    delayMs: 100,
    timeoutMs: CRAWL_TIMEOUT_MS,
    maxDurationMs: CRAWL_DURATION_MS,
    maxBytes: CRAWL_PAGE_BYTES,
    maxTotalBytes: Math.min(CRAWL_TOTAL_BYTES, CRAWL_PAGE_BYTES * pageCount),
    maxRedirects: 3,
    maxRetries: 0,
    retryDelayMs: 0,
    userAgent: "QarinahProofPack/0.1 (+https://github.com/AjnasNB/qarinah-proofpack)",
    signal,
  };
}

function pageCoversSeed(page: CrawlPage, seed: string): boolean {
  const candidates = [page.url, page.canonical, ...(page.redirectChain ?? []).flatMap((hop) => [hop.from, hop.to])];
  return candidates.some((candidate) => typeof candidate === "string" && canonicalizeUrl(candidate) === seed);
}

function looksLikeJavaScriptShell(page: CrawlPage): boolean {
  const text = `${page.title}\n${page.description}\n${page.text}`.replace(/\s+/g, " ").trim();
  return text.length < 500 && /enable javascript|javascript (?:is )?required|requires javascript|loading (?:the )?(?:app|application)|client-side application/iu.test(text);
}

async function crawlGroup(group: readonly ValidatedSource[], signal: AbortSignal | undefined): Promise<CrawlerAggregate> {
  const startedAt = Date.now();
  try {
    const result: CrawlDetailedResult = await crawlDetailed(crawlOptions(group, signal));
    const pages: CrawlPage[] = [];
    const failures = result.failures.map((failure) => acquisitionFailure(failure));

    for (const page of result.pages) {
      if (looksLikeJavaScriptShell(page)) {
        failures.push(acquisitionFailure({
          url: page.url,
          phase: "page",
          code: "JS_SHELL_DETECTED",
          error: "Static retrieval returned a JavaScript application shell without substantive text.",
        }));
      } else {
        pages.push(page);
      }
    }

    for (const source of group) {
      const covered = result.pages.some((page) => pageCoversSeed(page, source.url));
      const failed = result.failures.some((failure) => canonicalizeUrl(failure.url) === source.url);
      if (!covered && !failed) {
        failures.push(acquisitionFailure({
          url: source.url,
          phase: "page",
          code: "NO_EXTRACTABLE_PAGE",
          error: "Crawler returned no extractable HTML or text page for this explicit URL.",
        }));
      }
    }

    return {
      pages,
      failures,
      stats: {
        requests: result.stats.requests,
        bytes: result.stats.bytes,
        skippedRobots: result.stats.skippedRobots,
        durationMs: result.stats.durationMs,
      },
    };
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    return {
      pages: [],
      failures: group.map((source) => acquisitionFailure({
        url: source.url,
        phase: "page",
        code: safeCode(error),
        error: safeMessage(error),
      })),
      stats: { requests: 0, bytes: 0, skippedRobots: 0, durationMs: Date.now() - startedAt },
    };
  }
}

async function boundedMap<TInput, TOutput>(
  values: readonly TInput[],
  concurrency: number,
  worker: (value: TInput) => Promise<TOutput>,
): Promise<TOutput[]> {
  const output = new Array<TOutput>(values.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await worker(values[index]);
    }
  });
  await Promise.all(runners);
  return output;
}

function sourceForPage(page: CrawlPage, sources: readonly ValidatedSource[]): ValidatedSource {
  return sources.find((source) => pageCoversSeed(page, source.url))
    ?? sources.find((source) => new URL(page.url).origin === source.origin)
    ?? sources[0];
}

function acquiredCrawlerPage(page: CrawlPage, source: ValidatedSource): AcquiredPage {
  const canonical = canonicalizeUrl(page.canonical ?? page.url) ?? source.url;
  const textHash = `sha256:${createHash("sha256").update(page.text || page.markdown || canonical).digest("hex")}`;
  return {
    url: canonicalizeUrl(page.url) ?? canonical,
    canonical,
    title: page.title.replace(/\s+/g, " ").trim().slice(0, 1_000),
    description: page.description.replace(/\s+/g, " ").trim().slice(0, 4_000),
    language: page.language,
    text: page.text.slice(0, 500_000),
    markdown: page.markdown.slice(0, 500_000),
    retrievedAt: isoTimestamp(page.fetchedAt) ?? new Date().toISOString(),
    publishedAt: source.result.publishedAt ?? isoTimestamp(page.lastModified ?? undefined),
    contentHash: page.contentHash ?? textHash,
    contentType: page.contentType ?? null,
    bytes: page.bytes ?? Buffer.byteLength(page.text, "utf8"),
    status: page.status ?? null,
    robotsAllowed: page.robotsAllowed ?? null,
    sourceType: "crawler",
    searchRank: source.result.rank,
    searchProvider: source.result.provider,
  };
}

function renderedFallbackEligible(failure: AcquisitionFailure): boolean {
  const value = `${failure.code} ${failure.error}`.toLowerCase();
  if (/robots|private|non.?public|ssrf|origin|sensitive|abort|timeout|duration|byte|too.?large|rate|429|401/iu.test(value)) {
    return false;
  }
  return /javascript|js[_ -]?(?:required|shell)|client.?side|render|browser|challenge|cloudflare|http 403|http 406/iu.test(value);
}

function browserConfiguration(): { baseUrl: string; origin: string; token: string } | null {
  const raw = process.env.COCKROACH_BROWSER_ENDPOINT?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TypeError("COCKROACH_BROWSER_ENDPOINT must be an absolute HTTP(S) URL.");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new TypeError("COCKROACH_BROWSER_ENDPOINT must be an HTTP(S) URL without credentials, query, or fragment.");
  }
  const token = process.env.COCKROACH_BROWSER_TOKEN?.trim() ?? "";
  if (!token || token.length > 8_192 || /[\r\n\0]/u.test(token)) {
    throw new TypeError("COCKROACH_BROWSER_TOKEN is required and must be a bounded single-line bearer token.");
  }
  return { baseUrl: url.toString().replace(/\/+$/, ""), origin: url.origin, token };
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > BROWSER_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error("Cockroach Browser response exceeded the byte limit.");
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > BROWSER_RESPONSE_BYTES) {
    throw new Error("Cockroach Browser response exceeded the byte limit.");
  }
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Cockroach Browser returned non-JSON status ${response.status}.`);
  }
  if (!response.ok) {
    const record = body && typeof body === "object" ? body as { error?: { message?: unknown } } : null;
    const message = typeof record?.error?.message === "string"
      ? record.error.message
      : `Cockroach Browser returned HTTP ${response.status}.`;
    throw new Error(message);
  }
  return body;
}

async function browserRequest(
  config: { baseUrl: string; token: string },
  fetchImplementation: typeof globalThis.fetch,
  path: string,
  method: "POST" | "DELETE",
  signal: AbortSignal,
  body?: unknown,
): Promise<unknown> {
  const response = await fetchImplementation(`${config.baseUrl}${path}`, {
    method,
    redirect: "error",
    signal,
    headers: {
      authorization: `Bearer ${config.token}`,
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return boundedJson(response);
}

async function renderWithCockroachBrowser(
  input: { url: string },
  context: AgentExecutionContext,
  config: { baseUrl: string; token: string },
  fetchImplementation: typeof globalThis.fetch,
): Promise<BrowserSnapshotResponse> {
  const canonical = canonicalizeUrl(input.url);
  if (!canonical) throw new TypeError("Rendered fallback requires a validated public URL.");
  const targetOrigin = new URL(canonical).origin;
  const signal = context.signal
    ? AbortSignal.any([context.signal, AbortSignal.timeout(BROWSER_TIMEOUT_MS)])
    : AbortSignal.timeout(BROWSER_TIMEOUT_MS);
  let sessionId: string | null = null;
  try {
    const session = await browserRequest(config, fetchImplementation, "/v1/sessions", "POST", signal, {
      mode: "headless",
      startUrl: canonical,
      purpose: "Render one crawler-selected JavaScript source for Qarinah ProofPack evidence extraction",
      actor: "qarinah-proofpack",
      policy: {
        allowedOrigins: [targetOrigin],
        allowedActions: ["snapshot"],
        allowedEffects: ["read"],
        allowJavaScript: true,
        allowCookieRead: false,
        allowCookieWrite: false,
        allowDownloads: false,
        allowUploads: false,
        allowClipboard: false,
        allowStateExport: false,
        allowAnnotations: false,
        allowPrivateNetwork: false,
        allowRemote: false,
        budget: {
          maxActions: 1,
          maxDurationMs: BROWSER_TIMEOUT_MS,
          maxTabs: 1,
          maxDownloadBytes: 1,
          maxUploadBytes: 1,
          maxSnapshotChars: 120_000,
          maxEvidenceBytes: 2 * 1024 * 1024,
          maxHistoryEntries: 5,
          maxNetworkEntries: 250,
          maxClipboardBytes: 1,
          maxSavedStates: 1,
          maxNetworkRules: 1,
          maxRouteFulfillBytes: 1,
          maxInterceptedBytes: 256 * 1024,
        },
      },
    }) as BrowserSessionResponse;
    if (!session || typeof session.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(session.id)) {
      throw new Error("Cockroach Browser returned an invalid session identifier.");
    }
    sessionId = session.id;
    const snapshot = await browserRequest(
      config,
      fetchImplementation,
      `/v1/sessions/${encodeURIComponent(sessionId)}/snapshot`,
      "POST",
      signal,
      {},
    ) as BrowserSnapshotResponse;
    if (!snapshot || typeof snapshot.url !== "string" || typeof snapshot.text !== "string") {
      throw new Error("Cockroach Browser returned an invalid page snapshot.");
    }
    const finalUrl = canonicalizeUrl(snapshot.url);
    if (!finalUrl || new URL(finalUrl).origin !== targetOrigin) {
      throw new Error("Cockroach Browser snapshot left the authorized target origin.");
    }
    const text = snapshot.text.replace(/\0/g, "").trim();
    if (text.length < 80) throw new Error("Cockroach Browser snapshot contained insufficient substantive text.");
    return {
      url: finalUrl,
      title: typeof snapshot.title === "string" ? snapshot.title.slice(0, 1_000) : "",
      capturedAt: isoTimestamp(snapshot.capturedAt) ?? new Date().toISOString(),
      text: text.slice(0, 120_000),
      digest: typeof snapshot.digest === "string" ? snapshot.digest : undefined,
      truncated: snapshot.truncated === true,
    };
  } finally {
    if (sessionId) {
      try {
        await browserRequest(
          config,
          fetchImplementation,
          `/v1/sessions/${encodeURIComponent(sessionId)}`,
          "DELETE",
          AbortSignal.timeout(3_000),
        );
      } catch {
        // Cleanup is best effort; the render outcome remains independently bounded.
      }
    }
  }
}

function createBrowserGateway(
  config: { baseUrl: string; origin: string; token: string },
  targets: readonly ValidatedSource[],
  fetchImplementation: typeof globalThis.fetch,
): ToolGateway {
  const allowedOrigins = [...new Set([config.origin, ...targets.map((target) => target.origin)])];
  const gateway = new ToolGateway({
    policyEngine: new PolicyEngine({
      allowedTools: [BROWSER_TOOL_NAME],
      allowedOrigins,
      maxToolCalls: targets.length,
    }),
  });
  const handler = (input: { url: string }, context: AgentExecutionContext) => (
    renderWithCockroachBrowser(input, context, config, fetchImplementation)
  );
  Object.defineProperty(handler, "governance", {
    value: Object.freeze({
      effects: Object.freeze(["network:read", "browser:render"]),
      networkOrigins: Object.freeze([config.origin]),
      risk: "medium",
    }),
    configurable: false,
    enumerable: false,
    writable: false,
  });
  gateway.registerTool(BROWSER_TOOL_NAME, handler);
  return gateway;
}

function acquiredRenderedPage(snapshot: BrowserSnapshotResponse, source: ValidatedSource): AcquiredPage {
  const canonical = canonicalizeUrl(snapshot.url) ?? source.url;
  return {
    url: canonical,
    canonical,
    title: snapshot.title.replace(/\s+/g, " ").trim(),
    description: source.result.snippet.slice(0, 4_000),
    language: null,
    text: snapshot.text,
    markdown: snapshot.text,
    retrievedAt: snapshot.capturedAt,
    publishedAt: source.result.publishedAt,
    contentHash: `sha256:${createHash("sha256").update(snapshot.text).digest("hex")}`,
    contentType: "text/plain; source=cockroach-browser-snapshot",
    bytes: Buffer.byteLength(snapshot.text, "utf8"),
    status: 200,
    robotsAllowed: null,
    sourceType: "rendered",
    searchRank: source.result.rank,
    searchProvider: source.result.provider,
  };
}

/** Crawl validated search results with strict static-first, rendered-last authority. */
export async function acquireSources(
  results: readonly SearchResult[],
  options: AcquireSourcesOptions = {},
): Promise<AcquisitionResult> {
  const startedAt = Date.now();
  const maxPages = positiveInteger(options.maxPages, 10, MAX_ACQUISITION_PAGES, "maxPages");
  const validated = validateSources(results, maxPages);
  const groups = groupedByOrigin(validated.sources);
  const crawled = await boundedMap(groups, 3, (group) => crawlGroup(group, options.signal));
  const crawlPages = crawled.flatMap((entry) => entry.pages);
  const failures = [...validated.failures, ...crawled.flatMap((entry) => entry.failures)];
  const pages = crawlPages.map((page) => acquiredCrawlerPage(page, sourceForPage(page, validated.sources)));
  const governanceTrace: Record<string, unknown>[] = [];

  const browserCandidates: Array<{ source: ValidatedSource; failure: AcquisitionFailure }> = [];
  const observedBrowserTargets = new Set<string>();
  for (const failure of failures) {
    if (!renderedFallbackEligible(failure)) continue;
    const canonical = canonicalizeUrl(failure.url);
    const source = canonical
      ? validated.sources.find((candidate) => candidate.url === canonical)
      : undefined;
    if (!source || observedBrowserTargets.has(source.url)) continue;
    observedBrowserTargets.add(source.url);
    browserCandidates.push({ source, failure });
    if (browserCandidates.length >= MAX_RENDERED_FALLBACKS) break;
  }

  // A configured sidecar is intentionally inert unless a bounded static crawl
  // has first produced a render-eligible JavaScript/challenge failure.
  const browserConfig = browserCandidates.length ? browserConfiguration() : null;
  if (browserConfig) {
    const fetchImplementation = options.fetch ?? globalThis.fetch;
    if (typeof fetchImplementation !== "function") throw new TypeError("A fetch implementation is required.");
    if (browserCandidates.length) {
      const gateway = createBrowserGateway(
        browserConfig,
        browserCandidates.map((candidate) => candidate.source),
        fetchImplementation,
      );
      for (let index = 0; index < browserCandidates.length; index += 1) {
        const { source, failure } = browserCandidates[index];
        failure.renderedFallbackAttempted = true;
        try {
          const snapshot = await gateway.call<BrowserSnapshotResponse, { url: string }>(
            BROWSER_TOOL_NAME,
            { url: source.url },
            {
              runId: `proofpack-render-${index + 1}`,
              signal: options.signal,
              goal: {
                objective: "Render one crawler-failed JavaScript source for evidence extraction",
                allowedTools: [BROWSER_TOOL_NAME],
                allowedOrigins: [browserConfig.origin, source.origin],
              },
            },
          );
          pages.push(acquiredRenderedPage(snapshot, source));
          failure.recovered = true;
        } catch (error) {
          if (options.signal?.aborted) throw options.signal.reason;
          failures.push({
            url: source.url,
            phase: "render",
            code: safeCode(error, "BROWSER_FALLBACK_FAILED"),
            error: safeMessage(error),
            source: "cockroach-browser",
            renderedFallbackAttempted: true,
            recovered: false,
          });
        }
      }
      governanceTrace.push(...gateway.trace.map((entry) => ({ ...entry })));
    }
  }

  const uniquePages: AcquiredPage[] = [];
  const pageIndex = new Map<string, number>();
  for (const page of pages) {
    const existing = pageIndex.get(page.canonical);
    if (existing === undefined) {
      pageIndex.set(page.canonical, uniquePages.length);
      uniquePages.push(page);
      continue;
    }
    if (page.text.length > uniquePages[existing].text.length) uniquePages[existing] = page;
  }
  uniquePages.sort((left, right) => left.searchRank - right.searchRank || left.canonical.localeCompare(right.canonical));

  const aggregate = crawled.reduce((stats, entry) => ({
    requests: stats.requests + entry.stats.requests,
    bytes: stats.bytes + entry.stats.bytes,
    skippedRobots: stats.skippedRobots + entry.stats.skippedRobots,
    durationMs: Math.max(stats.durationMs, entry.stats.durationMs),
  }), { requests: 0, bytes: 0, skippedRobots: 0, durationMs: 0 });

  return {
    pages: uniquePages.slice(0, maxPages),
    failures,
    stats: {
      requested: results.length,
      accepted: validated.sources.length,
      crawlerPages: uniquePages.filter((page) => page.sourceType === "crawler").length,
      renderedPages: uniquePages.filter((page) => page.sourceType === "rendered").length,
      crawlFailures: failures.filter((failure) => failure.source === "crawler").length,
      failures: failures.filter((failure) => !failure.recovered).length,
      requests: aggregate.requests,
      bytes: aggregate.bytes,
      skippedRobots: aggregate.skippedRobots,
      durationMs: Date.now() - startedAt,
    },
    governanceTrace,
  };
}
