import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { mcpContextOutputSchemas } from "../src/shared/mcpContextEditing";
import { mcpRetentionOutputs } from "../src/shared/mcpRetention";
import { researchProposalFixture } from "./mcpResearchProposal.fixture";

type Fixture = Awaited<ReturnType<typeof researchProposalFixture>>;
async function publicReview(f: Fixture) {
  return mcpContextOutputSchemas.carrot_preview_context_research.parse(
    await f.invoke("carrot_preview_context_research", {
      ...f.input.request,
      changes: f.input.request.changes.map((change) => ({
        change,
        reason: "Reviewed external evidence",
        sources: [{ title: "Reference", url: "https://example.com/review" }],
      })),
    }),
  );
}
const readReview = async (f: Fixture, proposalId: string) =>
  mcpContextOutputSchemas.carrot_get_context_proposal.parse(
    await f.invoke("carrot_get_context_proposal", { proposalId }),
  );
const catalog = async (f: Fixture, args: object = {}) =>
  mcpRetentionOutputs.carrot_list_context_proposals.parse(
    await f.invoke("carrot_list_context_proposals", args),
  );

it("applies only a public retained selection and recovers through restart without repeating historical writes", async () => {
  const f = await researchProposalFixture();
  try {
    const before = (await f.graph()).styleGuide;
    const chapter = await readFile(f.chapterPath);
    const second = await readFile(f.secondPath);
    const proposal = await publicReview(f);
    const reviewed = await readReview(f, proposal.proposalId);
    await f.restart();
    const command = {
      proposalId: proposal.proposalId,
      requestId: randomUUID(),
      selectedChangeIds: ["term"],
    };
    const applied = mcpContextOutputSchemas.carrot_apply_context_proposal.parse(
      await f.invoke("carrot_apply_context_proposal", command),
    );
    expect(applied).toMatchObject({ changesApplied: 1, pagesChanged: 0 });
    if (!applied.recoveryId) throw new Error("Missing mandatory recovery");
    const after = (await f.graph()).styleGuide;
    expect(after.glossary.at(-1)).toMatchObject({
      id: reviewed.changes[0].targetId,
      target: "Reviewed name",
    });
    expect(after.characters).toEqual(before.characters);
    await f.restart();
    expect((await readReview(f, proposal.proposalId)).recoveryId).toBe(
      applied.recoveryId,
    );
    await f.recover(applied.recoveryId, "undo");
    expect((await f.graph()).styleGuide).toEqual(before);
    expect(await f.invoke("carrot_apply_context_proposal", command)).toEqual({
      ...applied,
      status: "already_applied",
    });
    expect((await f.graph()).styleGuide).toEqual(before);
    await expect(
      f.invoke("carrot_apply_context_proposal", {
        ...command,
        requestId: randomUUID(),
        selectedChangeIds: ["unselected"],
      }),
    ).rejects.toThrow();
    await f.recover(applied.recoveryId, "redo");
    expect((await f.graph()).styleGuide).toEqual(after);
    expect(await readFile(f.chapterPath)).toEqual(chapter);
    expect(await readFile(f.secondPath)).toEqual(second);
    expect(f.errors).toEqual([]);
  } finally {
    await f.close();
  }
});

