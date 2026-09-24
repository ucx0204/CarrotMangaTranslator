import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { vi } from "vitest";
import { researchProposalFixture } from "./mcpResearchProposal.fixture";
import { createWorkContextResearchFingerprint } from "../src/shared/workContextResearchProposal";
import { mcpContextRevision } from "../src/shared/mcpContextEditing";
import {
  McpResearchBatchPrepareSchema,
  mcpResearchBatchOutputs,
} from "../src/shared/mcpResearchBatch";
import { contextMigrationSnapshot } from "../src/main/application/mcpContextMigrationPolicy";
import type { researchWorkContext } from "../src/main/workContextResearch";

async function seedWork(
  f: Awaited<ReturnType<typeof researchProposalFixture>>,
  index: number,
) {
  const workId = `batch-work-${index}`;
  const chapterId = `batch-chapter-${index}`;
  const chapter: Awaited<ReturnType<typeof f.library.openChapter>> = JSON.parse(
    await readFile(f.chapterPath, "utf8"),
  );
  const directory = join(
    f.env.libraryDir,
    "works",
    workId,
    "chapters",
    chapterId,
  );
  await mkdir(join(directory, "pages"), { recursive: true });
  for (const page of chapter.pages) {
    const bytes = await readFile(page.imagePath);
    page.imagePath = join(directory, "pages", `${page.id}.png`);
    page.inpaintedImagePath = undefined;
    page.inpaintMaskPath = undefined;
    await writeFile(page.imagePath, bytes);
  }
  await writeFile(
    join(directory, "chapter.json"),
    JSON.stringify({ ...chapter, id: chapterId, workId }),
  );
  const work = JSON.parse(
    await readFile(
      join(f.env.libraryDir, "works", "work", "work.json"),
      "utf8",
    ),
  );
  await writeFile(
    join(f.env.libraryDir, "works", workId, "work.json"),
    JSON.stringify({
      ...work,
      id: workId,
      title: `Batch work ${index}`,
      chapterOrder: [chapterId],
    }),
  );
  const indexPath = join(f.env.libraryDir, "index.json");
  const libraryIndex = JSON.parse(await readFile(indexPath, "utf8"));
  libraryIndex.workOrder.push(workId);
  await writeFile(indexPath, JSON.stringify(libraryIndex));
  await f.library.openChapter(chapterId);
  return chapterId;
}

