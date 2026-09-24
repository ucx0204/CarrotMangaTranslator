import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { contextHttpFixture } from "./mcpContextMigrationHttp.fixture";
import { mcpContextRevision } from "../src/shared/mcpContextEditing";

type Fixture = Awaited<ReturnType<typeof contextHttpFixture>>;
async function input(f: Fixture) {
  const graph = await f.graph();
  return {
    chapterId: "chapter",
    revision: mcpContextRevision({
      ...graph,
      storyMemory: graph.chapters[0].storyMemory,
    }),
    requestId: randomUUID(),
    changes: [
      {
        change: {
          changeId: "term",
          entity: "glossary",
          values: { source: "HTTP research", target: "Reviewed HTTP term" },
        },
        reason: "Unverified caller source",
        sources: [
          { title: "Caller source", url: "https://example.com/research" },
        ],
      },
    ],
  };
}

it("uses real OAuth ownership and strict contracts for restart-safe review and selected application", async () => {
  const f = await contextHttpFixture();
  try {
    const before = (await f.graph()).styleGuide;
    const request = await input(f);
    const response = await f.call("carrot_preview_context_research", request);
    expect(response.result.isError).toBe(false);
    const proposal = response.result.structuredContent;
    const args = { proposalId: proposal.proposalId };
    const reviewed = await f.call("carrot_get_context_proposal", args);
    expect(reviewed.result.structuredContent.retention).toBe("seven-days");
    expect(
      (await f.call("carrot_get_context_proposal", args, f.other)).result
        .structuredContent.error,
    ).toBe("not_found");
    expect(
      (await f.call("carrot_list_context_proposals", {}, f.read)).result
        .structuredContent.total,
    ).toBe(0);
    const command = {
      ...args,
      requestId: randomUUID(),
      selectedChangeIds: ["term"],
    };
    expect(
      (await f.call("carrot_apply_context_proposal", command, f.read)).error
        .message,
    ).toBe("Unknown tool");
    expect(
      (
        await f.call("carrot_apply_context_proposal", {
          ...command,
          path: "private",
        })
      ).error.code,
    ).toBe(-32602);
    await f.restart();
    expect(
      (await f.call("carrot_get_context_proposal", args)).result
        .structuredContent,
    ).toEqual(reviewed.result.structuredContent);
    const listing = (await f.call("carrot_list_context_proposals", {})).result
      .structuredContent;
    expect(listing.items).toMatchObject([{ id: proposal.proposalId }]);
    expect(JSON.stringify(listing)).not.toMatch(
      /Reviewed HTTP term|example.com|imagePath/,
    );
    const applied = await f.call("carrot_apply_context_proposal", command);
    expect(applied.result.isError).toBe(false);
    const id = applied.result.structuredContent.recoveryId;
    expect(id).toEqual(expect.any(String));
    await f.restart();
    const recovery = (await f.call("carrot_get_context_migration", { id }))
      .result.structuredContent;
    expect(recovery.canUndo).toBe(true);
    expect(
      (
        await f.call("carrot_undo_context_migration", {
          id,
          requestId: randomUUID(),
          referenceSnapshot: recovery.referenceSnapshot,
        })
      ).result.isError,
    ).toBe(false);
    expect(
      (await f.call("carrot_apply_context_proposal", command)).result
        .structuredContent.status,
    ).toBe("already_applied");
    expect((await f.graph()).styleGuide).toEqual(before);
  } finally {
    await f.close();
  }
});

it.each(["preview", "apply"] as const)(
  "rolls back retained research %s when the real grant is revoked during encryption",
  async (phase) => {
    const f = await contextHttpFixture();
    const seal = f.codec.seal;
    let revoked = false;
    let hook: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const request = await input(f);
      const proposal =
        phase === "apply"
          ? (await f.call("carrot_preview_context_research", request)).result
              .structuredContent
          : undefined;
      const before = (await f.graph()).styleGuide;
      hook = vi.spyOn(f.codec, "seal").mockImplementation(async (value) => {
        const encrypted = await seal(value);
        const matches =
          typeof value === "object" &&
          value !== null &&
          (phase === "apply" ? "delta" in value : "metadata" in value);
        if (!revoked && matches) {
          const owner = f.provider.connectionIdFor(`Bearer ${f.full}`);
          if (!owner) throw new Error("Missing OAuth grant");
          revoked = true;
          f.provider.revokeConnection(owner);
        }
        return encrypted;
      });
      const result =
        phase === "preview"
          ? await f.call("carrot_preview_context_research", request)
          : await f.call("carrot_apply_context_proposal", {
              proposalId: proposal.proposalId,
              requestId: randomUUID(),
              selectedChangeIds: ["term"],
            });
      expect(revoked).toBe(true);
      expect(result.result?.isError ?? Boolean(result.error)).toBe(true);
      expect((await f.graph()).styleGuide).toEqual(before);
      expect(
        (await f.storage.index()).entries.map((entry) => entry.kind),
      ).toEqual(phase === "apply" ? ["research-proposal"] : []);
    } finally {
      hook?.mockRestore();
      await f.close();
    }
  },
);
