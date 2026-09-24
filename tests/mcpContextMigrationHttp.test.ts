import { expect, it, vi } from "vitest";
import { contextHttpFixture } from "./mcpContextMigrationHttp.fixture";

it("requires edit/process authority for context application and preserves owner isolation over actual HTTP", async () => {
  const f = await contextHttpFixture();
  try {
    const input = await f.input();
    expect(
      (
        await f.call(
          "carrot_get_context_references",
          { chapterId: "chapter" },
          f.read,
        )
      ).result.isError,
    ).toBe(false);
    expect(
      (await f.call("carrot_apply_context_migration", input, f.read)).error
        .message,
    ).toBe("Unknown tool");
    expect(
      (await f.call("carrot_apply_context_migration", { ...input, raw: {} }))
        .error.code,
    ).toBe(-32602);
    const applied = await f.call("carrot_apply_context_migration", input);
    expect(applied.result.isError).toBe(false);
    const id = applied.result.structuredContent.id;
    const view = await f.call("carrot_get_context_migration", { id });
    expect(view.result.structuredContent.canUndo).toBe(true);
    expect(JSON.stringify(view)).not.toMatch(
      /Private|imagePath|sourceText|sourceDigest|translatedText/,
    );
    expect(
      (await f.call("carrot_get_context_migration", { id }, f.other)).result
        .structuredContent.error,
    ).toBe("not_found");
    expect(
      (await f.call("carrot_list_context_migrations", {}, f.other)).result
        .structuredContent.items,
    ).toEqual([]);
    const undo = await f.call("carrot_undo_context_migration", {
      id,
      requestId: crypto.randomUUID(),
      referenceSnapshot: view.result.structuredContent.referenceSnapshot,
    });
    expect(undo.result.isError).toBe(false);
    expect(
      (await f.call("carrot_apply_context_migration", input)).result
        .structuredContent.status,
    ).toBe("already_applied");
  } finally {
    await f.close();
  }
});

it("rechecks the real OAuth grant after encryption and does not publish context after revocation", async () => {
  const f = await contextHttpFixture();
  const seal = f.codec.seal;
  let revoked = false;
  const hook = vi.spyOn(f.codec, "seal").mockImplementation(async (value) => {
    const sealed = await seal(value);
    if (
      !revoked &&
      typeof value === "object" &&
      value !== null &&
      "delta" in value
    ) {
      const id = f.provider.connectionIdFor(`Bearer ${f.full}`);
      if (!id) throw new Error("Missing approved test connection");
      revoked = true;
      f.provider.revokeConnection(id);
    }
    return sealed;
  });
  try {
    const before = await f.graph();
    const result = await f.call(
      "carrot_apply_context_migration",
      await f.input(),
    );
    expect(revoked).toBe(true);
    expect(result.result?.isError ?? Boolean(result.error)).toBe(true);
    expect((await f.graph()).styleGuide).toEqual(before.styleGuide);
    expect((await f.storage.index()).entries).toEqual([]);
  } finally {
    hook.mockRestore();
    await f.close();
  }
});