it("isolates the public catalog and invalidates pagination and lookup after explicit discard", async () => {
  const f = await researchProposalFixture();
  try {
    const first = await publicReview(f);
    f.input.request.requestId = randomUUID();
    const second = await publicReview(f);
    const page = await catalog(f, { limit: 1 });
    expect(page).toMatchObject({ total: 2, nextOffset: 1 });
    expect(
      (await catalog(f, { offset: 1, limit: 1, snapshot: page.snapshot }))
        .items,
    ).toHaveLength(1);
    expect(
      await f.invoke("carrot_list_context_proposals", {}, f.auth("other")),
    ).toMatchObject({ total: 0, items: [] });
    await expect(
      f.invoke(
        "carrot_get_context_proposal",
        {
          proposalId: first.proposalId,
        },
        f.auth("other"),
      ),
    ).rejects.toThrow();
    await expect(
      f.invoke(
        "carrot_apply_context_proposal",
        {
          proposalId: first.proposalId,
          requestId: randomUUID(),
          selectedChangeIds: ["term"],
        },
        f.auth("other"),
      ),
    ).rejects.toThrow();
    for (const input of [{ offset: 1 }, { limit: 0 }, { owner: "other" }])
      await expect(
        f.invoke("carrot_list_context_proposals", input),
      ).rejects.toThrow();
    await f.invoke("carrot_discard_retained", {
      id: first.proposalId,
      confirm: true,
    });
    await expect(
      catalog(f, { offset: 1, snapshot: page.snapshot }),
    ).rejects.toThrow();
    await f.restart();
    await expect(readReview(f, first.proposalId)).rejects.toThrow();
    expect((await catalog(f)).items.map((item) => item.id)).toEqual([
      second.proposalId,
    ]);
    expect(JSON.stringify(await catalog(f))).not.toMatch(
      /Reviewed name|Research term|example.com|imagePath/,
    );
  } finally {
    await f.close();
  }
});

it("keeps manual previews session-only and exposes retained reads with editing and processing disabled", async () => {
  const f = await researchProposalFixture();
  try {
    const retained = await publicReview(f);
    const manual = mcpContextOutputSchemas.carrot_preview_context_edit.parse(
      await f.invoke("carrot_preview_context_edit", {
        ...f.input.request,
        requestId: randomUUID(),
      }),
    );
    expect((await readReview(f, manual.proposalId)).retention).toBeUndefined();
    expect((await catalog(f)).total).toBe(1);
    f.preferences.allowEditing = false;
    f.preferences.allowProcessing = false;
    await f.restart();
    const names = f.current().tools.map((tool) => tool.name);
    expect(names).toContain("carrot_list_context_proposals");
    expect(names).not.toContain("carrot_apply_context_proposal");
    expect(names).not.toContain("carrot_run_context_research");
    expect((await readReview(f, retained.proposalId)).retention).toBe(
      "seven-days",
    );
    await expect(readReview(f, manual.proposalId)).rejects.toThrow();
    expect((await catalog(f)).total).toBe(1);
  } finally {
    await f.close();
  }
});

it("preserves later work edits and rejects retained application rather than falling back to session writes", async () => {
  const f = await researchProposalFixture();
  try {
    const proposal = await publicReview(f);
    const second = JSON.parse(await readFile(f.secondPath, "utf8"));
    second.pages[0].blocks[0].sourceText = "Later manual source";
    const edited = JSON.stringify(second);
    await writeFile(f.secondPath, edited);
    const guide = (await f.graph()).styleGuide;
    await f.restart();
    await expect(
      f.invoke("carrot_apply_context_proposal", {
        proposalId: proposal.proposalId,
        requestId: randomUUID(),
        selectedChangeIds: ["term"],
      }),
    ).rejects.toThrow("Saved work changed");
    expect((await f.graph()).styleGuide).toEqual(guide);
    expect(await readFile(f.secondPath, "utf8")).toBe(edited);
    expect((await f.storage.index()).entries).toHaveLength(1);
    expect(
      (await readReview(f, proposal.proposalId)).recoveryId,
    ).toBeUndefined();
  } finally {
    await f.close();
  }
});

it("reports expired retained reviews without extending them or reviving a session copy", async () => {
  let now = Date.now();
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  const f = await researchProposalFixture();
  try {
    const proposal = await publicReview(f);
    now = proposal.expiresAt;
    expect((await catalog(f)).items).toMatchObject([{ available: false }]);
    await expect(readReview(f, proposal.proposalId)).rejects.toThrow("expired");
    await expect(
      f.invoke("carrot_apply_context_proposal", {
        proposalId: proposal.proposalId,
        requestId: randomUUID(),
        selectedChangeIds: ["term"],
      }),
    ).rejects.toThrow("expired");
    await f.invoke("carrot_discard_retained", {
      id: proposal.proposalId,
      confirm: true,
    });
    expect((await catalog(f)).total).toBe(0);
  } finally {
    await f.close();
    clock.mockRestore();
  }
});
