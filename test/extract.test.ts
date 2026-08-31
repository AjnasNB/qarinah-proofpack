import { describe, expect, it } from "vitest";

import { type AcquiredPage } from "@/lib/proof/acquire";
import { extractEvidence } from "@/lib/proof/extract";

function page(overrides: Partial<AcquiredPage> = {}): AcquiredPage {
  return {
    url: "https://agency.gov/releases/product-y",
    canonical: "https://agency.gov/releases/product-y",
    title: "Company X announces Product Y release window",
    description: "Official Product Y release announcement.",
    language: "en",
    text: [
      "Company X announced that Product Y is scheduled to launch this month. The official release notice identifies the current launch window and says availability begins before month end.",
      "The company also published compatibility details and regional availability information for customers.",
    ].join("\n\n"),
    markdown: "Company X announced that Product Y is scheduled to launch this month.",
    retrievedAt: "2026-08-31T10:00:00.000Z",
    publishedAt: "2026-08-30T10:00:00.000Z",
    contentHash: `sha256:${"a".repeat(64)}`,
    contentType: "text/html",
    bytes: 2_048,
    status: 200,
    robotsAllowed: true,
    sourceType: "crawler",
    searchRank: 1,
    searchProvider: "web-search.exa-hosted-mcp",
    ...overrides,
  };
}

describe("extractEvidence", () => {
  it("selects deterministic, diverse, bounded passages with source quality and freshness", () => {
    const pages: AcquiredPage[] = [
      page(),
      page({
        url: "https://news.example/report/product-y",
        canonical: "https://news.example/report/product-y",
        title: "Product Y timing disputed",
        description: "An independent report describes conflicting timing.",
        text: "Two independent distributors said the Product Y launch may not happen this month. Their current schedules contradict Company X's earlier release window, although the company has not published a revised date.",
        markdown: "",
        publishedAt: "2026-02-01T10:00:00.000Z",
        contentHash: "untrusted-upstream-digest",
        searchRank: 2,
        searchProvider: "web-search.duckduckgo-html",
      }),
      page({
        url: "https://unrelated.example/weather",
        canonical: "https://unrelated.example/weather",
        title: "Regional weather report",
        description: "Weather observations.",
        text: "Rainfall totals exceeded the seasonal average across several coastal regions. Forecast models predict cooler temperatures during the coming week.",
        markdown: "",
        publishedAt: null,
        searchRank: 3,
      }),
    ];

    const first = extractEvidence("Did Company X announce Product Y will launch this month?", pages, {
      maxEvidence: 2,
    });
    const second = extractEvidence("Did Company X announce Product Y will launch this month?", pages, {
      maxEvidence: 2,
    });

    expect(first).toEqual(second);
    expect(first).toHaveLength(2);
    expect(new Set(first.map((candidate) => candidate.canonical)).size).toBe(2);
    expect(first.every((candidate) => candidate.excerpt.length <= 720)).toBe(true);
    expect(first.every((candidate) => candidate.relevance > 0 && candidate.relevance <= 1)).toBe(true);
    expect(first.every((candidate) => candidate.quality > 0 && candidate.quality <= 1)).toBe(true);
    expect(first.every((candidate) => candidate.freshness > 0 && candidate.freshness <= 1)).toBe(true);
    expect(first.find((candidate) => candidate.domain === "agency.gov")?.freshness).toBe(1);
    expect(first.find((candidate) => candidate.domain === "news.example")?.contentHash)
      .toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(first.some((candidate) => candidate.domain === "unrelated.example")).toBe(false);
  });

  it("canonicalizes and deduplicates sources, retaining the richer acquired page", () => {
    const thin = page({
      url: "https://agency.gov/releases/product-y?utm_source=search",
      canonical: "https://agency.gov/releases/product-y?utm_source=search",
      title: "Thin duplicate",
      text: "Company X Product Y launch this month is mentioned in a short duplicate report.",
      searchRank: 1,
    });
    const rich = page({
      title: "Richer canonical source",
      text: "Company X announced the Product Y launch this month in a detailed official source. The release announcement confirms the schedule and includes a specific availability window for the product.",
      searchRank: 2,
    });

    const evidence = extractEvidence("Company X Product Y launch this month", [thin, rich], {
      maxEvidence: 5,
    });

    expect(evidence.length).toBeGreaterThan(0);
    expect(new Set(evidence.map((candidate) => candidate.canonical))).toEqual(new Set([
      "https://agency.gov/releases/product-y",
    ]));
    expect(evidence.every((candidate) => candidate.title === "Richer canonical source")).toBe(true);
  });

  it("returns no evidence when passages do not overlap the research question", () => {
    const evidence = extractEvidence("orbital launch vehicle telemetry", [page({
      text: "This recipe combines flour, butter, sugar, and citrus zest. Bake the mixture until the edges become golden and let it cool before serving.",
    })]);

    expect(evidence).toEqual([]);
  });

  it("rejects invalid extraction budgets", () => {
    expect(() => extractEvidence("Product Y launch", [page()], { maxEvidence: 0 })).toThrow(/between 1 and 30/u);
    expect(() => extractEvidence("Product Y launch", [page()], { maxEvidence: 31 })).toThrow(/between 1 and 30/u);
  });
});
