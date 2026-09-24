import { readFile, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { contextReferenceAppFixture as fixture } from "./mcpContextReferenceApp.fixture";

it("uses the complete native chapter order and preserves raw orphan memory and every saved file", async () => {
  const f = await fixture();
  try {
    const paths = [
      f.chapterPath,
      f.secondPath,
      f.workPath,
      join(f.env.libraryDir, "works", "work", "style-guide.json"),
      join(
        f.env.libraryDir,
        "works",
        "work",
        "chapters",
        "chapter-two",
        "story-memory.json",
      ),
    ];
    for (const id of ["chapter", "chapter-two"])
      for (const page of (await f.library.openChapter(id)).pages)
        paths.push(page.imagePath);
    const before = await Promise.all(paths.map((path) => readFile(path)));
    const result = await f.invoke();
    expect(result.counts).toMatchObject({
      chapters: 2,
      pages: 4,
      references: 3,
      missing: 1,
      orphanedMemories: 1,
    });
    expect(result.references).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          chapterId: "chapter-two",
          entryId: "missing-character",
          status: "missing",
        }),
        expect.objectContaining({
          chapterId: "chapter-two",
          pageId: "orphan",
          orphanedMemory: true,
        }),
      ]),
    );
    expect(JSON.stringify(result)).not.toMatch(
      /Private|imagePath|dataUrl|sourceDigest/,
    );
    expect(await Promise.all(paths.map((path) => readFile(path)))).toEqual(
      before,
    );
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.tool.readOnly).toBe(true);
    expect(f.tool.requiredScopes).toEqual(["carrot.read"]);
    expect(f.context.assertScopes).toHaveBeenCalledWith(["carrot.read"]);
    const next = await f.invoke({
      chapterId: "chapter",
      offset: 1,
      limit: 1,
      snapshot: result.snapshot,
    });
    expect(next.references).toHaveLength(1);
  } finally {
    await f.close();
  }
});

