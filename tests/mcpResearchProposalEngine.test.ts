import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { researchProposalFixture } from "./mcpResearchProposal.fixture";
import { createWorkContextResearchFingerprint } from "../src/shared/workContextResearchProposal";
import { contextMigrationSnapshot } from "../src/main/application/mcpContextMigrationPolicy";
import type { researchWorkContext } from "../src/main/workContextResearch";

type Fixture = Awaited<ReturnType<typeof researchProposalFixture>>;
async function runtime(f: Fixture) {
  const { McpContextProposalService } =
    await import("../src/main/application/mcpContextProposalService");
  const { withMcpContextEditScope } =
    await import("../src/main/mcp/mcpContextEditScope");
  const { createMcpContextResearchExecutor } =
    await import("../src/main/mcp/mcpContextResearchAdapter");
  const { McpOperationService } =
    await import("../src/main/application/mcpOperationService");
  const { repository, application } = f.backend();
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
  const research = vi.fn<typeof researchWorkContext>(async (request) => ({
    engine: request.engine,
    baseFingerprint: createWorkContextResearchFingerprint(
      request.guideSnapshot,
    ),
    operations: [
      {
        id: "operation-1",
        entity: "glossary",
        action: "add",
        reason: "Isolated referenced result",
        confidence: "high",
        selectedByDefault: true,
        evidence: { pageCount: 1, mentionCount: 1 },
        sources: [{ title: "Evidence", url: "https://example.com/engine" }],
        after: {
          id: "engine-entry",
          source: "Engine term",
          target: "Reviewed engine term",
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
  }));
  let journal: unknown = null;
  const errors: unknown[] = [];
  const open = () =>
    new McpOperationService((error) => errors.push(error), Date.now, {
      load: async () => structuredClone(journal),
      save: async (value) => {
        journal = JSON.parse(JSON.stringify(value));
      },
    });
  const target = {
    chapterId: "chapter",
    revision: f.input.request.revision,
    requestId: randomUUID(),
    researchTitle: "Explicit fixture work",
    engine: "tavily" as const,
  };
  return {
    proposals,
    research,
    open,
    target,
    errors,
    execute: createMcpContextResearchExecutor(f.app, proposals, research),
    journal: () => journal,
  };
}

it("retains app-engine evidence and exposes it through reconstructed public tools without researching again", async () => {
  const f = await researchProposalFixture();
  const r = await runtime(f);
  const operations = r.open();
  const next = r.open();
  try {
    const before = (await f.graph()).styleGuide;
    const request = {
      owner: "migration-owner",
      requestId: r.target.requestId,
      kind: "contextResearch",
      parameters: r.target,
      assertAuthorized: () => {},
      execute: (context: Parameters<typeof r.execute>[2]) =>
        r.execute("migration-owner", r.target, context),
    };
    const accepted = await operations.start(request);
    await operations.waitForCompletion(
      accepted.jobId,
      request.owner,
      new AbortController().signal,
    );
    const job = operations.status(accepted.jobId, request.owner);
    expect(job, JSON.stringify(r.errors)).toMatchObject({
      status: "completed",
    });
    const result = job.result?.contextResearch;
    if (!result) throw new Error("Missing research result");
    expect(result).toMatchObject({
      retention: "seven-days",
      queryCount: 2,
      sourceCount: 1,
    });
    const record = await f
      .backend()
      .repository.load(request.owner, result.proposalId);
    expect(record.research).toMatchObject({
      target: r.target,
      referenceSnapshot: record.referenceSnapshot,
      queryCount: 2,
    });
    await operations.close();
    await r.proposals.close();
    await f.restart();
    await next.ready();
    expect(
      next.status(accepted.jobId, request.owner).result?.retainedContextProposal
        ?.proposalId,
    ).toBe(result.proposalId);
    expect((await next.start(request)).jobId).toBe(accepted.jobId);
    expect(
      await f.invoke("carrot_get_context_proposal", {
        proposalId: result.proposalId,
      }),
    ).toMatchObject({
      retention: "seven-days",
      changes: [{ sources: [{ url: "https://example.com/engine" }] }],
    });
    expect(r.research).toHaveBeenCalledOnce();
    expect((await f.graph()).styleGuide).toEqual(before);
    expect(JSON.stringify(r.journal())).not.toMatch(
      /Reviewed engine term|example.com\/engine/,
    );
  } finally {
    await operations.close();
    await next.close();
    await r.proposals.close();
    await f.close();
  }
});

it("rejects original work evidence that changed before entering retained proposal admission", async () => {
  const f = await researchProposalFixture();
  const r = await runtime(f);
  try {
    const referenceSnapshot = contextMigrationSnapshot(
      await f.graph(),
      "chapter",
      () => {},
    ).snapshot;
    const second = JSON.parse(await readFile(f.secondPath, "utf8"));
    second.pages[0].blocks[0].glossaryEntryIds = ["changed-after-research"];
    await writeFile(f.secondPath, JSON.stringify(second));
    const input = { ...f.input.request, requestId: r.target.requestId };
    await expect(
      r.proposals.previewAppResearch(
        "migration-owner",
        input,
        f.input.evidence,
        [],
        () => {},
        {
          research: {
            target: r.target,
            referenceSnapshot,
            queryCount: 1,
            sourceCount: 1,
            tavilyCreditsUsed: 1,
          },
        },
      ),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    expect((await f.storage.index()).entries).toEqual([]);
    expect(r.research).not.toHaveBeenCalled();
  } finally {
    await r.proposals.close();
    await f.close();
  }
});
