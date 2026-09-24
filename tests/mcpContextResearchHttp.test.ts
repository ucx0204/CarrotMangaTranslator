import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { contextHttpFixture } from "./mcpContextHttp.fixture";
import { mcpContextRevision } from "../src/shared/mcpContextEditing";

it("returns only research metadata until explicit review and applies selected context without page writes", async () => {
  const f = await contextHttpFixture();
  try {
    const before = await f.snapshot();
    const response = await f.call("carrot_run_context_research", f.target);
    expect(response.result.isError).toBe(false);
    const jobId = response.result.structuredContent.jobId;
    const job = await f.settle(jobId);
    expect(job).toMatchObject({
      status: "completed",
      kind: "contextResearch",
      target: { researchTitle: "Synthetic work" },
      result: { pagesChanged: 0, proposalExpired: false, status: "proposed" },
    });
    const proposal = job.result.contextResearch;
    expect(proposal).toMatchObject({
      source: "app-research",
      queryCount: 1,
      sourceCount: 1,
    });
    expect(await f.snapshot()).toEqual(before);
    expect(
      (await f.library.readWorkContextForEdit("chapter")).styleGuide.glossary,
    ).toEqual([]);
    const inspected = await f.call("carrot_get_context_proposal", {
      proposalId: proposal.proposalId,
    });
    expect(inspected.result.isError).toBe(false);
    expect(inspected.result.structuredContent.changes[0]).toMatchObject({
      entity: "glossary",
      changed: true,
      before: null,
      after: { source: "Research hero" },
      sources: [{ url: "https://example.com/reference" }],
    });
    expect(
      (await f.call("carrot_run_context_research", f.target)).result
        .structuredContent.jobId,
    ).toBe(jobId);
    expect(f.research).toHaveBeenCalledOnce();
    const args = {
      proposalId: proposal.proposalId,
      requestId: randomUUID(),
      selectedChangeIds: proposal.changeIds,
    };
    const applied = await f.call("carrot_apply_context_proposal", args);
    expect(applied.result.isError).toBe(false);
    expect(applied.result.structuredContent).toMatchObject({
      status: "applied",
      changesApplied: 1,
      pagesChanged: 0,
    });
    const current = await f.library.readWorkContextForEdit("chapter");
    expect(current.styleGuide.glossary[0]).toMatchObject({
      source: "Research hero",
      target: "Reviewed hero",
      origin: "ai",
    });
    expect(current.storyMemory.pages).toEqual([]);
    expect(mcpContextRevision(current)).toBe(
      applied.result.structuredContent.revision,
    );
    expect(
      (await f.call("carrot_apply_context_proposal", args)).result
        .structuredContent.status,
    ).toBe("already_applied");
    expect(await f.snapshot()).toEqual(before);
    for (const item of [
      response,
      inspected,
      applied,
      await f.call("carrot_get_job", { jobId }),
      await f.call("carrot_list_jobs", {}),
    ]) {
      expect(item.result.content).toHaveLength(1);
      expect(JSON.stringify(item)).not.toMatch(
        /resource_link|image\/png|apiKey|imagePath|PRIVATE-/,
      );
      expect(JSON.stringify(item)).not.toContain(f.environment.root);
    }
    expect(JSON.stringify(f.stored())).not.toMatch(
      /Reviewed hero|Synthetic referenced result|example.com\/reference|contextResearch":\{/,
    );
    const next = await f.restart();
    const owner = f.provider.connectionIdFor(`Bearer ${f.full}`);
    if (!owner) throw new Error("Missing fixture owner");
    expect(next.status(jobId, owner).result).toMatchObject({
      proposalExpired: true,
      queryCount: 1,
      sourceCount: 1,
    });
    expect(next.status(jobId, owner).result?.contextResearch).toBeUndefined();
    await next.close();
    expect(f.jobs.gate.activities).toEqual([]);
  } finally {
    await f.close();
  }
});

