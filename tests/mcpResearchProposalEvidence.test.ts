import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { researchProposalFixture } from "./mcpResearchProposal.fixture";

it("does not mistake a missing research review for another retained record or a valid application", async () => {
  const f = await researchProposalFixture();
  const { researchContextSnapshot } =
    await import("../src/main/application/mcpResearchProposalPolicy");
  try {
    const missing = randomUUID();
    expect(await f.inspectReview(missing)).toBeUndefined();
    expect(await f.applyReview(missing)).toBeUndefined();
    const graph = await f.graph();
    expect(() =>
      researchContextSnapshot({ ...graph, chapters: [] }, "missing"),
    ).toThrow("anchor");
    expect((await f.storage.index()).entries).toEqual([]);
  } finally {
    await f.close();
  }
});

it("rejects a saved-work edit during encryption of the pending review without publishing stale research", async () => {
  const f = await researchProposalFixture();
  const seal = f.codec.seal;
  let changed = false;
  const hook = vi.spyOn(f.codec, "seal").mockImplementation(async (value) => {
    const encrypted = await seal(value);
    if (
      !changed &&
      typeof value === "object" &&
      value !== null &&
      "metadata" in value
    ) {
      changed = true;
      const chapter = JSON.parse(await readFile(f.secondPath, "utf8"));
      chapter.pages[0].blocks[0].translatedText =
        "Later manual text must survive";
      await writeFile(f.secondPath, JSON.stringify(chapter));
    }
    return encrypted;
  });
  try {
    const before = (await f.graph()).styleGuide;
    await expect(f.prepare()).rejects.toMatchObject({
      code: "revision_conflict",
    });
    expect(changed).toBe(true);
    expect((await f.storage.index()).entries).toEqual([]);
    expect((await f.graph()).styleGuide).toEqual(before);
    expect(
      JSON.parse(await readFile(f.secondPath, "utf8")).pages[0].blocks[0]
        .translatedText,
    ).toBe("Later manual text must survive");
  } finally {
    hook.mockRestore();
    await f.close();
  }
});

it("rejects a schema-valid encrypted review whose identity disagrees with its retained index", async () => {
  const f = await researchProposalFixture();
  try {
    const proposal = await f.prepare();
    const path = await f.storage.path(proposal.proposalId);
    const original = await readFile(path);
    const record = await f.storage.record(proposal.proposalId);
    if (!record || typeof record !== "object" || !("createdAt" in record))
      throw new Error("Missing fixture record");
    await writeFile(
      path,
      JSON.stringify(
        await f.codec.seal({
          ...record,
          createdAt: Number(record.createdAt) + 1,
        }),
      ),
    );
    await expect(f.inspectReview(proposal.proposalId)).rejects.toMatchObject({
      code: "invalid_edit",
    });
    await writeFile(path, original);
    expect((await f.inspectReview(proposal.proposalId))?.proposalId).toBe(
      proposal.proposalId,
    );
  } finally {
    await f.close();
  }
});
