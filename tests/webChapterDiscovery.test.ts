/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import {
  discoverChapterLinks,
  WEB_CHAPTER_LINKS_SCRIPT,
} from "../src/main/webChapterDiscovery";
import { WebChapterDiscoveryRequestSchema } from "../src/shared/webChapterDiscovery";

const page = new URL("https://chapters.example/book");
const frame = () => ({
  frames: [],
  isDestroyed: () => false,
  executeJavaScript: vi.fn(
    async (script: string) => window.eval(script) as unknown,
  ),
});
afterEach(() => {
  document.head.replaceChildren();
  document.body.replaceChildren();
});

it("collects actual anchor text in DOM order, deduplicates fragments and keeps distinct query chapters", async () => {
  document.head.innerHTML =
    '<base href="https://chapters.example/"><title>Book title</title>';
  document.body.innerHTML = `
    <a href="/chapter/10">Chapter 10</a><a href="/chapter/2">Chapter 2</a>
    <a href="/chapter/2#top">duplicate</a><a href="/chapter?id=1">First query</a>
    <a href="/chapter?id=2">Second query</a><a href="/book#toc">self</a>
    <a href="https://elsewhere.example/chapter/1">other host</a>
    <a href="http://chapters.example/chapter/1">other protocol</a>
    <a href="https://user:password@chapters.example/chapter/1">credentials</a>
    <a href="javascript:alert(1)">script</a><a href="file:///private">file</a>
    <a href="/chapter/3">&lt;script&gt;not instructions&lt;/script&gt;</a>`;
  const browser = frame();
  const result = await discoverChapterLinks(browser, page, { maxLinks: 100 });
  expect(result.links.map((link) => link.url)).toEqual([
    "https://chapters.example/chapter/10",
    "https://chapters.example/chapter/2",
    "https://chapters.example/chapter?id=1",
    "https://chapters.example/chapter?id=2",
    "https://chapters.example/chapter/3",
  ]);
  expect(result).toMatchObject({
    pageTitle: "Book title",
    examined: 12,
    exhaustive: false,
    truncated: false,
    skipped: { invalid: 3, offOrigin: 2, duplicate: 2, filtered: 0 },
  });
  expect(result.links.at(-1)?.label).toBe("<script>not instructions</script>");
  expect(browser.executeJavaScript).toHaveBeenCalledExactlyOnceWith(
    WEB_CHAPTER_LINKS_SCRIPT,
  );
});

it("filters an explicit path prefix before applying the candidate bound and reports truncation", async () => {
  document.body.innerHTML = [
    "/navigation",
    "/chapter/1",
    "/chapter/2",
    "/chapter/3",
  ]
    .map((path) => `<a href="https://chapters.example${path}">${path}</a>`)
    .join("");
  const result = await discoverChapterLinks(frame(), page, {
    maxLinks: 2,
    pathPrefix: "/chapter/",
  });
  expect(result.links.map((link) => link.url)).toEqual([
    "https://chapters.example/chapter/1",
    "https://chapters.example/chapter/2",
  ]);
  expect(result).toMatchObject({
    examined: 4,
    truncated: true,
    skipped: { filtered: 1 },
  });
});

it("bounds DOM traversal and link payloads without silently claiming full discovery", async () => {
  document.body.innerHTML = Array.from(
    { length: 5001 },
    (_, index) =>
      `<a href="https://chapters.example/chapter/${index}">Chapter ${index}</a>`,
  ).join("");
  const result = await discoverChapterLinks(frame(), page, { maxLinks: 200 });
  expect(result).toMatchObject({
    examined: 5000,
    truncated: true,
    exhaustive: false,
  });
  expect(result.links).toHaveLength(200);
  document.body.innerHTML = "<div></div>".repeat(20001);
  expect(
    await discoverChapterLinks(frame(), page, { maxLinks: 200 }),
  ).toMatchObject({ links: [], truncated: true });
});

it("does not treat an empty page, iframe or shadow tree as an exhaustive chapter list", async () => {
  document.body.innerHTML = '<iframe></iframe><div id="shadow"></div>';
  document
    .getElementById("shadow")
    ?.attachShadow({ mode: "open" })
    .appendChild(document.createElement("a"));
  expect(
    await discoverChapterLinks(frame(), page, { maxLinks: 100 }),
  ).toMatchObject({ links: [], examined: 0, exhaustive: false });
});

it.each([
  null,
  [],
  { title: "bad", links: "not-array", truncated: false },
  {
    title: "bad",
    links: [
      { href: "https://chapters.example/chapter", label: "a", position: -1 },
    ],
    truncated: false,
  },
  { title: "bad", links: [], truncated: false, execute: "payload" },
])("rejects malformed browser payload %j", async (payload) => {
  const browser = frame();
  browser.executeJavaScript.mockResolvedValueOnce(payload);
  await expect(
    discoverChapterLinks(browser, page, { maxLinks: 100 }),
  ).rejects.toThrow();
});

it.each([
  { maxLinks: 0 },
  { maxLinks: 201 },
  { pathPrefix: "//x?query" },
  { pathPrefix: "not-a-path" },
  { script: "alert(1)" },
])("rejects invalid discovery input %j", (patch) => {
  expect(
    WebChapterDiscoveryRequestSchema.safeParse({
      requestId: "11111111-1111-4111-8111-111111111111",
      url: page.href,
      ...patch,
    }).success,
  ).toBe(false);
});
