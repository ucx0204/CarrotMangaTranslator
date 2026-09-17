import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
  McpExternalResearchSchema,
  mcpContextRevision,
} from "../src/shared/mcpContextEditing";
import {
  persistedMcpJobResult,
  publicMcpJobResult,
} from "../src/main/application/mcpJobJournal";
import { recoveryLibrary } from "./mcpErasureRecovery.fixture";

it("marks live research receipts expired by time without mutating their retained metadata", () => {
  const value = {
    pagesChanged: 0,
    proposalExpired: false,
    contextResearch: {
      proposalId: randomUUID(),
      chapterId: "chapter",
      workId: "work",
      revision: "0123456789abcdef",
      source: "app-research",
      changeIds: ["c"],
      expiresAt: 1000,
      warnings: [],
      queryCount: 2,
      sourceCount: 3,
      tavilyCreditsUsed: 1,
    },
  };
  expect(publicMcpJobResult(value, 999)?.proposalExpired).toBe(false);
  expect(publicMcpJobResult(value, 1000)?.proposalExpired).toBe(true);
  expect(value.proposalExpired).toBe(false);
  expect(persistedMcpJobResult(value)).toMatchObject({
    proposalExpired: true,
    queryCount: 2,
    sourceCount: 3,
    tavilyCreditsUsed: 1,
  });
  expect(persistedMcpJobResult(value)).not.toHaveProperty("contextResearch");
});

it("rejects malformed and unsafe evidence URLs as schema errors rather than throwing inside safeParse", () => {
  const request = {
    chapterId: "chapter",
    revision: "0123456789abcdef",
    requestId: randomUUID(),
  };
  for (const url of [
    "not a URL",
    "file:///private",
    "javascript:alert(1)",
    "https://user:password@example.com/private",
    "//relative",
    "",
  ]) {
    expect(
      McpExternalResearchSchema.safeParse({
        ...request,
        changes: [
          {
            change: {
              changeId: "g",
              entity: "glossary",
              values: { source: "term" },
            },
            reason: "caller evidence",
            sources: [{ title: "source", url }],
          },
        ],
      }).success,
    ).toBe(false);
  }
});

it("expires owned previews and refuses late application without changing the real library", async () => {
  const f = await recoveryLibrary();
  const { McpContextProposalService } =
    await import("../src/main/application/mcpContextProposalService");
  const { withMcpContextEditScope } =
    await import("../src/main/mcp/mcpContextEditScope");
  let now = Date.now();
  const service = new McpContextProposalService(
    {
      read: f.library.readWorkContextForEdit,
      commit: f.library.commitWorkContextEdit,
      withEdit: withMcpContextEditScope,
    },
    () => now,
  );
  try {
    const before = await f.snapshot();
    const snapshot = await f.library.readWorkContextForEdit("chapter");
    const proposal = await service.preview(
      "owner",
      {
        chapterId: "chapter",
        revision: mcpContextRevision(snapshot),
        requestId: randomUUID(),
        changes: [
          { changeId: "rule", entity: "rules", values: { sfxMode: "note" } },
        ],
      },
      () => {},
    );
    now += 31 * 60_000;
    expect(() =>
      service.inspect("owner", { proposalId: proposal.proposalId }, () => {}),
    ).toThrow();
    await expect(
      service.apply(
        "owner",
        {
          proposalId: proposal.proposalId,
          requestId: randomUUID(),
          selectedChangeIds: ["rule"],
        },
        () => {},
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await f.snapshot()).toEqual(before);
  } finally {
    await service.close();
    await f.close();
  }
});

it("cancels queued context writes on shutdown without releasing another owner's lease", async () => {
  const f = await recoveryLibrary();
  const { McpContextProposalService } =
    await import("../src/main/application/mcpContextProposalService");
  const { withMcpContextEditScope } =
    await import("../src/main/mcp/mcpContextEditScope");
  const { withLibraryContentEdit } = await import("../src/main/library/lock");
  const service = new McpContextProposalService({
    read: f.library.readWorkContextForEdit,
    commit: f.library.commitWorkContextEdit,
    withEdit: withMcpContextEditScope,
  });
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const held = withLibraryContentEdit(
    [{ kind: "work-context", scope: "work", access: "write" }],
    async () => {
      enter();
      await pending;
    },
  );
  try {
    await entered;
    const before = await f.snapshot();
    const snapshot = await f.library.readWorkContextForEdit("chapter");
    const proposal = await service.preview(
      "owner",
      {
        chapterId: "chapter",
        revision: mcpContextRevision(snapshot),
        requestId: randomUUID(),
        changes: [
          { changeId: "rule", entity: "rules", values: { sfxMode: "note" } },
        ],
      },
      () => {},
    );
    const applying = service.apply(
      "owner",
      {
        proposalId: proposal.proposalId,
        requestId: randomUUID(),
        selectedChangeIds: ["rule"],
      },
      () => {},
    );
    const rejected = expect(applying).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await service.close();
    await rejected;
    release();
    await held;
    expect(await f.snapshot()).toEqual(before);
    expect(
      (await f.library.readWorkContextForEdit("chapter")).styleGuide.rules
        .sfxMode,
    ).toBe("translate");
  } finally {
    release();
    await held;
    await service.close();
    await f.close();
  }
});
