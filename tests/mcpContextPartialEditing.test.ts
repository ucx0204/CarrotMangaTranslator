import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { contextHttpFixture } from "./mcpContextHttp.fixture";
import { mcpContextRevision } from "../src/shared/mcpContextEditing";
import { createPageRevision } from "../src/shared/pageRevision";

it("updates only selected entry fields and disables characters without removing memory references", async () => {
  const f = await contextHttpFixture();
  try {
    const original = await f.library.readWorkContextForEdit("chapter");
    const time = "2026-09-17T00:00:00.000Z";
    await f.library.saveWorkStyleGuide({
      ...original.styleGuide,
      glossary: [
        {
          id: "term",
          source: "Hero",
          target: "Old target",
          category: "name",
          aliases: ["Alias"],
          note: "User note",
          origin: "manual",
          enabled: true,
          createdAt: time,
          updatedAt: time,
        },
      ],
      characters: [
        {
          id: "hero",
          displayName: "Hero",
          sourceNames: ["Hero"],
          targetName: "Old name",
          aliases: ["Nickname"],
          speechStyle: "polite",
          note: "Fixed voice",
          enabled: true,
          origin: "manual",
          createdAt: time,
          updatedAt: time,
        },
      ],
    });
    await f.library.saveChapterStoryMemory({
      ...original.storyMemory,
      pages: [
        {
          pageId: "page",
          pageName: "page.png",
          pageIndex: 0,
          summary: "Saved summary",
          sourceDigest: "Saved source evidence",
          translatedDigest: "Saved translation evidence",
          glossaryEntryIds: ["term"],
          characterIds: ["hero"],
          updatedAt: time,
        },
      ],
    });
    const before = await f.library.readWorkContextForEdit("chapter");
    const files = await f.snapshot();
    const preview = await f.call("carrot_preview_context_edit", {
      chapterId: "chapter",
      revision: mcpContextRevision(before),
      requestId: randomUUID(),
      changes: [
        {
          changeId: "term",
          entity: "glossary",
          entryId: "term",
          values: { target: "New target" },
        },
        {
          changeId: "character",
          entity: "character",
          entryId: "hero",
          values: { enabled: false },
        },
      ],
    });
    expect(preview.result.isError).toBe(false);
    const proposal = preview.result.structuredContent;
    const applied = await f.call("carrot_apply_context_proposal", {
      proposalId: proposal.proposalId,
      requestId: randomUUID(),
      selectedChangeIds: proposal.changeIds,
    });
    expect(applied.result.isError).toBe(false);
    const after = await f.library.readWorkContextForEdit("chapter");
    expect(after.styleGuide.glossary[0]).toEqual({
      ...before.styleGuide.glossary[0],
      target: "New target",
      updatedAt: after.styleGuide.glossary[0].updatedAt,
    });
    expect(after.styleGuide.characters).toEqual([
      {
        ...before.styleGuide.characters[0],
        enabled: false,
        updatedAt: after.styleGuide.characters[0].updatedAt,
      },
    ]);
    expect(after.styleGuide.rules).toEqual(before.styleGuide.rules);
    expect(after.storyMemory).toEqual(before.storyMemory);
    expect(await f.snapshot()).toEqual(files);
    expect(f.research).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it("retains orphaned memory rows while adding a reviewed memory for an actual current page", async () => {
  const f = await contextHttpFixture();
  try {
    const original = await f.library.readWorkContextForEdit("chapter");
    const orphan = {
      pageId: "deleted-page",
      pageName: "old.png",
      pageIndex: 3,
      summary: "Do not silently drop this",
      sourceDigest: "old",
      translatedDigest: "old",
      updatedAt: original.storyMemory.updatedAt,
    };
    await f.library.saveChapterStoryMemory({
      ...original.storyMemory,
      pages: [orphan],
    });
    const before = await f.library.readWorkContextForEdit("chapter");
    const preview = await f.call("carrot_preview_context_edit", {
      chapterId: "chapter",
      revision: mcpContextRevision(before),
      requestId: randomUUID(),
      changes: [
        {
          changeId: "memory",
          entity: "memory",
          pageId: "page",
          pageRevision: createPageRevision(f.after),
          values: { summary: "Manual current-page summary" },
        },
      ],
    });
    expect(preview.result.isError).toBe(false);
    const proposal = preview.result.structuredContent;
    const applied = await f.call("carrot_apply_context_proposal", {
      proposalId: proposal.proposalId,
      requestId: randomUUID(),
      selectedChangeIds: ["memory"],
    });
    expect(applied.result.isError).toBe(false);
    const after = await f.library.readWorkContextForEdit("chapter");
    expect(after.storyMemory.pages).toHaveLength(2);
    expect(after.storyMemory.pages[0]).toEqual(orphan);
    expect(after.storyMemory.pages[1]).toMatchObject({
      pageId: "page",
      summary: "Manual current-page summary",
    });
    expect(after.styleGuide).toEqual(before.styleGuide);
  } finally {
    await f.close();
  }
});

it("rechecks authorization at transaction publication and does not publish either file after revocation", async () => {
  const f = await contextHttpFixture();
  let revoked = false;
  try {
    await expect(
      f.library.commitWorkContextEdit(
        "chapter",
        (current) => {
          revoked = true;
          return {
            styleGuide: {
              ...current.styleGuide,
              rules: { ...current.styleGuide.rules, sfxMode: "note" as const },
            },
            storyMemory: {
              ...current.storyMemory,
              aiAnalyzedAt: "2026-09-17T00:00:00.000Z",
            },
            result: null,
          };
        },
        () => {
          if (revoked)
            throw new Error("authorization revoked before publication");
        },
      ),
    ).rejects.toThrow("authorization revoked");
    const directory = join(f.environment.libraryDir, "works", "work");
    await expect(
      access(join(directory, "style-guide.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      access(join(directory, "chapters", "chapter", "story-memory.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const context = await f.library.readWorkContextForEdit("chapter");
    expect(context.styleGuide.rules.sfxMode).toBe("translate");
    expect(context.storyMemory.aiAnalyzedAt).toBeUndefined();
  } finally {
    await f.close();
  }
});
