import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { vi } from "vitest";
import { McpCompositePrepareSchema } from "../src/shared/mcpCompositeWorkflow";
import { selectionAppFixture } from "./mcpSelectionApp.fixture";
import { newCompositeRecord } from "./mcpCompositeRepository.fixture";

/** Native saved chapter/context/files; only external font environment is deterministic. */
export async function compositeNativeSourcesFixture() {
  const f = await selectionAppFixture(true);
  const native = await import("../src/main/mcp/mcpCompositeNativePages");
  const chapter = await f.library.openChapter("chapter");
  const targets = chapter.pages.map((page) => ({
    workId: chapter.workId,
    chapterId: chapter.id,
    pageId: page.id,
    blockIds: [],
  }));
  const plan = McpCompositePrepareSchema.parse({
    requestId: randomUUID(),
    reason: "Owned native source evidence",
    targets: { kind: "saved", pages: targets },
    phases: [{ kind: "review", id: "review" }],
    budgets: { admissions: 2, pageAttempts: 4, models: {} },
  });
  const fonts = vi.fn(async () => "a".repeat(64));
  const guard = vi.fn(() => {});
  const options = {
    settings: () => f.settings,
    readFonts: fonts,
    readContext: f.library.readWorkContextForEdit,
    preferences: {
      allowEditing: true,
      allowProcessing: true,
      allowImages: true,
    },
  };
  const read = () =>
    native.readMcpCompositeSources(targets, plan, guard, options);
  const record = newCompositeRecord();
  Object.assign(record, {
    owner: f.owner,
    plan,
    targets,
    snapshot: (await read()).snapshot,
    phases: [{ id: "review", status: "running" }],
  });
  const mutateChapter = async (change: (value: typeof chapter) => void) => {
    const value: typeof chapter = JSON.parse(
      await readFile(f.chapterPath, "utf8"),
    );
    change(value);
    await writeFile(f.chapterPath, JSON.stringify(value));
  };
  return {
    ...f,
    native,
    targets,
    plan,
    options,
    fonts,
    guard,
    read,
    record,
    chapter,
    mutateChapter,
  };
}
