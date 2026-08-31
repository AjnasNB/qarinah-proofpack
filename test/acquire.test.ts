import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cockroach-crawler", () => ({
  crawlDetailed: vi.fn(),
}));

import {
  crawlDetailed,
  type CrawlDetailedResult,
  type CrawlPage,
} from "cockroach-crawler";

import { acquireSources } from "@/lib/proof/acquire";
import { type SearchResult } from "@/lib/proof/search";

const crawlMock = vi.mocked(crawlDetailed);
const priorEndpoint = process.env.COCKROACH_BROWSER_ENDPOINT;
const priorToken = process.env.COCKROACH_BROWSER_TOKEN;

function searchResult(url: string, rank = 1): SearchResult {
  return {
    url,
    canonical: url,
    title: `Source ${rank}`,
    snippet: "A search result snippet with context about the Product Y release.",
    publishedAt: "2026-08-30T00:00:00.000Z",
    provider: "web-search.duckduckgo-html",
    rank,
  };
}

function crawlPage(url: string): CrawlPage {
  return {
    url,
    canonical: url,
    title: "Product Y launch details",
    description: "Company X release information.",
    h1: "Product Y",
    language: "en",
    text: "Company X announced that Product Y is scheduled for release this month. The launch date appears in the official release notes.",
    markdown: "Company X announced that Product Y is scheduled for release this month.",
    links: [],
    fetchedAt: "2026-08-31T10:00:00.000Z",
    status: 200,
    contentType: "text/html",
    bytes: 1_024,
    contentHash: `sha256:${"a".repeat(64)}`,
    depth: 0,
    discoveredFrom: null,
    redirectChain: [],
    etag: null,
    lastModified: "2026-08-30T00:00:00.000Z",
    robotsAllowed: true,
  };
}

function crawlResult(
  pages: CrawlPage[],
  failures: CrawlDetailedResult["failures"] = [],
): CrawlDetailedResult {
  return {
    pages,
    failures,
    stats: {
      fetched: pages.length,
      requests: pages.length + failures.length + 1,
      bytes: pages.reduce((sum, page) => sum + (page.bytes ?? 0), 0),
      retries: 0,
      skippedRobots: failures.filter((failure) => failure.code === "ROBOTS_DENIED").length,
      skippedFiltered: 0,
      skippedNonPublic: 0,
      skippedOrigin: 0,
      queueDropped: 0,
      errors: failures.length,
      pages: pages.length,
      failures: failures.length,
      queued: pages.length + failures.length,
      seen: pages.length + failures.length,
      durationMs: 20,
      startedAt: "2026-08-31T10:00:00.000Z",
      finishedAt: "2026-08-31T10:00:00.020Z",
      traversal: "bfs",
    },
  };
}

beforeEach(() => {
  crawlMock.mockReset();
  delete process.env.COCKROACH_BROWSER_ENDPOINT;
  delete process.env.COCKROACH_BROWSER_TOKEN;
});

afterEach(() => {
  if (priorEndpoint === undefined) delete process.env.COCKROACH_BROWSER_ENDPOINT;
  else process.env.COCKROACH_BROWSER_ENDPOINT = priorEndpoint;
  if (priorToken === undefined) delete process.env.COCKROACH_BROWSER_TOKEN;
  else process.env.COCKROACH_BROWSER_TOKEN = priorToken;
});

