import { createHash } from "node:crypto";
import { isIP } from "node:net";

import { load } from "cheerio";
import {
  EXA_HOSTED_MCP_ENDPOINT,
  PolicyEngine,
  ResearchSourceRegistry,
  ResearchSourceUnavailableError,
  ToolGateway,
  createExaSearchSourceAdapter,
  defineResearchSourceAdapter,
  defineResearchToolCaller,
  type JsonObject,
  type ResearchDocument,
  type ResearchSourceAttempt,
  type ResearchSourceReadContext,
} from "maqam";

const DUCKDUCKGO_ENDPOINT = "https://html.duckduckgo.com/html/";
const SEARCH_CHANNEL = "web-search";
const DUCKDUCKGO_ADAPTER_ID = "web-search.duckduckgo-html";
const DUCKDUCKGO_TOOL_NAME = "research.web-search.duckduckgo-html";
const MAX_QUERY_CHARS = 2_048;
const MAX_SEARCH_RESULTS = 20;
const SEARCH_TIMEOUT_MS = 8_000;
const SEARCH_RESPONSE_BYTES = 1_500_000;

const TRACKING_PARAMETERS = new Set([
  "_ga",
  "_gl",
  "dclid",
  "fbclid",
  "gclid",
  "igshid",
  "mc_cid",
  "mc_eid",
  "msclkid",
  "ref_src",
  "s_cid",
  "vero_conv",
  "vero_id",
]);

export type SearchProvider =
  | "web-search.exa-hosted-mcp"
  | "web-search.duckduckgo-html"
  | "mixed"
  | "none";

export interface SearchResult {
  url: string;
  canonical: string;
  title: string;
  snippet: string;
  publishedAt: string | null;
  provider: Exclude<SearchProvider, "mixed" | "none">;
  rank: number;
}

export interface SearchAttempt {
  query: string;
  provider: string;
  status: "completed" | "unavailable" | "failed";
  resultCount: number;
  reason: string | null;
}

export interface SearchDiscovery {
  query: string;
  queries: string[];
  results: SearchResult[];
  attempts: SearchAttempt[];
  provider: SearchProvider;
  governanceTrace: Record<string, unknown>[];
}

export interface DiscoverSourcesOptions {
  maxResults?: number;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
}

function cleanQuery(value: string): string {
  if (typeof value !== "string") {
    throw new TypeError("Search query must be a string.");
  }
  const query = value.normalize("NFKC").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!query) throw new TypeError("Search query must not be empty.");
  if (query.length > MAX_QUERY_CHARS) {
    throw new TypeError(`Search query cannot exceed ${MAX_QUERY_CHARS} characters.`);
  }
  return query;
}

/**
 * Produce three bounded, deterministic retrieval angles without asking a model
 * to rewrite (and potentially change) the user's claim.
 */
export function decomposeQuery(query: string): string[] {
  const original = cleanQuery(query);
  const statement = original
    .replace(/[?!.]+$/u, "")
    .replace(/^(?:is|are|was|were|did|does|do|has|have|had|can|could|will|would)\s+/iu, "")
    .replace(/\s+(?:true|correct|accurate)$/iu, "")
    .trim() || original;

  const candidates = [
    original,
    `${statement} official source announcement`,
    `${statement} independent report contradiction fact check`,
  ];

  const unique: string[] = [];
  const observed = new Set<string>();
  for (const candidate of candidates) {
    const bounded = candidate.slice(0, MAX_QUERY_CHARS).trim();
    const key = bounded.toLocaleLowerCase("en-US");
    if (bounded && !observed.has(key)) {
      observed.add(key);
      unique.push(bounded);
    }
  }

  for (const suffix of ["primary source", "independent verification", "contrary evidence"]) {
    if (unique.length >= 3) break;
    unique.push(`${original.slice(0, MAX_QUERY_CHARS - suffix.length - 1)} ${suffix}`);
  }
  return unique.slice(0, 3);
}

function isNonPublicHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".lan") ||
    host.endsWith(".home")
  ) {
    return true;
  }

  const family = isIP(host);
  if (family === 4) {
    const octets = host.split(".").map(Number);
    const [a, b] = octets;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0) ||
      a >= 224
    );
  }
  if (family === 6) {
    return (
      host === "::" ||
      host === "::1" ||
      host.startsWith("::ffff:") ||
      host.startsWith("fc") ||
      host.startsWith("fd") ||
      /^fe[89ab]/u.test(host) ||
      host.startsWith("2001:db8:")
    );
  }
  return false;
}

/** Canonicalize a public HTTP(S) result URL before it can become crawl authority. */
export function canonicalizeUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    isNonPublicHostname(url.hostname)
  ) {
    return null;
  }

  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase().startsWith("utm_") || TRACKING_PARAMETERS.has(key.toLowerCase())) {
      url.searchParams.delete(key);
    }
  }
  url.searchParams.sort();
  return url.toString();
}

function duckDuckGoResultUrl(value: string): string | null {
  let href = value.trim();
  if (href.startsWith("//")) href = `https:${href}`;
  if (href.startsWith("/")) href = new URL(href, DUCKDUCKGO_ENDPOINT).toString();
  try {
    const parsed = new URL(href);
    if (parsed.hostname.endsWith("duckduckgo.com") && parsed.pathname.startsWith("/l/")) {
      const destination = parsed.searchParams.get("uddg");
      if (!destination) return null;
      href = destination;
    }
  } catch {
    return null;
  }
  return canonicalizeUrl(href);
}

function positiveInteger(value: number | undefined, fallback: number, maximum: number, label: string): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > maximum) {
    throw new TypeError(`${label} must be an integer between 1 and ${maximum}.`);
  }
  return candidate;
}

function linkedSignal(parent: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

async function boundedResponseText(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new ResearchSourceUnavailableError("DuckDuckGo response exceeded the configured byte limit.");
  }
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new ResearchSourceUnavailableError("DuckDuckGo response exceeded the configured byte limit.");
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new ResearchSourceUnavailableError("DuckDuckGo response exceeded the configured byte limit.");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), size).toString("utf8");
}

function createDuckDuckGoAdapter(fetchImplementation: typeof globalThis.fetch) {
  const read = async (input: Readonly<JsonObject>, context: ResearchSourceReadContext) => {
    const query = cleanQuery(input.query as string);
    const numResults = positiveInteger(
      typeof input.numResults === "number" ? input.numResults : undefined,
      10,
      MAX_SEARCH_RESULTS,
      "DuckDuckGo numResults",
    );
    const endpoint = new URL(DUCKDUCKGO_ENDPOINT);
    endpoint.searchParams.set("q", query);
    const contextSignal = "signal" in context ? context.signal : undefined;
    let response: Response;
    try {
      response = await fetchImplementation(endpoint, {
        method: "GET",
        redirect: "error",
        signal: linkedSignal(contextSignal, SEARCH_TIMEOUT_MS),
        headers: {
          accept: "text/html,application/xhtml+xml",
          "user-agent": "QarinahProofPack/0.1 (+https://github.com/AjnasNB/qarinah-proofpack)",
        },
      });
    } catch (cause) {
      if (contextSignal?.aborted) throw contextSignal.reason;
      throw new ResearchSourceUnavailableError("DuckDuckGo HTML search could not be reached.", { cause });
    }
    if (response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500) {
      await response.body?.cancel();
      throw new ResearchSourceUnavailableError(`DuckDuckGo HTML search is unavailable (HTTP ${response.status}).`);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ResearchSourceUnavailableError(`DuckDuckGo HTML search rejected the request (HTTP ${response.status}).`);
    }

    const html = await boundedResponseText(response, SEARCH_RESPONSE_BYTES);
    if (/unusual traffic|automated quer|captcha|anomaly-modal/iu.test(html)) {
      throw new ResearchSourceUnavailableError("DuckDuckGo HTML search presented an automation challenge.");
    }

    const $ = load(html);
    const documents: Array<{
      id: string;
      uri: string;
      title: string;
      text: string;
      contentType: string;
      metadata: JsonObject;
      citations: Array<{ uri: string; title: string }>;
    }> = [];
    const observed = new Set<string>();
    $(".result").each((_index, element) => {
      if (documents.length >= numResults) return false;
      const link = $(element).find("a.result__a").first();
      const url = duckDuckGoResultUrl(link.attr("href") ?? "");
      if (!url || observed.has(url)) return;
      const title = link.text().replace(/\s+/g, " ").trim().slice(0, 1_000);
      const snippet = $(element)
        .find(".result__snippet")
        .first()
        .text()
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 8_000);
      if (!title && !snippet) return;
      observed.add(url);
      documents.push({
        id: url,
        uri: url,
        title: title || new URL(url).hostname,
        text: snippet || title,
        contentType: "text/plain",
        metadata: {
          provider: "duckduckgo-html",
          query,
          rank: documents.length + 1,
          accessMode: "anonymous-public",
          contentIsUntrusted: true,
        },
        citations: [{ uri: url, title: title || new URL(url).hostname }],
      });
    });

    if (!documents.length) {
      throw new ResearchSourceUnavailableError("DuckDuckGo HTML search returned no parseable public result URLs.");
    }
    return documents;
  };

  Object.defineProperty(read, "governance", {
    value: Object.freeze({
      effects: Object.freeze(["network:read"]),
      networkOrigins: Object.freeze([new URL(DUCKDUCKGO_ENDPOINT).origin]),
      risk: "low",
    }),
    configurable: false,
    enumerable: false,
    writable: false,
  });

  return defineResearchSourceAdapter({
    id: DUCKDUCKGO_ADAPTER_ID,
    channel: SEARCH_CHANNEL,
    toolName: DUCKDUCKGO_TOOL_NAME,
    label: "Bounded anonymous DuckDuckGo HTML discovery",
    priority: 200,
    authentication: "none",
    capabilities: ["read", "search", "web", "html"],
    metadata: {
      provider: "duckduckgo",
      accessMode: "anonymous-public",
      endpointOrigin: new URL(DUCKDUCKGO_ENDPOINT).origin,
      contentIsUntrusted: true,
    },
    read,
  });
}

