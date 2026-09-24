import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { contextHttpFixture } from "./mcpContextMigrationHttp.fixture";

async function heldInput(f: Awaited<ReturnType<typeof contextHttpFixture>>) {
  const context = (
    await f.call("carrot_get_work_context", { chapterId: "chapter" })
  ).result.structuredContent;
  const references = (
    await f.call("carrot_get_context_references", { chapterId: "chapter" })
  ).result.structuredContent;
  return {
    requestId: randomUUID(),
    works: [
      {
        workId: context.workId,
        chapterId: "chapter",
        revision: context.revision,
        referenceSnapshot: references.snapshot,
        researchTitle: "Unconfirmed title",
        engine: "tavily",
        titleConfirmed: false,
        allowSpoilers: false,
      },
    ],
  };
}

it("registers actual batch tools, isolates owners and reconstructs held plans over authenticated HTTP without inference", async () => {
  const f = await contextHttpFixture();
  try {
    const input = await heldInput(f);
    const before = (await f.graph()).styleGuide;
    expect(
      (await f.call("carrot_prepare_research_batch", input, f.read)).error
        .message,
    ).toBe("Unknown tool");
    expect(
      (
        await f.call("carrot_prepare_research_batch", {
          ...input,
          path: "C:/private",
        })
      ).error.code,
    ).toBe(-32602);
    const prepared = await f.call("carrot_prepare_research_batch", input);
    expect(prepared.result.isError).toBe(false);
    const plan = prepared.result.structuredContent;
    expect(plan.works[0]).toMatchObject({
      status: "held",
      holds: ["title_unconfirmed", "spoiler_scope"],
    });
    expect(
      (await f.call("carrot_get_research_batch", { id: plan.id }, f.other))
        .result.structuredContent.error,
    ).toBe("not_found");
    expect(
      (await f.call("carrot_list_research_batches", {}, f.other)).result
        .structuredContent.items,
    ).toEqual([]);
    await f.restart();
    expect(
      (await f.call("carrot_get_research_batch", { id: plan.id })).result
        .structuredContent,
    ).toEqual(plan);
    const command = {
      id: plan.id,
      version: plan.version,
      requestId: randomUUID(),
      allowExternal: true,
    };
    expect(
      (await f.call("carrot_run_research_batch", command, f.read)).error
        .message,
    ).toBe("Unknown tool");
    expect(
      (await f.call("carrot_run_research_batch", command)).result.isError,
    ).toBe(false);
    await vi.waitFor(async () => {
      const result = (
        await f.call("carrot_get_research_batch", { id: plan.id })
      ).result.structuredContent;
      expect(result).toMatchObject({ status: "partial", attemptsUsed: 0 });
    });
    expect(
      (await f.call("carrot_discard_retained", { id: plan.id, confirm: true }))
        .result.structuredContent.error,
    ).toBe("invalid_edit");
    expect(
      (
        await f.call("carrot_discard_research_batch", {
          id: plan.id,
          confirm: true,
        })
      ).result.structuredContent.status,
    ).toBe("discarded");
    expect((await f.graph()).styleGuide).toEqual(before);
    expect((await f.storage.index()).entries).toEqual([]);
    expect(f.errors).toEqual([]);
  } finally {
    await f.close();
  }
});

it("rolls back a new research plan when its actual OAuth grant is revoked during encryption", async () => {
  const f = await contextHttpFixture();
  const seal = f.codec.seal;
  let revoked = false;
  const hook = vi.spyOn(f.codec, "seal").mockImplementation(async (value) => {
    const sealed = await seal(value);
    if (
      !revoked &&
      value &&
      typeof value === "object" &&
      "works" in value &&
      "inputFingerprint" in value
    ) {
      const owner = f.provider.connectionIdFor(`Bearer ${f.full}`);
      if (!owner) throw new Error("Missing test grant");
      f.provider.revokeConnection(owner);
      revoked = true;
    }
    return sealed;
  });
  try {
    const input = await heldInput(f);
    const result = await f.call("carrot_prepare_research_batch", input);
    expect(revoked).toBe(true);
    expect(result.result?.isError ?? Boolean(result.error)).toBe(true);
    expect((await f.storage.index()).entries).toEqual([]);
  } finally {
    hook.mockRestore();
    await f.close();
  }
});