it("enforces processing/edit scopes, proposal ownership and strict input schemas", async () => {
  const f = await contextHttpFixture();
  try {
    const before = await f.snapshot();
    const listed = await f.rpc("tools/list", {}, f.read);
    const names = listed.result.tools.map(
      (tool: { name: string }) => tool.name,
    );
    expect(names).toContain("carrot_preview_context_edit");
    expect(names).not.toContain("carrot_apply_context_proposal");
    expect(names).not.toContain("carrot_run_context_research");
    expect(
      (await f.call("carrot_run_context_research", f.target, f.read)).error
        .code,
    ).toBe(-32602);
    for (const args of [
      [],
      12,
      { ...f.target, force: true },
      { ...f.target, engine: "unknown" },
      { ...f.target, researchTitle: "" },
    ])
      expect(
        (await f.call("carrot_run_context_research", args)).error.code,
      ).toBe(-32602);
    expect(f.research).not.toHaveBeenCalled();
    const preview = await f.call("carrot_preview_context_edit", {
      chapterId: "chapter",
      revision: f.target.revision,
      requestId: randomUUID(),
      changes: [
        { changeId: "r", entity: "rules", values: { sfxMode: "note" } },
      ],
    });
    expect(preview.result.isError).toBe(false);
    const proposalId = preview.result.structuredContent.proposalId;
    expect(
      (await f.call("carrot_get_context_proposal", { proposalId }, f.other))
        .result.structuredContent.error,
    ).toBe("not_found");
    expect(
      (
        await f.call(
          "carrot_apply_context_proposal",
          { proposalId, requestId: randomUUID(), selectedChangeIds: ["r"] },
          f.read,
        )
      ).error.code,
    ).toBe(-32602);
    for (const selectedChangeIds of [["r", "r"], ["absent"]])
      expect(
        (
          await f.call("carrot_apply_context_proposal", {
            proposalId,
            requestId: randomUUID(),
            selectedChangeIds,
          })
        ).result.structuredContent.error,
      ).toBe("invalid_edit");
    expect(await f.snapshot()).toEqual(before);
  } finally {
    await f.close();
  }
});

it("accepts external research as unverified evidence and does not run a research model or create memory", async () => {
  const f = await contextHttpFixture();
  try {
    const before = await f.snapshot();
    const response = await f.call("carrot_preview_context_research", {
      chapterId: "chapter",
      revision: f.target.revision,
      requestId: randomUUID(),
      changes: [
        {
          change: {
            changeId: "g",
            entity: "glossary",
            values: { source: "External term", target: "External target" },
          },
          reason: "Caller inspected a source",
          sources: [
            { title: "Caller-supplied", url: "https://example.com/caller" },
          ],
        },
      ],
    });
    expect(response.result.isError).toBe(false);
    const preview = response.result.structuredContent;
    expect(preview.source).toBe("external-research");
    expect(preview.warnings.join(" ")).toContain("not fetched or verified");
    expect(f.research).not.toHaveBeenCalled();
    expect(await f.snapshot()).toEqual(before);
    expect(
      (await f.library.readWorkContextForEdit("chapter")).storyMemory.pages,
    ).toEqual([]);
  } finally {
    await f.close();
  }
});

it("cancels research without creating a proposal and holds its shared leases until the engine settles", async () => {
  const f = await contextHttpFixture();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = f.research.getMockImplementation();
  if (!original) throw new Error("Missing research fixture");
  f.research.mockImplementationOnce(async (...args) => {
    entered();
    await pending;
    return original(...args);
  });
  try {
    const before = await f.snapshot();
    const result = await f.call("carrot_run_context_research", f.target);
    const jobId = result.result.structuredContent.jobId;
    await started;
    expect(f.jobs.gate.activities.length).toBeGreaterThan(0);
    expect(
      (await f.call("carrot_cancel_job", { jobId })).result.structuredContent,
    ).toMatchObject({ status: "running", cancellationRequested: true });
    expect(f.jobs.gate.activities.length).toBeGreaterThan(0);
    expect(
      (
        await f.call("carrot_run_context_research", {
          ...f.target,
          requestId: randomUUID(),
        })
      ).result.structuredContent.error,
    ).toBe("editor_busy");
    release();
    const job = await f.settle(jobId);
    expect(job.status).toBe("cancelled");
    expect(job.result?.contextResearch).toBeUndefined();
    expect(f.jobs.gate.activities).toEqual([]);
    const retry = await f.call("carrot_retry_job", {
      jobId,
      requestId: randomUUID(),
      revision: "page-v1:0000000000000000",
    });
    expect(retry.result.structuredContent.error).toBe("invalid_edit");
    expect(f.research).toHaveBeenCalledOnce();
    expect(await f.snapshot()).toEqual(before);
  } finally {
    release();
    await f.close();
  }
});