function safeReason(value: unknown): string {
  return (value instanceof Error ? value.message : String(value)).replace(/[\r\n]+/g, " ").slice(0, 500);
}

function attemptFromMaqam(query: string, attempt: ResearchSourceAttempt, resultCount: number): SearchAttempt {
  const reason = attempt.classification?.error.message ?? null;
  return {
    query,
    provider: attempt.adapterId,
    status: attempt.status === "completed" ? "completed" : "unavailable",
    resultCount: attempt.status === "completed" ? resultCount : 0,
    reason,
  };
}

function attemptsFromUnavailableError(query: string, error: ResearchSourceUnavailableError): SearchAttempt[] {
  const rawAttempts = Array.isArray(error.details?.attempts) ? error.details.attempts : [];
  const attempts: SearchAttempt[] = [];
  for (const raw of rawAttempts) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    if (typeof record.adapterId !== "string") continue;
    const classification = record.classification;
    const errorRecord = classification && typeof classification === "object" && !Array.isArray(classification)
      ? (classification as Record<string, unknown>).error
      : null;
    const reason = errorRecord && typeof errorRecord === "object" && !Array.isArray(errorRecord)
      && typeof (errorRecord as Record<string, unknown>).message === "string"
      ? String((errorRecord as Record<string, unknown>).message).slice(0, 500)
      : null;
    attempts.push({
      query,
      provider: record.adapterId,
      status: "unavailable",
      resultCount: 0,
      reason,
    });
  }
  return attempts;
}

function resultFromDocument(
  document: ResearchDocument,
  provider: Exclude<SearchProvider, "mixed" | "none">,
  rank: number,
): SearchResult | null {
  const canonical = canonicalizeUrl(document.uri);
  if (!canonical) return null;
  return {
    url: canonical,
    canonical,
    title: (document.title ?? new URL(canonical).hostname).replace(/\s+/g, " ").trim().slice(0, 1_000),
    snippet: document.text.replace(/\s+/g, " ").trim().slice(0, 8_000),
    publishedAt: document.publishedAt,
    provider,
    rank,
  };
}

