import { randomUUID } from "node:crypto";
import { setImmediate as tick } from "node:timers/promises";
import { vi } from "vitest";
import { editingChapter } from "./mcpEditing.fixture";
import type { McpContextSnapshot } from "../src/main/application/mcpContextEditPolicy";
import { McpPageEditService } from "../src/main/application/mcpPageEditService";
import { McpTranslationBatchService } from "../src/main/application/mcpTranslationBatchService";
import { McpEditError } from "../src/main/application/mcpEditPolicy";
import { createPageRevision } from "../src/shared/pageRevision";
import { mcpContextRevision } from "../src/shared/mcpContextEditing";
import { McpTranslationBatchPreviewSchema } from "../src/shared/mcpTranslationBatch";
import type { SavePageBlocksRequest } from "../src/shared/shareTypes";
import type { BatchTextCommit } from "../src/main/application/mcpTranslationBatchRunner";

export function translationBatchFixture() {
  const chapter = editingChapter();
  chapter.pages = ["page", "second", "third"].map((id) => {
    const page = structuredClone(chapter.pages[0]);
    page.id = id;
    for (const block of page.blocks) {
      delete block.generatedLettering;
      block.textRole = "ordinary";
    }
    return page;
  });
  chapter.pageOrder = chapter.pages.map((page) => page.id);
  const saved: McpContextSnapshot = {
    chapter,
    workId: chapter.workId,
    workTitle: "Synthetic text-edit fixture",
    styleGuide: {
      schemaVersion: 1,
      workId: chapter.workId,
      glossary: [],
      characters: [],
      rules: {
        honorifics: "adapt",
        sfxMode: "translate",
        defaultTone: "natural_korean",
      },
      createdAt: "2026-09-17",
      updatedAt: "2026-09-17",
    },
    storyMemory: {
      schemaVersion: 1,
      workId: chapter.workId,
      chapterId: chapter.id,
      pages: [],
      updatedAt: "2026-09-17",
    },
  };
  let time = 1000;
  const openChapter = vi.fn(async () => structuredClone(chapter));
  const save = vi.fn(
    async (request: SavePageBlocksRequest, guard?: () => void) => {
      guard?.();
      const page = chapter.pages.find((item) => item.id === request.pageId);
      if (!page) throw new Error("Fixture page missing");
      if (request.expectedRevision !== createPageRevision(page))
        throw new Error("페이지가 다른 작업으로 갱신되었습니다");
      page.blocks = structuredClone(request.blocks);
      page.blockOrder = request.blockOrder;
      return structuredClone(chapter);
    },
  );
  const notify = vi.fn();
  const assertWritable = vi.fn(async () => {});
  const edits = new McpPageEditService({
    openChapter,
    savePageBlocks: save,
    assertWritable,
    notifySaved: notify,
  });
  const read = vi.fn(async () => structuredClone(saved));
  const commit: BatchTextCommit = (request, expected, guard, onCommitted) =>
    edits.commitTranslationBatch(
      request,
      expected.membership,
      guard,
      onCommitted,
      async (run) => {
        guard();
        if (
          expected.contextRevision !== null &&
          expected.contextRevision !== mcpContextRevision(saved)
        )
          throw new McpEditError("revision_conflict", "context changed");
        return run();
      },
    );
  const errors: unknown[] = [];
  const lifetime = new AbortController();
  const ports = {
    read,
    commit,
    reportError: (error: unknown) => {
      errors.push(error);
    },
  };
  const service = new McpTranslationBatchService(
    ports,
    () => time,
    lifetime.signal,
  );
  const request = () =>
    McpTranslationBatchPreviewSchema.parse({
      chapterId: chapter.id,
      contextRevision: mcpContextRevision(saved),
      requestId: randomUUID(),
      reason: "AI found inconsistent name spelling in this chapter",
      pages: chapter.pages.map((page) => ({
        pageId: page.id,
        revision: createPageRevision(page),
        edits: [
          {
            blockId: "a",
            translatedText: "리오가 왔다.",
            reason: "Use the same intended character name",
          },
        ],
      })),
    });
  const owner = "owner";
  const guard = () => {};
  const inspect = (batchId: string) =>
    service.inspect(owner, { batchId }, guard);
  const done = async (batchId: string) => {
    for (let count = 0; count < 100; count++) {
      await tick();
      const result = await inspect(batchId);
      if (result.status !== "running") return result;
    }
    throw new Error("Batch did not settle");
  };
  return {
    saved,
    chapter,
    save,
    notify,
    assertWritable,
    edits,
    read,
    ports,
    errors,
    service,
    lifetime,
    owner,
    guard,
    request,
    inspect,
    done,
    advance: (ms: number) => {
      time += ms;
    },
    start: (
      batchId: string,
      direction: "apply" | "undo" | "redo",
      requestId: string = randomUUID(),
    ) => service.start(owner, { batchId, requestId }, direction, guard),
  };
}
