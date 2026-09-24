import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import { capturePageRecovery } from "../src/shared/pageRecoverySnapshot";
import { createPageRevision } from "../src/shared/pageRevision";
import { McpCompositeWorkflowActionSchema } from "../src/shared/mcpCompositeWorkflowActions";
import {
  mcpExportPageMetadata,
  mcpExportSnapshot,
  selectMcpExportPages,
} from "../src/main/application/mcpExportSelection";
import {
  mcpExportSource,
  mcpOperationOutputMetadata,
} from "../src/main/application/mcpOperationOutputs";
import type { McpCompositeNativePage } from "../src/main/mcp/mcpCompositeNativePages";
import type { CompositeNativeRead } from "../src/main/mcp/mcpCompositeNativeTools";
import { readMcpExportSourceName } from "../src/main/mcp/mcpSourceExport";
import { RetainedPageStateSchema } from "../src/main/mcp/mcpRetentionRecords";
import { editingChapter } from "./mcpEditing.fixture";
import { newCompositeRecord } from "./mcpCompositeRepository.fixture";

export function compositeOutputFixture() {
  const chapter = editingChapter();
  const original = chapter.pages[0];
  for (const block of original.blocks) block.backgroundColor = "#ffffff";
  chapter.pages.push({
    ...structuredClone(original),
    id: "second",
    name: "second.webp",
  });
  chapter.pageOrder = chapter.pages.map((page) => page.id);
  const { saved, values } = outputValues(chapter);
  const record = newCompositeRecord();
  const { replies, inspect, read } = outputReader();
  const { input, imageReview, pages } = outputImagePlan(chapter);
  replies.set("carrot_preflight_pages_export", imageReview);
  const { sourceJobId, entry, operations } = outputOperations(
    record.owner,
    input,
    pages,
  );
  return {
    chapter,
    saved,
    values,
    record,
    replies,
    inspect,
    read,
    input,
    imageReview,
    entry,
    sourceJobId,
    operations,
    guard: vi.fn(() => {}),
    options: { read, operations },
  };
}

function outputValues(chapter: ReturnType<typeof editingChapter>) {
  const now = new Date().toISOString();
  const saved: McpCompositeNativePage["saved"] = {
    workId: chapter.workId,
    workTitle: "Output selection",
    chapter,
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
      createdAt: now,
      updatedAt: now,
    },
    storyMemory: {
      schemaVersion: 1,
      workId: chapter.workId,
      chapterId: chapter.id,
      pages: [],
      updatedAt: now,
    },
  };
  const values: McpCompositeNativePage[] = chapter.pages.map((page) => ({
    target: {
      workId: chapter.workId,
      chapterId: chapter.id,
      pageId: page.id,
      blockIds: [page.blocks[0].id],
    },
    page,
    saved,
    state: {
      page: {
        ...capturePageRecovery(page),
        translationCompletion:
          RetainedPageStateSchema.shape.page.shape.translationCompletion.parse(
            page.translationCompletion,
          ),
      },
      files: [],
      fingerprint: "a".repeat(16),
    },
  }));
  return { saved, values };
}

function outputReader() {
  const replies = new Map<string, unknown>();
  const inspect = vi.fn(
    async (name: string, _input: Record<string, unknown>, _owner: string) => {
      if (!replies.has(name))
        throw new Error(`Unexpected native inspection: ${name}`);
      return structuredClone(replies.get(name));
    },
  );
  const read: CompositeNativeRead = async (
    schema,
    name,
    input,
    owner,
    guard,
  ) => {
    guard();
    const result = await inspect(name, input, owner);
    guard();
    return schema.parse(result);
  };
  return { replies, inspect, read };
}

function outputImagePlan(chapter: ReturnType<typeof editingChapter>) {
  const pages = selectMcpExportPages(chapter).map(mcpExportPageMetadata);
  const snapshot = mcpExportSnapshot(chapter);
  const input = {
    chapterId: chapter.id,
    snapshot,
    pages: pages.map(({ pageId, revision }) => ({ pageId, revision })),
    requestId: randomUUID(),
  };
  const imageReview = {
    chapterId: chapter.id,
    snapshot,
    pages: pages.map((page) => ({ ...page, issues: [] })),
    executionReserved: false as const,
    notChecked: ["output-budgets"],
  };
  return { input, imageReview, pages };
}

function outputOperations(
  ownerId: string,
  input: ReturnType<typeof outputImagePlan>["input"],
  pages: ReturnType<typeof outputImagePlan>["pages"],
) {
  const sourceJobId = randomUUID();
  const entry = outputEntry(input, pages);
  const assertOwner = (id: string, owner: string) => {
    if (id !== sourceJobId || owner !== ownerId)
      throw new Error("owned source unavailable");
  };
  const operations = {
    ready: vi.fn(async () => {}),
    exportSource: vi.fn((id: string, owner: string) => {
      assertOwner(id, owner);
      return mcpExportSource(entry);
    }),
    outputMetadata: vi.fn((id: string, owner: string, pageId?: string) => {
      assertOwner(id, owner);
      return mcpOperationOutputMetadata(entry, pageId);
    }),
  };
  return { entry, sourceJobId, operations };
}

function outputEntry(
  input: ReturnType<typeof outputImagePlan>["input"],
  pages: ReturnType<typeof outputImagePlan>["pages"],
) {
  return {
    kind: "exportPages",
    settled: true,
    status: "completed",
    requestId: input.requestId,
    parameters: input,
    result: {
      kind: "rendered-pages-png",
      exportPages: {
        chapterId: input.chapterId,
        snapshot: input.snapshot,
        total: pages.length,
        completed: pages.length,
        pages: pages.map((page) => ({
          ...page,
          status: "exported",
          bytes: 40,
          sha256: "b".repeat(64),
          retainedOutputId: randomUUID(),
        })),
      },
    },
  };
}

export function compositeOutputAction(value: unknown) {
  const parsed = McpCompositeWorkflowActionSchema.parse(value);
  if (
    ![
      "images-export",
      "work-file-export",
      "zip-export",
      "text-export",
      "context-export",
    ].includes(parsed.kind)
  )
    throw new Error("Fixture needs an output action.");
  if (
    parsed.kind === "images-export" ||
    parsed.kind === "work-file-export" ||
    parsed.kind === "zip-export" ||
    parsed.kind === "text-export" ||
    parsed.kind === "context-export"
  )
    return parsed;
  throw new Error("Fixture output kind is unavailable.");
}

export function sourceFormatReview(
  f: ReturnType<typeof compositeOutputFixture>,
) {
  const imageExport = {
    format: "source" as const,
    omitText: false,
    jpegQuality: 83,
    webpQuality: 77,
    unsupportedSource: "png" as const,
  };
  f.chapter.pages[0].sourceFileName = "original.JPEG";
  const pages = selectMcpExportPages(
    f.chapter,
    undefined,
    imageExport,
    readMcpExportSourceName,
  );
  const snapshot = mcpExportSnapshot(f.chapter, imageExport, pages);
  f.replies.set("carrot_preflight_pages_export", {
    ...f.imageReview,
    imageExport,
    snapshot,
    pages: pages.map((page) => ({
      ...mcpExportPageMetadata(page),
      issues: [],
    })),
  });
  return {
    ...f.input,
    imageExport,
    snapshot,
    pages: pages.map(({ pageId, revision }) => ({ pageId, revision })),
  };
}

export function staleOutputRevision(
  f: ReturnType<typeof compositeOutputFixture>,
) {
  f.chapter.pages[0].blocks[0].translatedText =
    "Changed after native inspection";
  return createPageRevision(f.chapter.pages[0]);
}