/** Discover validated public URLs through a Maqam-governed provider registry. */
export async function discoverSources(
  query: string,
  options: DiscoverSourcesOptions = {},
): Promise<SearchDiscovery> {
  const normalizedQuery = cleanQuery(query);
  const maxResults = positiveInteger(options.maxResults, 10, MAX_SEARCH_RESULTS, "maxResults");
  const queries = decomposeQuery(normalizedQuery);
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== "function") throw new TypeError("A fetch implementation is required.");

  const exa = createExaSearchSourceAdapter({
    endpoint: EXA_HOSTED_MCP_ENDPOINT,
    fetch: fetchImplementation,
    timeoutMs: SEARCH_TIMEOUT_MS,
    maxResponseBytes: SEARCH_RESPONSE_BYTES,
    maxResults,
  });
  const duckDuckGo = createDuckDuckGoAdapter(fetchImplementation);
  const allowedOrigins = [
    new URL(EXA_HOSTED_MCP_ENDPOINT).origin,
    new URL(DUCKDUCKGO_ENDPOINT).origin,
  ];
  const allowedTools = [exa.toolName, duckDuckGo.toolName];
  const gateway = new ToolGateway({
    policyEngine: new PolicyEngine({
      allowedTools,
      allowedOrigins,
      maxToolCalls: queries.length * 2,
    }),
  });
  if (!exa.read || !duckDuckGo.read) throw new Error("Search adapters must expose read handlers.");
  gateway.registerTool(exa.toolName, exa.read);
  gateway.registerTool(duckDuckGo.toolName, duckDuckGo.read);
  const sources = new ResearchSourceRegistry({
    adapters: [exa, duckDuckGo],
    preferences: { [SEARCH_CHANNEL]: [exa.id, duckDuckGo.id] },
    toolCaller: defineResearchToolCaller({ call: gateway.call.bind(gateway) }),
  });

  const discovered: SearchResult[] = [];
  const attempts: SearchAttempt[] = [];
  const providers = new Set<Exclude<SearchProvider, "mixed" | "none">>();
  const runPrefix = createHash("sha256").update(normalizedQuery).digest("hex").slice(0, 12);

  for (let index = 0; index < queries.length; index += 1) {
    const retrievalQuery = queries[index];
    try {
      const routed = await sources.route({
        channel: SEARCH_CHANNEL,
        input: { query: retrievalQuery, numResults: maxResults },
      }, {
        runId: `proofpack-search-${runPrefix}-${index + 1}`,
        signal: options.signal,
        goal: {
          objective: "Discover public evidence URLs for one ProofPack request",
          allowedTools,
          allowedOrigins,
        },
      });
      const provider = routed.adapter.id as Exclude<SearchProvider, "mixed" | "none">;
      providers.add(provider);
      const before = discovered.length;
      for (const document of routed.documents) {
        const result = resultFromDocument(document, provider, discovered.length + 1);
        if (result) discovered.push(result);
      }
      const added = discovered.length - before;
      attempts.push(...routed.attempts.map((attempt) => attemptFromMaqam(retrievalQuery, attempt, added)));
    } catch (error) {
      if (!(error instanceof ResearchSourceUnavailableError)) throw error;
      const providerAttempts = attemptsFromUnavailableError(retrievalQuery, error);
      attempts.push(...(providerAttempts.length ? providerAttempts : [{
        query: retrievalQuery,
        provider: "web-search.registry",
        status: "unavailable" as const,
        resultCount: 0,
        reason: safeReason(error),
      }]));
    }
  }

  const uniqueResults: SearchResult[] = [];
  const observed = new Set<string>();
  for (const result of discovered) {
    if (observed.has(result.canonical)) continue;
    observed.add(result.canonical);
    uniqueResults.push({ ...result, rank: uniqueResults.length + 1 });
    if (uniqueResults.length >= maxResults) break;
  }

  const provider: SearchProvider = providers.size === 0
    ? "none"
    : providers.size === 1
      ? [...providers][0]
      : "mixed";

  return {
    query: normalizedQuery,
    queries,
    results: uniqueResults,
    attempts,
    provider,
    governanceTrace: gateway.trace.map((entry) => ({ ...entry })),
  };
}
