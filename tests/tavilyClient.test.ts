import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearTavilyUsageCache,
  getTavilyUsage,
  parseTavilySearch,
  searchTavily,
} from "../src/main/tavilyClient";
import { parseTavilyUsage } from "../src/main/tavilyUsage";

beforeEach(() => clearTavilyUsageCache());

describe("Tavily client", () => {
  it("parses the authoritative key and account usage without assuming a fixed limit", () => {
    expect(
      parseTavilyUsage({
        key: { usage: 87, limit: 1250, search_usage: 70 },
        account: {
          current_plan: "Researcher",
          plan_usage: 91,
          plan_limit: 1250,
          paygo_usage: 0,
          paygo_limit: 200,
        },
      }),
    ).toMatchObject({
      key: { used: 87, limit: 1250, remaining: 1163, searchUsed: 70 },
      account: {
        plan: "Researcher",
        used: 91,
        limit: 1250,
        remaining: 1159,
        paygoUsed: 0,
        paygoLimit: 200,
      },
    });
  });

  it("accepts camelCase, numeric strings, and authoritative remaining values", () => {
    expect(
      parseTavilyUsage({
        key: {
          used: "87",
          limit: "1250",
          remaining: "1163",
          searchUsage: "70",
        },
        account: {
          currentPlan: "Researcher",
          planUsage: "91",
          planLimit: "1250",
          remainingCredits: "1159",
          paygoUsage: "0",
          paygoLimit: "200",
        },
      }),
    ).toMatchObject({
      key: { used: 87, limit: 1250, remaining: 1163, searchUsed: 70 },
      account: {
        plan: "Researcher",
        used: 91,
        limit: 1250,
        remaining: 1159,
        paygoUsed: 0,
        paygoLimit: 200,
      },
    });
  });

  it("accepts nested usage payloads and a missing account block", () => {
    expect(
      parseTavilyUsage({
        usage: {
          key: { usage: 25, limit: 100, search_usage: 20 },
        },
      }),
    ).toMatchObject({
      key: { used: 25, limit: 100, remaining: 75, searchUsed: 20 },
      account: null,
    });
  });

  it("accepts flat usage and derives a missing limit", () => {
    expect(
      parseTavilyUsage({ used: 12, remaining: 88, searchUsed: 9 }),
    ).toMatchObject({
      key: { used: 12, limit: 100, remaining: 88, searchUsed: 9 },
      account: null,
    });
  });

  it("caches usage for sixty seconds and immediately deducts actual search credits", async () => {
    const usageFetch = vi.fn(async () =>
      jsonResponse({
        key: { usage: 10, limit: 100, search_usage: 8 },
        account: {
          current_plan: "Free",
          plan_usage: 10,
          plan_limit: 100,
          paygo_usage: 0,
          paygo_limit: 0,
        },
      }),
    );
    const first = await getTavilyUsage("tvly-test", {
      fetchImpl: usageFetch as typeof fetch,
    });
    const second = await getTavilyUsage("tvly-test", {
      fetchImpl: usageFetch as typeof fetch,
    });
    expect(second).toBe(first);
    expect(usageFetch).toHaveBeenCalledTimes(1);

    await searchTavily("tvly-test", "example manga official", {
      fetchImpl: vi.fn(async () =>
        jsonResponse({
          query: "example manga official",
          results: [
            {
              title: "Official",
              url: "https://example.com/work",
              content: "official character information",
              score: 0.9,
            },
          ],
          usage: { credits: 1 },
        }),
      ) as typeof fetch,
    });
    const updated = await getTavilyUsage("tvly-test", {
      fetchImpl: usageFetch as typeof fetch,
    });
    expect(updated.account?.remaining).toBe(89);
    expect(updated.key?.searchUsed).toBe(9);
  });

  it("keeps observed search credits when the usage endpoint is temporarily stale", async () => {
    const usageFetch = vi.fn(async () =>
      jsonResponse({
        key: { usage: 10, limit: 100, search_usage: 8 },
        account: {
          current_plan: "Free",
          plan_usage: 10,
          plan_limit: 100,
          paygo_usage: 0,
          paygo_limit: 0,
        },
      }),
    );
    await getTavilyUsage("tvly-test", {
      fetchImpl: usageFetch as typeof fetch,
    });
    await searchTavily("tvly-test", "example manga official", {
      fetchImpl: vi.fn(async () =>
        jsonResponse({
          query: "example manga official",
          results: [],
          usage: { credits: 1 },
        }),
      ) as typeof fetch,
    });

    const forced = await getTavilyUsage("tvly-test", {
      force: true,
      fetchImpl: usageFetch as typeof fetch,
    });

    expect(forced.key).toMatchObject({
      used: 11,
      remaining: 89,
      searchUsed: 9,
    });
    expect(forced.account).toMatchObject({ used: 11, remaining: 89 });
    expect(usageFetch).toHaveBeenCalledTimes(2);
  });

  it("uses only basic search with bounded results and retries 429", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response('{"detail":{"error":"slow down"}}', {
          status: 429,
          headers: { "retry-after": "0" },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          query: "work terms",
          results: [],
          usage: { credits: 1 },
        }),
      );
    await expect(
      searchTavily("tvly-test", "work terms", { fetchImpl }),
    ).resolves.toMatchObject({ credits: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const init = fetchImpl.mock.calls[0][1];
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      search_depth: "basic",
      auto_parameters: false,
      max_results: 5,
      include_raw_content: false,
      include_usage: true,
    });
    expect(body).not.toHaveProperty("exact_match");
  });

  it("can require an exact quoted-title match without changing search depth", async () => {
    const fetchImpl = vi.fn(
      async (
        _input: Parameters<typeof fetch>[0],
        _init?: Parameters<typeof fetch>[1],
      ) => jsonResponse({ query: "work", results: [], usage: { credits: 1 } }),
    );
    await searchTavily("tvly-test", '"正式な作品名" 登場人物', {
      exactMatch: true,
      fetchImpl: fetchImpl as typeof fetch,
    });
    const body = JSON.parse(
      String(fetchImpl.mock.calls[0]?.[1]?.body),
    ) as Record<string, unknown>;
    expect(body).toMatchObject({
      search_depth: "basic",
      auto_parameters: false,
      exact_match: true,
    });
  });

  it("does not retry exhausted plan-credit responses and keeps the safe API detail", async () => {
    const fetchImpl = vi.fn(
      async () => new Response('{"detail":{"error":"quota"}}', { status: 432 }),
    );
    await expect(
      searchTavily("tvly-test", "work terms", {
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).rejects.toThrow("플랜 크레딧 한도에 도달했습니다. quota");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("labels exhausted PAYGO credits separately", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('{"detail":"PAYGO credit limit reached"}', {
          status: 433,
        }),
    );
    await expect(
      searchTavily("tvly-test", "work terms", {
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).rejects.toThrow(
      "PAYGO 크레딧 한도에 도달했습니다. PAYGO credit limit reached",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("drops non-HTTPS and low-score search results", () => {
    expect(
      parseTavilySearch({
        query: "q",
        usage: { credits: 1 },
        results: [
          { title: "Low", url: "https://low.test", content: "x", score: 0.2 },
          {
            title: "HTTP",
            url: "http://unsafe.test",
            content: "x",
            score: 0.9,
          },
          { title: "Good", url: "https://good.test", content: "x", score: 0.9 },
        ],
      }).results,
    ).toEqual([
      {
        title: "Good",
        url: "https://good.test/",
        content: "x",
        score: 0.9,
      },
    ]);
  });

  it("validates keys, query bounds, fallback queries, and malformed search items", async () => {
    await expect(searchTavily(undefined, "work terms")).rejects.toThrow(
      "API 키",
    );
    await expect(searchTavily("tvly-test", "   ")).rejects.toThrow("1~400자");
    await expect(searchTavily("tvly-test", "x".repeat(401))).rejects.toThrow(
      "1~400자",
    );

    const parsed = parseTavilySearch(
      {
        results: [
          null,
          {
            title: "",
            url: "https://empty-title.test",
            content: "x",
            score: 1,
          },
          { title: "Bad URL", url: "not a url", content: "x", score: 1 },
          {
            title: "No content",
            url: "https://empty.test",
            content: "",
            score: 1,
          },
          {
            title: "String score",
            url: "https://valid.test",
            content: "evidence",
            score: "0.9",
          },
        ],
        usage: { credits: "1" },
      },
      "fallback query",
    );
    expect(parsed).toMatchObject({
      query: "fallback query",
      credits: 1,
      results: [{ title: "String score", score: 0.9 }],
    });
    expect(() => parseTavilySearch({ results: [], usage: {} })).toThrow(
      "응답 형식",
    );
  });

  it("maps invalid-key and generic Tavily HTTP failures without retrying", async () => {
    const invalidKeyFetch = vi.fn(
      async () => new Response('{"error":"denied"}', { status: 401 }),
    );
    await expect(
      getTavilyUsage("tvly-test", {
        force: true,
        fetchImpl: invalidKeyFetch as typeof fetch,
      }),
    ).rejects.toThrow("API 키가 올바르지");
    expect(invalidKeyFetch).toHaveBeenCalledOnce();

    const genericFetch = vi.fn(
      async () =>
        new Response('{"detail":"temporary failure"}', { status: 418 }),
    );
    await expect(
      getTavilyUsage("tvly-test", {
        force: true,
        fetchImpl: genericFetch as typeof fetch,
      }),
    ).rejects.toThrow("(418) temporary failure");
    expect(genericFetch).toHaveBeenCalledOnce();
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
