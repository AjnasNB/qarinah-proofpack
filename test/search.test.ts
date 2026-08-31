import { describe, expect, it, vi } from "vitest";

import { decomposeQuery, discoverSources } from "@/lib/proof/search";

function duckDuckGoHtml(): string {
  const safe = encodeURIComponent("https://news.example.com/product?utm_source=ddg&edition=global");
  const duplicate = encodeURIComponent("https://news.example.com/product?edition=global&utm_medium=search");
  const local = encodeURIComponent("http://127.0.0.1:8080/admin");
  return `<!doctype html><html><body>
    <div class="result">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=${safe}">Independent launch report</a>
      <div class="result__snippet">Company X says Product Y is scheduled to launch this month.</div>
    </div>
    <div class="result">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=${duplicate}">Duplicate report</a>
      <div class="result__snippet">The same report with tracking parameters.</div>
    </div>
    <div class="result">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=${local}">Unsafe local target</a>
      <div class="result__snippet">This result must never become crawl authority.</div>
    </div>
  </body></html>`;
}

describe("decomposeQuery", () => {
  it("creates three deterministic, bounded retrieval angles", () => {
    const first = decomposeQuery("\u0000 Did Company X announce Product Y this month? ");
    const second = decomposeQuery("\u0000 Did Company X announce Product Y this month? ");

    expect(first).toEqual(second);
    expect(first).toHaveLength(3);
    expect(first[0]).toBe("Did Company X announce Product Y this month?");
    expect(first[1]).toContain("official source announcement");
    expect(first[2]).toContain("contradiction fact check");
    expect(first.every((query) => query.length <= 2_048)).toBe(true);
  });

  it("rejects empty and oversized queries", () => {
    expect(() => decomposeQuery(" \n ")).toThrow(/empty/u);
    expect(() => decomposeQuery("x".repeat(2_049))).toThrow(/2048/u);
  });
});

describe("discoverSources", () => {
  it("falls back from governed Exa to governed bounded DuckDuckGo and validates URLs", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.hostname === "mcp.exa.ai") {
        return new Response("temporarily unavailable", {
          status: 503,
          headers: { "content-type": "text/plain" },
        });
      }
      if (url.hostname === "html.duckduckgo.com") {
        return new Response(duckDuckGoHtml(), {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      throw new Error(`Unexpected test URL: ${url}`);
    });

    const discovery = await discoverSources("Did Company X announce Product Y this month?", {
      maxResults: 5,
      fetch: fetchMock,
    });

    expect(discovery.provider).toBe("web-search.duckduckgo-html");
    expect(discovery.results).toHaveLength(1);
    expect(discovery.results[0]).toMatchObject({
      canonical: "https://news.example.com/product?edition=global",
      provider: "web-search.duckduckgo-html",
      rank: 1,
    });
    expect(discovery.results.every((result) => !result.url.includes("127.0.0.1"))).toBe(true);
    expect(discovery.attempts.filter((attempt) => attempt.provider === "web-search.exa-hosted-mcp"))
      .toHaveLength(3);
    expect(discovery.attempts.filter((attempt) => attempt.provider === "web-search.duckduckgo-html"))
      .toHaveLength(3);
    expect(discovery.governanceTrace).toHaveLength(6);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("uses the hosted anonymous Exa MCP adapter when it is available", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      expect(url.hostname).toBe("mcp.exa.ai");
      if (init?.method === "DELETE") return new Response("", { status: 202 });

      const body = JSON.parse(String(init?.body)) as { id?: number; method: string };
      if (body.method === "initialize") {
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "fixture", version: "1" } },
        }), {
          status: 200,
          headers: { "content-type": "application/json", "mcp-session-id": "fixture-session" },
        });
      }
      if (body.method === "notifications/initialized") {
        return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
      }
      expect(body.method).toBe("tools/call");
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        result: {
          content: [{
            type: "text",
            text: [
              "Title: Official Product Y release",
              "URL: https://company.example/releases/product-y?utm_source=fixture",
              "",
              "Published: 2026-08-30T12:00:00Z",
              "Highlights: Company X scheduled Product Y for release this month.",
            ].join("\n"),
          }],
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const discovery = await discoverSources("Company X Product Y launch", {
      maxResults: 4,
      fetch: fetchMock,
    });

    expect(discovery.provider).toBe("web-search.exa-hosted-mcp");
    expect(discovery.results).toEqual([
      expect.objectContaining({
        canonical: "https://company.example/releases/product-y",
        publishedAt: "2026-08-30T12:00:00.000Z",
        provider: "web-search.exa-hosted-mcp",
      }),
    ]);
    expect(discovery.governanceTrace).toHaveLength(3);
    expect(fetchMock.mock.calls.every(([input]) => new URL(String(input)).hostname === "mcp.exa.ai")).toBe(true);
  });

  it("returns an auditable empty discovery when both anonymous providers are unavailable", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("upstream unavailable", {
      status: 503,
      headers: { "content-type": "text/plain" },
    }));

    const discovery = await discoverSources("A claim with no reachable search provider", {
      maxResults: 3,
      fetch: fetchMock,
    });

    expect(discovery.provider).toBe("none");
    expect(discovery.results).toEqual([]);
    expect(discovery.attempts).toHaveLength(6);
    expect(new Set(discovery.attempts.map((attempt) => attempt.provider))).toEqual(new Set([
      "web-search.exa-hosted-mcp",
      "web-search.duckduckgo-html",
    ]));
    expect(discovery.attempts.every((attempt) => attempt.status === "unavailable")).toBe(true);
    expect(discovery.governanceTrace).toHaveLength(6);
  });
});
