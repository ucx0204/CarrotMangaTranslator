import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { researchProposalFixture } from "./mcpResearchProposal.fixture";

it("rolls back context, applied review and recovery together when authorization is revoked during encryption", async () => {
  const f = await researchProposalFixture();
  let authorized = true;
  const guard = () => {
    if (!authorized) throw new Error("Approval revoked during staging");
  };
  const seal = f.codec.seal;
  let hook: ReturnType<typeof vi.spyOn> | undefined;
  try {
    const proposal = await f.prepare();
    const before = (await f.graph()).styleGuide;
    const index = await f.storage.index();
    const review = await f.storage.record(proposal.proposalId);
    hook = vi.spyOn(f.codec, "seal").mockImplementation(async (value) => {
      const result = await seal(value);
      if (typeof value === "object" && value !== null && "applied" in value)
        authorized = false;
      return result;
    });
    await expect(
      f.backend().application.apply(
        "migration-owner",
        {
          proposalId: proposal.proposalId,
          requestId: randomUUID(),
          selectedChangeIds: ["term"],
        },
        guard,
      ),
    ).rejects.toThrow("revoked");
    expect(authorized).toBe(false);
    expect((await f.graph()).styleGuide).toEqual(before);
    expect(await f.storage.index()).toEqual(index);
    expect(await f.storage.record(proposal.proposalId)).toEqual(review);
  } finally {
    hook?.mockRestore();
    await f.close();
  }
});

it("fails closed when encryption fails while preserving the unapplied review and original files", async () => {
  const f = await researchProposalFixture();
  const seal = f.codec.seal;
  let hook: ReturnType<typeof vi.spyOn> | undefined;
  try {
    const proposal = await f.prepare();
    const before = (await f.graph()).styleGuide;
    const chapter = await readFile(f.chapterPath);
    const index = await f.storage.index();
    hook = vi.spyOn(f.codec, "seal").mockImplementation(async (value) => {
      if (typeof value === "object" && value !== null && "applied" in value)
        throw new Error("Synthetic encryption failure");
      return seal(value);
    });
    await expect(f.applyReview(proposal.proposalId)).rejects.toThrow(
      "encryption failure",
    );
    expect(await f.storage.index()).toEqual(index);
    expect(
      (await f.inspectReview(proposal.proposalId))?.recoveryId,
    ).toBeUndefined();
    expect((await f.graph()).styleGuide).toEqual(before);
    expect(await readFile(f.chapterPath)).toEqual(chapter);
  } finally {
    hook?.mockRestore();
    await f.close();
  }
});

it("rejects expiry during coupled publication without saving context or an applied receipt", async () => {
  let now = Date.now();
  const f = await researchProposalFixture(() => now);
  const seal = f.codec.seal;
  let hook: ReturnType<typeof vi.spyOn> | undefined;
  try {
    const proposal = await f.prepare();
    const before = (await f.graph()).styleGuide;
    const pending = await f.storage.record(proposal.proposalId);
    hook = vi.spyOn(f.codec, "seal").mockImplementation(async (value) => {
      const result = await seal(value);
      if (typeof value === "object" && value !== null && "applied" in value)
        now += 8 * 24 * 60 * 60_000;
      return result;
    });
    await expect(f.applyReview(proposal.proposalId)).rejects.toThrow(/expired/);
    expect((await f.graph()).styleGuide).toEqual(before);
    expect(await f.storage.record(proposal.proposalId)).toEqual(pending);
    expect((await f.storage.index()).entries).toHaveLength(1);
    await expect(f.inspectReview(proposal.proposalId)).rejects.toThrow(
      /expired/,
    );
  } finally {
    hook?.mockRestore();
    await f.close();
  }
});

for (const point of ["after-replace-step", "after-commit-point"] as const) {
  it(`restores a consistent review/context/index after ${point}`, async () => {
    const f = await researchProposalFixture();
    const tx = await import("../src/main/libraryStore/libraryTransaction");
    const { recoverLibraryTransactions } =
      await import("../src/main/libraryStore/libraryTransactionRecovery");
    let reset = () => {};
    try {
      const proposal = await f.prepare();
      const before = (await f.graph()).styleGuide;
      const pending = await f.storage.record(proposal.proposalId);
      const requestId = randomUUID();
      let crashed = false;
      reset = tx.setLibraryTransactionCrashInjectorForTests((position) => {
        if (position === point) {
          crashed = true;
          throw new tx.SimulatedLibraryTransactionCrash(position);
        }
      });
      await f
        .applyReview(proposal.proposalId, ["term"], requestId)
        .catch((error: unknown) => {
          if (!(error instanceof tx.SimulatedLibraryTransactionCrash))
            throw error;
        });
      expect(crashed).toBe(true);
      reset();
      await recoverLibraryTransactions();
      await f.reconstruct();
      const entries = (await f.storage.index()).entries;
      expect(
        entries.filter((entry) => entry.kind === "research-proposal"),
      ).toHaveLength(1);
      if (point === "after-commit-point") {
        expect(
          entries.filter((entry) => entry.kind === "context"),
        ).toHaveLength(1);
        const replay = await f.applyReview(
          proposal.proposalId,
          ["term"],
          requestId,
        );
        expect(replay?.status).toBe("already_applied");
        if (!replay?.recoveryId) throw new Error("Missing committed recovery");
        expect((await f.inspect(replay.recoveryId)).canUndo).toBe(true);
        await f.recover(replay.recoveryId, "undo");
      } else {
        expect(
          entries.filter((entry) => entry.kind === "context"),
        ).toHaveLength(0);
        expect(await f.storage.record(proposal.proposalId)).toEqual(pending);
      }
      expect((await f.graph()).styleGuide).toEqual(before);
    } finally {
      reset();
      await f.close();
    }
  });
}

it("retains app research provenance and leaves a no-op applied proposal recoverably unchanged", async () => {
  const f = await researchProposalFixture();
  try {
    const guide = (await f.graph()).styleGuide;
    const entry = guide.characters[0];
    f.input.source = "app-research";
    f.input.request.changes = [
      {
        changeId: "same",
        entity: "character",
        entryId: entry.id,
        values: { displayName: entry.displayName },
      },
    ];
    f.input.evidence = [];
    f.input.research = {
      target: {
        chapterId: "chapter",
        requestId: f.input.request.requestId,
        revision: f.input.request.revision,
        researchTitle: "Explicit synthetic title",
        engine: "tavily",
      },
      queryCount: 4,
      sourceCount: 6,
      tavilyCreditsUsed: 2,
    };
    const proposal = await f.prepare();
    await f.reconstruct();
    expect(await f.storage.record(proposal.proposalId)).toMatchObject({
      research: f.input.research,
    });
    const applied = await f.applyReview(proposal.proposalId, ["same"]);
    expect(applied?.changesApplied).toBe(0);
    if (!applied?.recoveryId) throw new Error("Missing no-op receipt");
    expect((await f.inspect(applied.recoveryId)).canUndo).toBe(false);
    expect((await f.graph()).styleGuide).toEqual(guide);
  } finally {
    await f.close();
  }
});