describe("acquireSources", () => {
  it("derives exact origin authority from validated results and applies strict depth-zero budgets", async () => {
    const firstUrl = "https://evidence.example/official?utm_source=search";
    const secondUrl = "https://evidence.example/independent";
    crawlMock.mockResolvedValue(crawlResult(
      [crawlPage("https://evidence.example/official")],
      [{ url: secondUrl, phase: "page", code: "CRAWL_ERROR", error: "HTTP 404" }],
    ));

    const result = await acquireSources([
      searchResult(firstUrl, 1),
      searchResult(secondUrl, 2),
      searchResult("http://127.0.0.1:8080/private", 3),
    ], { maxPages: 5 });

    expect(crawlMock).toHaveBeenCalledTimes(1);
    expect(crawlMock).toHaveBeenCalledWith(expect.objectContaining({
      seeds: ["https://evidence.example/official", secondUrl],
      allowedOrigins: ["https://evidence.example"],
      maxDepth: 0,
      maxPages: 2,
      maxSeeds: 2,
      sameOrigin: true,
      includeSitemaps: false,
      obeyRobots: true,
      allowPrivateNetworks: false,
      skipSensitivePaths: true,
      maxRetries: 0,
    }));
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]).toMatchObject({
      canonical: "https://evidence.example/official",
      sourceType: "crawler",
      robotsAllowed: true,
    });
    expect(result.failures.map((failure) => failure.code)).toEqual(expect.arrayContaining([
      "INVALID_SEARCH_RESULT_URL",
      "CRAWL_ERROR",
    ]));
    expect(result.stats).toMatchObject({ requested: 3, accepted: 2, crawlerPages: 1, renderedPages: 0 });
  });

  it("uses the separately governed Cockroach Browser daemon only for a JS/challenge crawl failure", async () => {
    const target = "https://dynamic.example/release";
    process.env.COCKROACH_BROWSER_ENDPOINT = "http://127.0.0.1:43110";
    process.env.COCKROACH_BROWSER_TOKEN = "test-browser-token";
    crawlMock.mockResolvedValue(crawlResult([], [
      { url: target, phase: "page", code: "CRAWL_ERROR", error: "HTTP 403 challenge requires JavaScript" },
    ]));

    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      expect(init?.headers).toEqual(expect.objectContaining({
        authorization: "Bearer test-browser-token",
      }));
      if (url.pathname === "/v1/sessions" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as {
          startUrl: string;
          policy: { allowedOrigins: string[]; allowJavaScript: boolean; allowPrivateNetwork: boolean };
        };
        expect(body).toMatchObject({
          startUrl: target,
          policy: {
            allowedOrigins: ["https://dynamic.example"],
            allowJavaScript: true,
            allowPrivateNetwork: false,
          },
        });
        return Response.json({ id: "session-proofpack-1" }, { status: 201 });
      }
      if (url.pathname === "/v1/sessions/session-proofpack-1/snapshot" && init?.method === "POST") {
        return Response.json({
          sessionId: "session-proofpack-1",
          tabId: "tab-1",
          url: target,
          title: "Rendered Product Y release",
          capturedAt: "2026-08-31T11:00:00.000Z",
          text: "Company X announced that Product Y is scheduled for release this month. This rendered page contains the complete official announcement and a specific release window.",
          refs: [],
          digest: "fixture-digest",
          truncated: false,
        });
      }
      if (url.pathname === "/v1/sessions/session-proofpack-1" && init?.method === "DELETE") {
        return Response.json({ closed: "session-proofpack-1" });
      }
      throw new Error(`Unexpected browser fixture request: ${init?.method} ${url.pathname}`);
    });

    const result = await acquireSources([searchResult(target)], { fetch: fetchMock });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.pages).toEqual([
      expect.objectContaining({
        canonical: target,
        sourceType: "rendered",
        contentType: "text/plain; source=cockroach-browser-snapshot",
      }),
    ]);
    expect(result.failures[0]).toMatchObject({
      renderedFallbackAttempted: true,
      recovered: true,
    });
    expect(result.stats).toMatchObject({ crawlerPages: 0, renderedPages: 1, failures: 0 });
    expect(result.governanceTrace).toHaveLength(1);
    expect(result.governanceTrace[0]).toMatchObject({
      toolName: "research.render.cockroach-browser",
      status: "completed",
    });
  });

  it("never upgrades robots or security denials into browser authority", async () => {
    const target = "https://blocked.example/private";
    process.env.COCKROACH_BROWSER_ENDPOINT = "http://127.0.0.1:43110";
    process.env.COCKROACH_BROWSER_TOKEN = "test-browser-token";
    crawlMock.mockResolvedValue(crawlResult([], [
      { url: target, phase: "page", code: "ROBOTS_DENIED", error: "robots.txt disallows this URL" },
    ]));
    const fetchMock = vi.fn<typeof fetch>();

    const result = await acquireSources([searchResult(target)], { fetch: fetchMock });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.pages).toHaveLength(0);
    expect(result.failures[0]).toMatchObject({
      code: "ROBOTS_DENIED",
      renderedFallbackAttempted: false,
      recovered: false,
    });
    expect(result.governanceTrace).toHaveLength(0);
  });
});
