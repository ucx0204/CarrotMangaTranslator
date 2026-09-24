import { randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { recoveryLibrary } from "./mcpErasureRecovery.fixture";
import { createPageRevision } from "../src/shared/pageRevision";
import { mcpContextRevision } from "../src/shared/mcpContextEditing";

const authorize = () => {};
async function setup() {
  const f = await recoveryLibrary();
  const { McpContextProposalService } =
    await import("../src/main/application/mcpContextProposalService");
  const { withMcpContextEditScope } =
    await import("../src/main/mcp/mcpContextEditScope");
  const service = new McpContextProposalService({
    read: f.library.readWorkContextForEdit,
    commit: f.library.commitWorkContextEdit,
    withEdit: withMcpContextEditScope,
  });
  const request = async () => ({
    chapterId: "chapter",
    requestId: randomUUID(),
    revision: mcpContextRevision(
      await f.library.readWorkContextForEdit("chapter"),
    ),
  });
  const inspect = (proposalId: string) =>
    service.inspect("owner", { proposalId }, authorize);
  const apply = (proposalId: string, selectedChangeIds: string[]) =>
    service.apply(
      "owner",
      { proposalId, requestId: randomUUID(), selectedChangeIds },
      authorize,
    );
  return {
    ...f,
    service,
    request,
    inspect,
    apply,
    async close() {
      await service.close();
      await f.close();
    },
  };
}

it("keeps absent context revisions stable and never creates files for reads, previews or no-op applies", async () => {
  const f = await setup();
  try {
    const first = await f.request();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await f.request()).revision).toBe(first.revision);
    const before = await f.snapshot();
    const proposal = await f.service.preview(
      "owner",
      {
        ...first,
        changes: [
          {
            changeId: "same",
            entity: "rules",
            values: { sfxMode: "translate" },
          },
        ],
      },
      authorize,
    );
    expect(f.inspect(proposal.proposalId).changes[0].changed).toBe(false);
    expect(await f.apply(proposal.proposalId, ["same"])).toMatchObject({
      changesApplied: 0,
      pagesChanged: 0,
      revision: first.revision,
    });
    expect(await f.snapshot()).toEqual(before);
    await expect(
      access(
        join(f.environment.libraryDir, "works", "work", "style-guide.json"),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      access(
        join(
          f.environment.libraryDir,
          "works",
          "work",
          "chapters",
          "chapter",
          "story-memory.json",
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await f.close();
  }
});

it("atomically edits glossary, characters, rules and page memory without touching page files", async () => {
  const f = await setup();
  try {
    const before = await f.snapshot();
    const request = await f.request();
    const proposal = await f.service.preview(
      "owner",
      {
        ...request,
        changes: [
          {
            changeId: "term",
            entity: "glossary",
            values: {
              source: "Hero",
              target: "Hero translated",
              note: "reviewed",
            },
          },
          {
            changeId: "character",
            entity: "character",
            values: {
              displayName: "Hero",
              sourceNames: ["Hero"],
              speechStyle: "polite",
            },
          },
          {
            changeId: "rules",
            entity: "rules",
            values: { honorifics: "preserve" },
          },
          {
            changeId: "memory",
            entity: "memory",
            pageId: "page",
            pageRevision: createPageRevision(f.after),
            values: {
              summary: "User-confirmed event",
              visualSummary: "User-confirmed visual",
            },
          },
        ],
      },
      authorize,
    );
    expect(await f.snapshot()).toEqual(before);
    expect(
      (await f.library.readWorkContextForEdit("chapter")).styleGuide.glossary,
    ).toEqual([]);
    const review = f.inspect(proposal.proposalId);
    expect(review.total).toBe(4);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const result = await f.apply(proposal.proposalId, proposal.changeIds);
    expect(result).toMatchObject({
      status: "applied",
      changesApplied: 4,
      pagesChanged: 0,
    });
    const saved = await f.library.readWorkContextForEdit("chapter");
    expect(Date.parse(saved.styleGuide.updatedAt)).toBeGreaterThanOrEqual(
      Date.parse(saved.styleGuide.createdAt),
    );
    expect(saved.styleGuide.glossary[0]).toMatchObject({
      id: review.changes[0].targetId,
      source: "Hero",
      target: "Hero translated",
      origin: "manual",
    });
    expect(saved.styleGuide.characters[0]).toMatchObject({
      displayName: "Hero",
      speechStyle: "polite",
    });
    expect(saved.styleGuide.rules.honorifics).toBe("preserve");
    expect(saved.storyMemory.pages[0]).toMatchObject({
      pageId: "page",
      summary: "User-confirmed event",
      visualSummarySource: "manual",
    });
    expect(mcpContextRevision(saved)).toBe(result.revision);
    expect(await f.snapshot()).toEqual(before);
  } finally {
    await f.close();
  }
});

it("applies only selected changes and treats exact request retries as historical receipts", async () => {
  const f = await setup();
  try {
    const request = {
      ...(await f.request()),
      changes: [
        { changeId: "rule", entity: "rules", values: { sfxMode: "note" } },
        {
          changeId: "skip",
          entity: "glossary",
          values: { source: "Omitted", target: "Not saved" },
        },
      ],
    };
    const proposal = await f.service.preview("owner", request, authorize);
    expect(await f.service.preview("owner", request, authorize)).toEqual(
      proposal,
    );
    const command = {
      proposalId: proposal.proposalId,
      requestId: randomUUID(),
      selectedChangeIds: ["rule"],
    };
    const receipt = await f.service.apply("owner", command, authorize);
    const saved = await f.library.readWorkContextForEdit("chapter");
    expect(saved.styleGuide.glossary).toEqual([]);
    await f.library.saveWorkStyleGuide(
      {
        ...saved.styleGuide,
        rules: { ...saved.styleGuide.rules, sfxMode: "preserve" },
      },
      saved.styleGuide.updatedAt,
    );
    expect(await f.service.apply("owner", command, authorize)).toEqual({
      ...receipt,
      status: "already_applied",
    });
    expect(
      (await f.library.readWorkContextForEdit("chapter")).styleGuide.rules
        .sfxMode,
    ).toBe("preserve");
    await expect(
      f.service.apply(
        "owner",
        { ...command, selectedChangeIds: ["skip"] },
        authorize,
      ),
    ).rejects.toMatchObject({ code: "invalid_edit" });
    await expect(f.apply(proposal.proposalId, ["skip"])).rejects.toMatchObject({
      code: "invalid_edit",
    });
  } finally {
    await f.close();
  }
});

it("rejects stale context, stale memory pages and other principals without changing stored data", async () => {
  const f = await setup();
  try {
    const proposal = await f.service.preview(
      "owner",
      {
        ...(await f.request()),
        changes: [
          {
            changeId: "memory",
            entity: "memory",
            pageId: "page",
            pageRevision: createPageRevision(f.after),
            values: { summary: "candidate" },
          },
        ],
      },
      authorize,
    );
    const before = await f.snapshot();
    expect(() =>
      f.service.inspect(
        "foreign",
        { proposalId: proposal.proposalId },
        authorize,
      ),
    ).toThrow();
    await expect(
      f.service.apply(
        "foreign",
        {
          proposalId: proposal.proposalId,
          requestId: randomUUID(),
          selectedChangeIds: ["memory"],
        },
        authorize,
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await f.snapshot()).toEqual(before);
    await f.library.savePageBlocks({
      chapterId: "chapter",
      pageId: "page",
      expectedRevision: createPageRevision(f.after),
      blocks: f.after.blocks.map((block, index) =>
        index ? block : { ...block, sourceText: "later edit" },
      ),
    });
    const edited = await f.snapshot();
    await expect(
      f.apply(proposal.proposalId, ["memory"]),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    expect(await f.snapshot()).toEqual(edited);
    const current = await f.library.readWorkContextForEdit("chapter");
    const rule = await f.service.preview(
      "owner",
      {
        ...(await f.request()),
        changes: [
          { changeId: "r", entity: "rules", values: { sfxMode: "note" } },
        ],
      },
      authorize,
    );
    await f.library.saveWorkStyleGuide({
      ...current.styleGuide,
      rules: { ...current.styleGuide.rules, defaultTone: "literal" },
    });
    await expect(f.apply(rule.proposalId, ["r"])).rejects.toMatchObject({
      code: "revision_conflict",
    });
  } finally {
    await f.close();
  }
});

it("rolls back BOTH files when a real context transaction fails before its commit point", async () => {
  const f = await setup();
  const transaction =
    await import("../src/main/libraryStore/libraryTransaction");
  const recovery =
    await import("../src/main/libraryStore/libraryTransactionRecovery");
  try {
    const context = await f.library.readWorkContextForEdit("chapter");
    await f.library.saveWorkStyleGuide(context.styleGuide);
    await f.library.saveChapterStoryMemory(context.storyMemory);
    const guidePath = join(
      f.environment.libraryDir,
      "works",
      "work",
      "style-guide.json",
    );
    const memoryPath = join(
      f.environment.libraryDir,
      "works",
      "work",
      "chapters",
      "chapter",
      "story-memory.json",
    );
    const before = await Promise.all([
      readFile(guidePath),
      readFile(memoryPath),
    ]);
    const proposal = await f.service.preview(
      "owner",
      {
        ...(await f.request()),
        changes: [
          { changeId: "rule", entity: "rules", values: { sfxMode: "note" } },
          {
            changeId: "memory",
            entity: "memory",
            pageId: "page",
            pageRevision: createPageRevision(f.after),
            values: { summary: "candidate" },
          },
        ],
      },
      authorize,
    );
    let injected = false;
    const restore = transaction.setLibraryTransactionCrashInjectorForTests(
      (point) => {
        if (!injected && point === "after-replace-step") {
          injected = true;
          throw new transaction.SimulatedLibraryTransactionCrash(point);
        }
      },
    );
    try {
      await expect(
        f.apply(proposal.proposalId, proposal.changeIds),
      ).rejects.toBeInstanceOf(transaction.SimulatedLibraryTransactionCrash);
    } finally {
      restore();
    }
    await recovery.recoverLibraryTransactions();
    expect(
      await Promise.all([readFile(guidePath), readFile(memoryPath)]),
    ).toEqual(before);
  } finally {
    await f.close();
  }
});

it("rejects duplicate targets, empty patches, invalid IDs and invented memory references before writing", async () => {
  const f = await setup();
  try {
    const base = await f.request();
    const before = await f.snapshot();
    const rule = {
      changeId: "r",
      entity: "rules",
      values: { sfxMode: "note" },
    };
    for (const changes of [
      [rule, rule],
      [{ ...rule, values: {} }],
      [
        {
          changeId: "x",
          entity: "glossary",
          entryId: "missing",
          values: { target: "x" },
        },
      ],
      [
        {
          changeId: "m",
          entity: "memory",
          pageId: "page",
          pageRevision: createPageRevision(f.after),
          values: { summary: "x", characterIds: ["missing"] },
        },
      ],
    ]) {
      await expect(
        f.service.preview(
          "owner",
          { ...base, requestId: randomUUID(), changes },
          authorize,
        ),
      ).rejects.toThrow();
    }
    expect(await f.snapshot()).toEqual(before);
  } finally {
    await f.close();
  }
});
