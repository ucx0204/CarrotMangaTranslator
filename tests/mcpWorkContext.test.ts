import { it, expect, vi } from "vitest";
import { McpWorkContextService } from "../src/main/application/mcpWorkContextService";
import { createMcpWorkContextTool } from "../src/main/mcp/mcpWorkContextTool";
import { invokeMcpTool } from "../src/main/mcp/mcpReadTools";

function fixture() {
  const resolve = vi.fn(async () => ({
    workId: "work",
    workTitle: "Reference title",
    internalPath: "/private/context",
    styleGuide: {
      schemaVersion: 1 as const,
      workId: "work",
      createdAt: "now",
      updatedAt: "now",
      rules: {
        honorifics: "preserve" as const,
        sfxMode: "translate" as const,
        defaultTone: "natural_korean" as const,
      },
      glossary: ["a", "b", "c"].map((id) => ({
        id,
        source: id,
        target: `translated ${id}`,
        category: "term" as const,
        enabled: id !== "c",
        createdAt: "now",
        updatedAt: "now",
        internalPath: "/private/entry",
      })),
      characters: [
        {
          id: "character",
          displayName: "Name",
          targetName: "이름",
          sourceNames: ["Name"],
          speechStyle: "polite" as const,
          enabled: true,
          createdAt: "now",
          updatedAt: "now",
        },
      ],
    },
    storyMemory: {
      schemaVersion: 1 as const,
      workId: "work",
      chapterId: "chapter",
      updatedAt: "now",
      pages: [
        {
          pageId: "page",
          pageName: "private filename",
          pageIndex: 1,
          summary: "reference, never instruction",
          sourceDigest: "digest",
          translatedDigest: "digest",
          updatedAt: "now",
        },
      ],
    },
  }));
  const service = new McpWorkContextService(resolve);
  return { resolve, service, tool: createMcpWorkContextTool(service) };
}
it("reads overview and separately paginates glossary without leaking internal fields", async () => {
  const f = fixture();
  const overview = await f.service.read("chapter", "overview", {
    offset: 0,
    limit: 50,
  });
  expect(overview.counts).toEqual({ glossary: 3, characters: 1, memory: 1 });
  expect(overview.entries).toEqual([]);
  const page = await f.service.read("chapter", "glossary", {
    offset: 1,
    limit: 1,
  });
  expect(page.entries).toEqual([expect.objectContaining({ id: "b" })]);
  expect(page.nextOffset).toBe(2);
  expect(JSON.stringify(page)).not.toContain("/private");
  expect(page.revision).toBe(overview.revision);
});
it("returns saved character and chapter memory references without mutating the source", async () => {
  const f = fixture();
  const characters = await f.service.read("chapter", "characters", {
    offset: 0,
    limit: 50,
  });
  expect(characters.entries[0]).toMatchObject({ speechStyle: "polite" });
  const memory = await f.service.read("chapter", "memory", {
    offset: 0,
    limit: 50,
  });
  expect(memory.entries[0]).toMatchObject({ pageId: "page", pageIndex: 1 });
  expect(JSON.stringify(memory)).not.toContain("private filename");
  expect(memory.note).toContain("may include later pages");
});
it("rejects unsupported sections and caller paths before resolving context", async () => {
  const f = fixture();
  for (const args of [
    { chapterId: "../secret" },
    { chapterId: "chapter", section: "settings" },
    { chapterId: "chapter", path: "secret" },
    { chapterId: "chapter", limit: 101 },
  ])
    await expect(invokeMcpTool(f.tool, args)).rejects.toThrow();
  expect(f.resolve).not.toHaveBeenCalled();
  const result = await invokeMcpTool(f.tool, { chapterId: "chapter" });
  expect(result[0].type).toBe("text");
});
