import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { LibraryChapter } from "../src/shared/libraryTypes";
import { McpCompositePrepareSchema } from "../src/shared/mcpCompositeWorkflow";
import { mcpLibraryImportOutputs } from "../src/shared/mcpLibraryImport";
import { createPageRevision } from "../src/shared/pageRevision";
import { libraryImportFixture } from "./mcpLibraryImport.fixture";
import { deferred, mutation } from "./mcpCompositeWorkflow.fixture";

/** Real import tools, retained repository, native calls and source verification; no model work. */
export async function compositeImportPublicationFixture() {
  const f = await libraryImportFixture();
  const { createMcpCompositeNative } =
    await import("../src/main/mcp/mcpCompositeNativeAdapter");
  const { McpCompositeRepository } =
    await import("../src/main/mcp/mcpCompositeRepository");
  const { McpCompositeWorkflowService } =
    await import("../src/main/application/mcpCompositeWorkflowService");
  const { getChapterFilePath, getWorkFilePath } =
    await import("../src/main/libraryStore/libraryPaths");
  const { getAppSettings } = await import("../src/main/settingsStore");
  const owner = "import-owner";
  const guard = () => {};
  const session = f.current().session;
  let fontFingerprint = "a".repeat(64);
  const native = createMcpCompositeNative({
    tools: session.tools,
    operations: f.current().operations,
    batches: {},
    imageReviewMapping: session.reviewMapping,
    workFileReviewMapping: session.workFileReviewMapping,
    settings: () => getAppSettings(f.app.appPaths),
    preferences: f.preferences,
    readContext: f.library.readWorkContextForEdit,
    readFonts: async () => fontFingerprint,
    readSoundEffectPlan: () => {
      throw new Error("This import fixture does not admit SFX preparation.");
    },
  });
  const published = deferred();
  const release = deferred();
  const repository = new McpCompositeRepository(f.storage);
  const service = new McpCompositeWorkflowService(repository, {
    ...native,
    execute: async (...args) => {
      const outcome = await native.execute(...args);
      published.resolve();
      await release.promise;
      return outcome;
    },
  });
  const input = await f.command(await f.prepare());
  const action = { kind: "import-create" as const, input };
  const targets = await native.importPreflight(
    owner,
    { phaseId: "import", action },
    guard,
  );
  const plan = McpCompositePrepareSchema.parse({
    requestId: randomUUID(),
    reason: "Exact native import publication source proof",
    targets,
    phases: [{ kind: "native", id: "import", action: action.kind }],
    budgets: { admissions: 1, pageAttempts: targets.maxPages, models: {} },
  });
  const prepared = await service.prepare(owner, plan, guard);
  const bound = await service.bind(
    owner,
    {
      ...mutation(prepared),
      phaseId: "import",
      action,
      expectedSnapshot: prepared.snapshot.fingerprint,
      predecessorReceipts: [],
    },
    guard,
  );
  await service.run(owner, mutation(bound), guard);
  await Promise.race([
    published.promise,
    service.waitForCompletion(owner, prepared.id, guard).then(() => {
      throw new Error(
        "Native import settled without reaching its publication barrier.",
      );
    }),
  ]);
  const receipt = mcpLibraryImportOutputs.carrot_get_import_receipt.parse(
    await f.invoke("carrot_get_import_receipt", { requestId: input.requestId }),
  );
  const chapterPath = getChapterFilePath(receipt.workId, receipt.chapterIds[0]);
  const workPath = getWorkFilePath(receipt.workId);
  const guidePath = join(dirname(workPath), "style-guide.json");
  const memoryPath = join(dirname(chapterPath), "story-memory.json");
  const mutate = async (
    kind:
      | "membership"
      | "page-name"
      | "chapter-title"
      | "work-title"
      | "sfx-review"
      | "guide"
      | "memory",
  ) => {
    if (kind === "work-title") {
      const work = JSON.parse(await readFile(workPath, "utf8"));
      await writeFile(
        workPath,
        JSON.stringify({ ...work, title: "Later work title" }),
      );
      return;
    }
    if (kind === "guide" || kind === "memory") {
      const saved = await f.library.readWorkContextForEdit(
        receipt.chapterIds[0],
      );
      await writeFile(
        kind === "guide" ? guidePath : memoryPath,
        JSON.stringify(kind === "guide" ? saved.styleGuide : saved.storyMemory),
      );
      return;
    }
    const chapter: LibraryChapter = JSON.parse(
      await readFile(chapterPath, "utf8"),
    );
    const before = createPageRevision(chapter.pages[0]);
    changeChapter(chapter, kind);
    if (createPageRevision(chapter.pages[0]) !== before)
      throw new Error(
        "The regression must leave the original imported page revision unchanged.",
      );
    await writeFile(chapterPath, JSON.stringify(chapter));
  };
  return {
    ...f,
    owner,
    guard,
    native,
    service,
    repository,
    input,
    prepared,
    bound,
    receipt,
    release,
    mutate,
    changeFonts: () => {
      fontFingerprint = "b".repeat(64);
    },
    close: async () => {
      release.resolve();
      await service.close();
      await native.close();
      await f.close();
    },
  };
}

function changeChapter(
  chapter: LibraryChapter,
  kind: "membership" | "page-name" | "chapter-title" | "sfx-review",
) {
  if (kind === "membership") {
    const added = {
      ...structuredClone(chapter.pages[0]),
      id: randomUUID(),
      name: "Later sibling",
    };
    chapter.pages.push(added);
    chapter.pageOrder.push(added.id);
  } else if (kind === "page-name") {
    chapter.pages[0].name = "Later renamed page";
    chapter.pages[0].sourceFileName = "later-source.png";
  } else if (kind === "chapter-title") chapter.title = "Later chapter title";
  else
    chapter.pages[0].soundEffectReview = {
      contractVersion: 3,
      producer: "hayai-regions-v1",
      regions: [],
      regionOverrides: [],
      manualRegions: [],
      resolvedRegions: [],
    };
}