it("rejects a missing chapter instead of returning an apparently complete inventory", async () => {
  const f = await fixture();
  try {
    const work = JSON.parse(await readFile(f.workPath, "utf8"));
    await writeFile(
      f.workPath,
      JSON.stringify({
        ...work,
        chapterOrder: [...work.chapterOrder, "absent"],
      }),
    );
    await expect(f.invoke()).rejects.toThrow();
    expect(f.prepare).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it("rejects changed other-chapter data and reordered work membership during pagination", async () => {
  const f = await fixture();
  try {
    const before = await f.invoke();
    const chapter = JSON.parse(await readFile(f.secondPath, "utf8"));
    chapter.pages[0].blocks[0].speakerId = "character";
    await writeFile(f.secondPath, JSON.stringify(chapter));
    await expect(
      f.invoke({ chapterId: "chapter", offset: 1, snapshot: before.snapshot }),
    ).rejects.toThrow("Restart pagination");
    const changed = await f.invoke();
    const work = JSON.parse(await readFile(f.workPath, "utf8"));
    await writeFile(
      f.workPath,
      JSON.stringify({
        ...work,
        chapterOrder: [...work.chapterOrder].reverse(),
      }),
    );
    await expect(
      f.invoke({ chapterId: "chapter", offset: 1, snapshot: changed.snapshot }),
    ).rejects.toThrow("Restart pagination");
  } finally {
    await f.close();
  }
});

it("keeps identity scope malformed-input and revocation guards on the actual registered tool", async () => {
  const f = await fixture();
  try {
    await expect(f.tool.invoke({ chapterId: "chapter" })).rejects.toThrow(
      "approved connection",
    );
    f.context.assertScopes.mockImplementationOnce(() => {
      throw new Error("scope denied");
    });
    await expect(f.invoke()).rejects.toThrow("scope denied");
    await expect(
      f.invoke({ chapterId: "chapter", path: "C:/private" }),
    ).rejects.toThrow("Invalid tool arguments");
    f.context.assertAuthorized.mockImplementationOnce(() => {
      throw new Error("revoked");
    });
    await expect(f.invoke()).rejects.toThrow("revoked");
  } finally {
    await f.close();
  }
});

it("registers context inspection and migration preview when editing processing and images are disabled", async () => {
  const f = await fixture();
  try {
    const { createMcpAppTools } = await import("../src/main/mcp/mcpAppTools");
    const { DEFAULT_MCP_PREFERENCES } =
      await import("../src/shared/mcpDesktopTypes");
    const tools = createMcpAppTools({
      preferences: {
        ...DEFAULT_MCP_PREFERENCES,
        allowEditing: false,
        allowProcessing: false,
        allowImages: false,
      },
      assertWritable: async () => {
        throw new Error("Read-only inspection must not request editing");
      },
      notifySaved: () => {
        throw new Error("Read-only inspection must not notify a save");
      },
    });
    const tool = tools.find(
      (item) => item.name === "carrot_get_context_references",
    );
    expect(tool).toBeDefined();
    expect(
      await tool?.invoke({ chapterId: "chapter" }, f.context),
    ).toBeDefined();
    const preview = tools.find(
      (item) => item.name === "carrot_preview_context_migration",
    );
    expect(preview).toMatchObject({
      readOnly: true,
      requiredScopes: ["carrot.read"],
    });
    const references = await f.invoke();
    expect(
      await preview?.invoke(
        {
          chapterId: "chapter",
          referenceSnapshot: references.snapshot,
          command: {
            kind: "delete",
            entity: "character",
            entryIds: ["character"],
            unlinkReferences: true,
          },
          preserveManual: false,
        },
        f.context,
      ),
    ).toBeDefined();
  } finally {
    await f.close();
  }
});

it("uses only the native chapter-local relocated image without rewriting stored paths", async () => {
  const f = await fixture();
  try {
    const first = JSON.parse(await readFile(f.chapterPath, "utf8"));
    const second = JSON.parse(await readFile(f.secondPath, "utf8"));
    const localPath = second.pages[0].imagePath;
    second.pages[0].imagePath = first.pages[0].imagePath;
    await writeFile(f.secondPath, JSON.stringify(second));
    const before = await readFile(f.secondPath);
    const foreignBytes = await readFile(first.pages[0].imagePath);
    expect((await f.invoke()).counts.chapters).toBe(2);
    const loaded = await f.library.openChapter("chapter-two");
    expect(loaded.pages[0].imagePath).toBe(resolve(localPath));
    expect(loaded.pages[0].imagePath).not.toBe(first.pages[0].imagePath);
    expect(await readFile(f.secondPath)).toEqual(before);
    expect(await readFile(first.pages[0].imagePath)).toEqual(foreignBytes);
  } finally {
    await f.close();
  }
});

it("rejects a foreign chapter image when no native chapter-local relocation exists", async () => {
  const f = await fixture();
  try {
    const first = JSON.parse(await readFile(f.chapterPath, "utf8"));
    const second = JSON.parse(await readFile(f.secondPath, "utf8"));
    await unlink(second.pages[0].imagePath);
    second.pages[0].imagePath = first.pages[0].imagePath;
    await writeFile(f.secondPath, JSON.stringify(second));
    const before = await readFile(f.secondPath);
    const foreignBytes = await readFile(first.pages[0].imagePath);
    await expect(f.invoke()).rejects.toThrow("이미지 경로");
    expect(await readFile(f.secondPath)).toEqual(before);
    expect(await readFile(first.pages[0].imagePath)).toEqual(foreignBytes);
  } finally {
    await f.close();
  }
});

it("previews native cross-chapter unlink impact without saving or exposing private page and memory content", async () => {
  const f = await fixture();
  try {
    const { mcpToolResult } = await import("../src/main/mcp/mcpToolResult");
    const tool = f.tools.find(
      (item) => item.name === "carrot_preview_context_migration",
    );
    if (!tool) throw new Error("Missing migration preview tool");
    const paths = [
      f.chapterPath,
      f.secondPath,
      f.workPath,
      join(f.env.libraryDir, "works", "work", "style-guide.json"),
      join(
        f.env.libraryDir,
        "works",
        "work",
        "chapters",
        "chapter-two",
        "story-memory.json",
      ),
    ];
    const before = await Promise.all(paths.map((path) => readFile(path)));
    const references = await f.invoke();
    const args = {
      chapterId: "chapter",
      referenceSnapshot: references.snapshot,
      command: {
        kind: "delete",
        entity: "character",
        entryIds: ["character"],
        unlinkReferences: true,
      },
      preserveManual: false,
      section: "references",
    };
    const result = mcpToolResult(tool, await tool.invoke(args, f.context));
    expect(result.structuredContent).toMatchObject({
      status: "preview_only",
      executable: false,
      pagesChanged: 0,
      counts: {
        entriesRemoved: 1,
        referencesUnlinked: 2,
        pagesAffected: 1,
        memoryRowsAffected: 1,
        orphanedMemoryRowsAffected: 1,
      },
    });
    expect(JSON.stringify(result)).not.toMatch(
      /Private|imagePath|sourceDigest|translatedText/,
    );
    expect(await Promise.all(paths.map((path) => readFile(path)))).toEqual(
      before,
    );
    expect(f.prepare).not.toHaveBeenCalled();
    await expect(
      tool.invoke({ ...args, apply: true }, f.context),
    ).rejects.toThrow("Invalid tool arguments");
    await expect(tool.invoke(args)).rejects.toThrow("approved connection");
    f.context.assertScopes.mockImplementationOnce(() => {
      throw new Error("scope denied");
    });
    await expect(tool.invoke(args, f.context)).rejects.toThrow("scope denied");
  } finally {
    await f.close();
  }
});