export async function researchBatchFixture(workCount = 3) {
  const f = await researchProposalFixture();
  const { McpContextProposalService } =
    await import("../src/main/application/mcpContextProposalService");
  const { McpOperationService } =
    await import("../src/main/application/mcpOperationService");
  const { withMcpContextEditScope } =
    await import("../src/main/mcp/mcpContextEditScope");
  const { createMcpContextResearchExecutor } =
    await import("../src/main/mcp/mcpContextResearchAdapter");
  const { createMcpResearchBatchSession } =
    await import("../src/main/mcp/mcpResearchBatchSession");
  const { McpResearchBatchRepository } =
    await import("../src/main/mcp/mcpResearchBatchRepository");
  const { McpResearchProposalRepository } =
    await import("../src/main/mcp/mcpResearchProposalRepository");
  const { McpResearchProposalApplication } =
    await import("../src/main/mcp/mcpResearchProposalApplication");
  const { readWorkContextReferences } =
    await import("../src/main/library/libraryContextEditingFacade");
  const { mcpToolResult } = await import("../src/main/mcp/mcpToolResult");
  const { McpEditError } =
    await import("../src/main/application/mcpEditPolicy");
  const chapterIds = ["chapter"];
  for (let index = 1; index < workCount; index++)
    chapterIds.push(await seedWork(f, index));
  let allowed = true;
  const errors: unknown[] = [];
  const guard = () => {
    if (!allowed) throw new McpEditError("access_denied", "Test grant revoked");
  };
  const auth = (principalId = "migration-owner") => ({
    principalId,
    assertAuthorized: guard,
    assertScopes: guard,
    assertJobAuthorized: guard,
  });
  // Only the external research engine is replaced. All native locks, conversion,
  // transactions, owned tools, encryption and operation journal code execute.
  const research = vi.fn<typeof researchWorkContext>(
    async (request, signal) => {
      signal?.throwIfAborted();
      return {
        engine: request.engine,
        baseFingerprint: createWorkContextResearchFingerprint(
          request.guideSnapshot,
        ),
        operations: [
          {
            id: "op",
            entity: "glossary",
            action: "add",
            reason: "Synthetic evidence",
            confidence: "high",
            selectedByDefault: true,
            evidence: { pageCount: 1, mentionCount: 1 },
            sources: [
              { title: "Evidence", url: "https://example.com/batch-source" },
            ],
            after: {
              id: "native-entry",
              source: "Batch term",
              target: "Reviewed batch term",
              category: "term",
              enabled: true,
              origin: "ai",
              createdAt: "2026-09-20T00:00:00.000Z",
              updatedAt: "2026-09-20T00:00:00.000Z",
            },
          },
        ],
        warnings: [],
        stats: {
          queryCount: 2,
          sourceCount: 1,
          tavilyCreditsUsed: 1,
          estimatedTokenDelta: 10,
          elapsedMs: 1,
        },
      };
    },
  );
  let journal: unknown = null;
  const open = () => {
    const lifetime = new AbortController();
    const operations = new McpOperationService(
      (error) => errors.push(error),
      Date.now,
      {
        load: async () => structuredClone(journal),
        save: async (value) => {
          journal = JSON.parse(JSON.stringify(value));
        },
      },
    );
    const repository = new McpResearchProposalRepository(
      f.storage,
      lifetime.signal,
    );
    const application = new McpResearchProposalApplication(
      repository,
      f.app,
      f.editing,
      lifetime.signal,
    );
    const proposals = new McpContextProposalService({
      read: f.library.readWorkContextForEdit,
      commit: f.library.commitWorkContextEdit,
      withEdit: withMcpContextEditScope,
      retained: {
        prepare: repository.prepare.bind(repository),
        inspect: repository.inspect.bind(repository),
        apply: application.apply.bind(application),
      },
    });
    const batch = createMcpResearchBatchSession({
      app: f.app,
      operations,
      storage: f.storage,
      lifetime: lifetime.signal,
      enabled: true,
      execute: createMcpContextResearchExecutor(f.app, proposals, research),
      reportError: (error) => errors.push(error),
    });
    return { batch, operations, proposals, lifetime, repository };
  };
  let current = open();
  await current.operations.ready();
  const closeCurrent = async () => {
    current.batch.stop();
    current.operations.stop();
    current.proposals.stop();
    await current.batch.close();
    await current.operations.close();
    await current.proposals.close();
    current.lifetime.abort();
  };
  const invoke = async (name: string, args: object, caller = auth()) => {
    const tool = current.batch.tools.find((item) => item.name === name);
    if (!tool) throw new Error(`Missing batch tool ${name}`);
    const result = mcpToolResult(
      tool,
      await tool.invoke(args as Record<string, unknown>, caller),
    );
    if (result.isError)
      throw new Error(JSON.stringify(result.structuredContent));
    return result.structuredContent;
  };
  const input = async () =>
    McpResearchBatchPrepareSchema.parse({
      requestId: randomUUID(),
      works: await Promise.all(
        chapterIds.map(async (chapterId, index) => {
          const graph = await readWorkContextReferences(chapterId, guard);
          const anchor = graph.chapters.find(
            (item) => item.chapter.id === chapterId,
          );
          if (!anchor) throw new Error("Missing native anchor");
          return {
            chapterId,
            workId: graph.workId,
            researchTitle: `Explicit work ${index}`,
            revision: mcpContextRevision({
              ...graph,
              storyMemory: anchor.storyMemory,
            }),
            referenceSnapshot: contextMigrationSnapshot(graph, chapterId, guard)
              .snapshot,
            engine: "tavily",
            titleConfirmed: true,
            allowSpoilers: true,
          };
        }),
      ),
    });
  const get = async (id: string) =>
    mcpResearchBatchOutputs.carrot_get_research_batch.parse(
      await invoke("carrot_get_research_batch", { id }),
    );
  const prepare = async (value?: Awaited<ReturnType<typeof input>>) =>
    mcpResearchBatchOutputs.carrot_prepare_research_batch.parse(
      await invoke("carrot_prepare_research_batch", value ?? (await input())),
    );
  const run = async (id: string, retryFailed = false) => {
    const version = (await get(id)).version;
    return invoke("carrot_run_research_batch", {
      id,
      version,
      requestId: randomUUID(),
      retryFailed,
      allowExternal: true,
      allowAssetDownloads: true,
    });
  };
  const settle = async (id: string) => {
    await vi.waitFor(
      async () => {
        if ((await get(id)).status === "running")
          throw new Error("Research batch is settling");
      },
      { timeout: 15000, interval: 20 },
    );
    return get(id);
  };
  return {
    ...f,
    research,
    errors,
    auth,
    invoke,
    input,
    get,
    prepare,
    run,
    settle,
    chapterIds,
    nativeInvoke: f.invoke,
    planRepository: new McpResearchBatchRepository(f.storage),
    current: () => current,
    revoke: () => {
      allowed = false;
    },
    restoreGrant: () => {
      allowed = true;
    },
    restartBatch: async () => {
      await closeCurrent();
      current = open();
      await current.operations.ready();
    },
    close: async () => {
      await closeCurrent();
      await f.close();
    },
  };
}
