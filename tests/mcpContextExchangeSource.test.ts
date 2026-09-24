import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { contextReferenceAppFixture } from "./mcpContextReferenceApp.fixture";

it("exports native guide and raw orphan/duplicate memory fields without chapter paths or projection loss", async () => {
  const f = await contextReferenceAppFixture();
  try {
    const source = await import("../src/main/mcp/mcpContextExchangeSource");
    const guide = await f.library.getWorkStyleGuide("work");
    guide.characters[0].enabled = false;
    guide.characters[0].customSpeechStyle = "Preserve an optional native field";
    await f.library.saveWorkStyleGuide(guide);
    const memory = await f.library.getChapterStoryMemory("chapter-two");
    memory.pages.push(structuredClone(memory.pages[0]));
    memory.pages[0].textEvidence = {
      version: 1,
      method: "native-excerpt",
      sourceFingerprint: "1".repeat(16),
      translationFingerprint: "2".repeat(16),
      contextFingerprint: "3".repeat(16),
      summaryFingerprint: "4".repeat(16),
    };
    memory.pages[0].visualSummary = "Manual visual summary";
    memory.pages[0].visualSummarySource = "manual";
    await f.library.saveChapterStoryMemory(memory);
    const native = await import("../src/main/libraryStore/workContextFiles");
    const expected = {
      guide: await native.readWorkStyleGuide("work"),
      memory: await native.readChapterStoryMemory("chapter-two"),
    };
    const chapterBefore = await readFile(f.secondPath);
    const state = await source.readMcpContextExchangeState(
      {
        workId: "work",
        chapterId: "chapter-two",
        scope: "guide-and-memory",
      },
      () => {},
    );
    const decoded = JSON.parse(state.bytes.toString("utf8"));
    expect(decoded.guide).toEqual(expected.guide);
    expect(decoded.memory).toEqual(expected.memory);
    expect(
      decoded.memory.pages.map((page: { pageId: string }) => page.pageId),
    ).toEqual(["orphan", "orphan"]);
    expect(state.review.presence).toEqual({ guide: true, memory: true });
    expect(state.review.counts.memoryPages).toBe(2);
    expect(state.bytes.toString()).not.toContain("imagePath");
    expect(state.bytes.toString()).not.toContain(f.env.libraryDir);
    expect(state.review).not.toHaveProperty("guide");
    await state.verifySources();
    expect(await readFile(f.secondPath)).toEqual(chapterBefore);
  } finally {
    await f.close();
  }
});

it("represents absent files as null and keeps absent-context bytes stable across clocks", async () => {
  const f = await contextReferenceAppFixture();
  try {
    const source = await import("../src/main/mcp/mcpContextExchangeSource");
    await rm(join(f.env.libraryDir, "works", "work", "style-guide.json"));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const input = {
      workId: "work",
      chapterId: "chapter",
      scope: "guide-and-memory" as const,
    };
    const first = await source.readMcpContextExchangeState(input, () => {});
    vi.setSystemTime(new Date("2027-01-01T00:00:00Z"));
    const second = await source.readMcpContextExchangeState(input, () => {});
    expect(first.payload.guide).toBeNull();
    expect(first.payload.memory).toBeNull();
    expect(second.bytes).toEqual(first.bytes);
    expect(second.binding).toEqual(first.binding);
    const guideOnly = await source.readMcpContextExchangeState(
      { ...input, scope: "guide" },
      () => {},
    );
    expect(guideOnly.payload).not.toHaveProperty("memory");
    expect(guideOnly.review.presence).toEqual({ guide: false });
  } finally {
    vi.useRealTimers();
    await f.close();
  }
});

it("checks selected context presence/content and membership without requiring image evidence", async () => {
  const f = await contextReferenceAppFixture();
  try {
    const source = await import("../src/main/mcp/mcpContextExchangeSource");
    const lock = await import("../src/main/library/lock");
    const input = {
      workId: "work",
      chapterId: "chapter",
      scope: "guide" as const,
    };
    const guideOnly = await source.readMcpContextExchangeState(input, () => {});
    const both = await source.readMcpContextExchangeState(
      { ...input, scope: "guide-and-memory" },
      () => {},
    );
    const memory = await f.library.getChapterStoryMemory("chapter");
    await f.library.saveChapterStoryMemory(memory);
    await expect(
      source.checkMcpContextExchangeBinding(both.binding),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    await source.checkMcpContextExchangeBinding(guideOnly.binding);
    const chapter = JSON.parse(await readFile(f.chapterPath, "utf8"));
    await writeFile(
      chapter.pages[0].imagePath,
      Buffer.from(
        "not an image: this read-only context path must not decode it",
      ),
    );
    await source.checkMcpContextExchangeBinding(guideOnly.binding);
    const guide = await f.library.getWorkStyleGuide("work");
    guide.rules.defaultTone = "literal";
    await f.library.saveWorkStyleGuide(guide);
    await expect(
      lock.withLibraryRead(() =>
        source.checkMcpContextExchangeBindingUnlocked(guideOnly.binding),
      ),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    const fresh = await source.readMcpContextExchangeState(input, () => {});
    const work = JSON.parse(await readFile(f.workPath, "utf8"));
    await writeFile(
      f.workPath,
      JSON.stringify({ ...work, chapterOrder: ["chapter-two"] }),
    );
    await expect(
      source.checkMcpContextExchangeBinding(fresh.binding),
    ).rejects.toThrow();
  } finally {
    await f.close();
  }
});

it("honors cancellation and grant revocation during native metadata reads", async () => {
  const f = await contextReferenceAppFixture();
  try {
    const source = await import("../src/main/mcp/mcpContextExchangeSource");
    const operation = new AbortController();
    const cancelled = new Error("cancelled context export");
    operation.abort(cancelled);
    await expect(
      source.readMcpContextExchangeState(
        {
          workId: "work",
          chapterId: "chapter",
          scope: "guide",
        },
        () => {},
        operation.signal,
      ),
    ).rejects.toBe(cancelled);
    let authorized = true;
    await expect(
      source.readMcpContextExchangeState(
        {
          workId: "work",
          chapterId: "chapter",
          scope: "guide",
        },
        () => {
          if (!authorized)
            throw new Error("grant revoked during metadata read");
          queueMicrotask(() => {
            authorized = false;
          });
        },
      ),
    ).rejects.toThrow(/grant revoked/);
  } finally {
    await f.close();
  }
});
