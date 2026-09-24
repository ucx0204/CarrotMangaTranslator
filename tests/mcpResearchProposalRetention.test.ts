import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { mcpContextRevision } from "../src/shared/mcpContextEditing";
import { researchProposalFixture as setup } from "./mcpResearchProposal.fixture";

it("retains an encrypted pending review with stable IDs through reconstruction without editing the work", async () => {
  const f = await setup();
  try {
    const before = await readFile(f.chapterPath);
    const guide = (await f.graph()).styleGuide;
    const proposal = await f.prepare();
    const inspected = await f.inspectReview(proposal.proposalId);
    expect(inspected).toMatchObject({
      retention: "seven-days",
      total: 2,
      changes: [{ sources: [{ url: "https://example.com/research" }] }, {}],
    });
    expect(
      (await f.storage.index()).entries.map((entry) => entry.kind),
    ).toEqual(["research-proposal"]);
    const encrypted = await readFile(
      await f.storage.path(proposal.proposalId),
      "utf8",
    );
    expect(encrypted).not.toMatch(
      /Reviewed name|Research term|example.com\/research/,
    );
    await f.reconstruct();
    expect(await f.inspectReview(proposal.proposalId)).toEqual(inspected);
    expect(await f.prepare()).toEqual(proposal);
    expect(await readFile(f.chapterPath)).toEqual(before);
    expect((await f.graph()).styleGuide).toEqual(guide);
  } finally {
    await f.close();
  }
});

it("publishes selected context, applied proposal and durable Undo/Redo together and never repeats historical application", async () => {
  const f = await setup();
  try {
    const before = (await f.graph()).styleGuide;
    const chapter = await readFile(f.chapterPath);
    const proposal = await f.prepare();
    const review = await f.inspectReview(proposal.proposalId);
    await f.reconstruct();
    const requestId = randomUUID();
    const applied = await f.applyReview(
      proposal.proposalId,
      ["term"],
      requestId,
    );
    expect(applied).toMatchObject({
      status: "applied",
      changesApplied: 1,
      pagesChanged: 0,
      recoveryId: expect.any(String),
    });
    if (!applied?.recoveryId || !review)
      throw new Error("Missing retained application");
    const id = applied.recoveryId;
    const afterGraph = await f.graph();
    const anchor = afterGraph.chapters.find(
      (item) => item.chapter.id === "chapter",
    );
    if (!anchor) throw new Error("Missing fixture anchor");
    expect(applied.revision).toBe(
      mcpContextRevision({ ...afterGraph, storyMemory: anchor.storyMemory }),
    );
    const after = afterGraph.styleGuide;
    expect(after.glossary.at(-1)).toMatchObject({
      id: review.changes[0].targetId,
      target: "Reviewed name",
      origin: "ai",
    });
    expect(after.characters).toEqual(before.characters);
    expect(
      (await f.storage.index()).entries.map((entry) => entry.kind).sort(),
    ).toEqual(["context", "research-proposal"]);
    await f.reconstruct();
    expect((await f.inspectReview(proposal.proposalId))?.recoveryId).toBe(id);
    await f.recover(id, "undo");
    expect((await f.graph()).styleGuide).toEqual(before);
    expect(
      await f.applyReview(proposal.proposalId, ["term"], requestId),
    ).toEqual({ ...applied, status: "already_applied" });
    expect((await f.graph()).styleGuide).toEqual(before);
    await expect(
      f.applyReview(proposal.proposalId, ["unselected"]),
    ).rejects.toMatchObject({ code: "invalid_edit" });
    await f.recover(id, "redo");
    expect((await f.graph()).styleGuide).toEqual(after);
    expect(await readFile(f.chapterPath)).toEqual(chapter);
  } finally {
    await f.close();
  }
});

it("rejects changed whole-work evidence, foreign owners and reused request IDs without losing the pending review", async () => {
  const f = await setup();
  try {
    const proposal = await f.prepare();
    await expect(
      f.inspectReview(proposal.proposalId, "another-owner"),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      f.prepare({ ...f.input, warnings: ["Different request"] }),
    ).rejects.toMatchObject({ code: "invalid_edit" });
    const second = JSON.parse(await readFile(f.secondPath, "utf8"));
    second.pages[0].blocks[0].sourceText =
      "A later manual edit in another chapter";
    await writeFile(f.secondPath, JSON.stringify(second));
    const before = (await f.graph()).styleGuide;
    await expect(f.applyReview(proposal.proposalId)).rejects.toMatchObject({
      code: "revision_conflict",
    });
    expect((await f.graph()).styleGuide).toEqual(before);
    expect(
      (await f.inspectReview(proposal.proposalId))?.recoveryId,
    ).toBeUndefined();
    expect((await f.storage.index()).entries).toHaveLength(1);
  } finally {
    await f.close();
  }
});

it("discards only the owned retained review and preserves its separately retained recovery and applied context", async () => {
  const f = await setup();
  try {
    const before = (await f.graph()).styleGuide;
    const proposal = await f.prepare();
    const applied = await f.applyReview(proposal.proposalId);
    const after = (await f.graph()).styleGuide;
    await f.invoke("carrot_discard_retained", {
      id: proposal.proposalId,
      confirm: true,
    });
    expect(await f.inspectReview(proposal.proposalId)).toBeUndefined();
    expect((await f.graph()).styleGuide).toEqual(after);
    await f.reconstruct();
    if (!applied?.recoveryId) throw new Error("Missing retained recovery ID");
    await f.recover(applied.recoveryId, "undo");
    expect((await f.graph()).styleGuide).toEqual(before);
  } finally {
    await f.close();
  }
});

it("preserves a reviewed own-property __proto__ change ID across encrypted reconstruction", async () => {
  const f = await setup();
  try {
    f.input.request.changes = [
      {
        changeId: "__proto__",
        entity: "glossary",
        values: { source: "Special term", target: "Special target" },
      },
    ];
    f.input.evidence = [];
    const proposal = await f.prepare();
    const reviewed = await f.inspectReview(proposal.proposalId);
    if (!reviewed) throw new Error("Missing retained review");
    await f.reconstruct();
    await f.applyReview(proposal.proposalId, ["__proto__"]);
    expect((await f.graph()).styleGuide.glossary.at(-1)?.id).toBe(
      reviewed.changes[0].targetId,
    );
  } finally {
    await f.close();
  }
});
