import { randomUUID } from "node:crypto";
import { setImmediate as tick } from "node:timers/promises";
import { vi } from "vitest";
import { translationBatchFixture } from "./mcpTranslationBatch.fixture";
import { McpPageBatchService } from "../src/main/application/mcpPageBatchService";
import {
  createMcpLetteringPolicy,
  applyMcpLetteringSnapshots,
  type LetteringPreparation,
  type LetteringSnapshotRequest,
} from "../src/main/application/mcpLetteringPolicy";
import { projectMcpLetteringPage } from "../src/main/application/mcpLetteringProjection";
import { parseMcpLetteringRule } from "../src/shared/mcpLetteringAdvanced";
import { McpLetteringPrepareSchema } from "../src/shared/mcpLettering";
import { mcpContextRevision } from "../src/shared/mcpContextEditing";
import { createPageRevision } from "../src/shared/pageRevision";
import { requireBatchPage } from "../src/main/application/mcpPageBatchPolicy";
import { McpEditError } from "../src/main/application/mcpEditPolicy";

export function letteringFixture() {
  const f = translationBatchFixture();
  const prepare = vi.fn<LetteringPreparation>(async (saved, input, access) => {
    access.guard();
    const command = input.command;
    if (command.kind === "layout")
      throw new Error("Use the dedicated native layout fixture.");
    return {
      pages: input.pages.map((target) =>
        projectMcpLetteringPage({
          chapter: saved.chapter,
          page: requireBatchPage(saved.chapter, target),
          blockIds: target.edits
            .map((edit) => edit.blockId)
            .filter(
              (id) =>
                !saved.chapter.pages
                  .find((page) => page.id === target.pageId)
                  ?.blocks.find((block) => block.id === id)?.generatedLettering,
            ),
          command,
          recipe: {
            schemes:
              command.kind === "rule"
                ? [parseMcpLetteringRule(command.schemeJson)]
                : [],
          },
          glossary: saved.styleGuide.glossary,
        }),
      ),
      binding: { catalogSnapshot: null, images: [] },
      exclusions: {},
    };
  });
  const check = vi.fn(async (_request: LetteringSnapshotRequest) => {});
  const service = new McpPageBatchService(
    {
      read: f.read,
      reportError: f.ports.reportError,
      commit: (request: LetteringSnapshotRequest, expected, guard, committed) =>
        f.edits.commitSnapshotBatch(
          request,
          expected.membership,
          guard,
          committed,
          async (run) => {
            guard();
            if (request.direction !== "undo") {
              if (mcpContextRevision(f.saved) !== expected.contextRevision)
                throw new McpEditError("revision_conflict", "Context changed.");
              for (const page of request.dependencies)
                requireBatchPage(f.chapter, { ...page, edits: [] });
              await check(request);
              guard();
            }
            return run();
          },
          applyMcpLetteringSnapshots,
        ),
    },
    createMcpLetteringPolicy(prepare),
    Date.now,
    f.lifetime.signal,
  );
  const request = (
    command: unknown = {
      kind: "format",
      fields: { bold: true },
      advanced: {
        textGlow: { enabled: true, color: "#aabbcc", blurPx: 5, opacity: 0.7 },
      },
    },
  ) =>
    McpLetteringPrepareSchema.parse({
      chapterId: f.chapter.id,
      contextRevision: mcpContextRevision(f.saved),
      requestId: randomUUID(),
      reason: "Explicit lettering fixture",
      command,
      pages: f.chapter.pages.map((page) => ({
        pageId: page.id,
        revision: createPageRevision(page),
        edits: [{ blockId: "a", reason: "Style selected text only" }],
      })),
    });
  const inspect = (batchId: string) =>
    service.inspect(f.owner, { batchId }, f.guard);
  const done = async (batchId: string) => {
    for (let i = 0; i < 100; i++) {
      await tick();
      const result = await inspect(batchId);
      if (result.status !== "running") return result;
    }
    throw new Error("Lettering action did not settle.");
  };
  return {
    ...f,
    service,
    prepare,
    check,
    request,
    inspect,
    done,
    start: (
      batchId: string,
      direction: "apply" | "undo" | "redo",
      requestId = randomUUID(),
    ) => service.start(f.owner, { batchId, requestId }, direction, f.guard),
    close: async () => {
      await service.close();
      await f.service.close();
    },
  };
}
