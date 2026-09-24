import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { researchProposalFixture } from "./mcpResearchProposal.fixture";

it("deduplicates simultaneous preparation and keeps paginated returned reviews isolated", async () => {
  const f = await researchProposalFixture();
  try {
    const [first, second] = await Promise.all([f.prepare(), f.prepare()]);
    expect(second).toEqual(first);
    expect((await f.storage.index()).entries).toHaveLength(1);
    const repository = f.backend().repository;
    const page = await repository.inspect(
      "migration-owner",
      { proposalId: first.proposalId, offset: 0, limit: 1 },
      f.guard,
    );
    if (!page) throw new Error("Missing review page");
    expect(page.nextOffset).toBe(1);
    page.changes[0].after.target = "Mutated return value";
    expect(
      (await f.inspectReview(first.proposalId))?.changes[0].after.target,
    ).toBe("Reviewed name");
    const last = await repository.inspect(
      "migration-owner",
      { proposalId: first.proposalId, offset: 1, limit: 1 },
      f.guard,
    );
    expect(last).toMatchObject({
      nextOffset: null,
      changes: [{ changeId: "unselected" }],
    });
    const old = f.backend();
    await f.reconstruct();
    await expect(
      old.repository.optional("migration-owner", first.proposalId, f.guard),
    ).rejects.toThrow();
    await expect(
      old.application.apply(
        "migration-owner",
        {
          proposalId: first.proposalId,
          requestId: randomUUID(),
          selectedChangeIds: ["term"],
        },
        f.guard,
      ),
    ).rejects.toThrow();
    expect((await f.storage.index()).entries).toHaveLength(1);
  } finally {
    await f.close();
  }
});

it("rejects malformed or cross-request private records without expanding pending research into page memory", async () => {
  const f = await researchProposalFixture();
  const { RetainedResearchProposalSchema } =
    await import("../src/main/application/mcpResearchProposalState");
  try {
    const proposal = await f.prepare();
    const record = RetainedResearchProposalSchema.parse(
      await f.storage.record(proposal.proposalId),
    );
    const mutations = [
      { ...record, metadata: { ...record.metadata, chapterId: "different" } },
      {
        ...record,
        metadata: { ...record.metadata, changeIds: ["unexpected"] },
      },
      {
        ...record,
        options: {
          ...record.options,
          entryIds: [...record.options.entryIds, record.options.entryIds[0]],
        },
      },
      {
        ...record,
        options: { ...record.options, entryIds: [["term", randomUUID()]] },
      },
      {
        ...record,
        research: {
          target: {
            chapterId: "chapter",
            requestId: randomUUID(),
            revision: record.request.revision,
            engine: "tavily",
            researchTitle: "Different request",
          },
          queryCount: 0,
          sourceCount: 0,
          tavilyCreditsUsed: 0,
        },
      },
      {
        ...record,
        metadata: { ...record.metadata, expiresAt: record.createdAt },
      },
    ];
    for (const candidate of mutations)
      expect(RetainedResearchProposalSchema.safeParse(candidate).success).toBe(
        false,
      );
    const receipt = await f.applyReview(proposal.proposalId);
    if (!receipt?.recoveryId) throw new Error("Missing applied receipt");
    const applied = RetainedResearchProposalSchema.parse(
      await f.storage.record(proposal.proposalId),
    );
    if (!applied.applied) throw new Error("Missing applied review");
    expect(
      RetainedResearchProposalSchema.safeParse({
        ...applied,
        applied: { ...applied.applied, recoveryId: randomUUID() },
      }).success,
    ).toBe(false);
    const before = (await f.graph()).chapters.map(
      (chapter) => chapter.storyMemory.pages,
    );
    await f.reconstruct();
    expect(
      (await f.graph()).chapters.map((chapter) => chapter.storyMemory.pages),
    ).toEqual(before);
  } finally {
    await f.close();
  }
});

it("keeps preview ownership separate even when two approved owners reuse a request ID", async () => {
  const f = await researchProposalFixture();
  try {
    const first = await f.prepare();
    const other = await f
      .backend()
      .repository.prepare("another-owner", f.input, f.guard);
    expect(other.proposalId).not.toBe(first.proposalId);
    await expect(
      f.backend().repository.load("migration-owner", other.proposalId),
    ).rejects.toMatchObject({ code: "not_found" });
    expect((await f.storage.index()).entries).toHaveLength(2);
    const input = {
      proposalId: first.proposalId,
      requestId: randomUUID(),
      selectedChangeIds: ["term"],
    };
    const results = await Promise.allSettled([
      f.backend().application.apply("migration-owner", input, f.guard),
      f.backend().application.apply("migration-owner", input, f.guard),
    ]);
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
    expect(
      (await f.storage.index()).entries.filter(
        (entry) => entry.kind === "context",
      ),
    ).toHaveLength(1);
    expect(
      (await f.backend().application.apply("migration-owner", input, f.guard))
        ?.status,
    ).toBe("already_applied");
  } finally {
    await f.close();
  }
});
