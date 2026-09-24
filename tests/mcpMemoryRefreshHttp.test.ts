import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { contextHttpFixture } from "./mcpContextMigrationHttp.fixture";
import { memoryRefreshAppFixture } from "./mcpMemoryRefreshApp.fixture";

async function httpMemoryInput(
  f: Awaited<ReturnType<typeof contextHttpFixture>>,
) {
  const response = await f.call(
    "carrot_get_memory_status",
    { chapterId: "chapter" },
    f.read,
  );
  expect(response.result.isError).toBe(false);
  const status = response.result.structuredContent;
  expect(JSON.stringify(status)).not.toMatch(
    /Private|imagePath|sourceText|sourceDigest|translatedText/,
  );
  const row = status.items.find(
    (item: { chapterId: string; revision: string | null }) =>
      item.chapterId === "chapter" && item.revision,
  );
  const intent = {
    chapterId: "chapter",
    referenceSnapshot: status.referenceSnapshot,
    pages: [
      {
        chapterId: row.chapterId,
        pageId: row.pageId,
        revision: row.revision,
        sourceFingerprint: row.sourceFingerprint,
        translationFingerprint: row.translationFingerprint,
        summary: { kind: "native-excerpt" },
      },
    ],
  };
  const preview = await f.call("carrot_preview_memory_refresh", intent, f.read);
  expect(preview.result.isError).toBe(false);
  return {
    ...intent,
    planFingerprint: preview.result.structuredContent.planFingerprint,
    requestId: randomUUID(),
  };
}

it("uses real OAuth scopes for memory inspection, summary publication, owned recovery and strict input rejection", async () => {
  const f = await contextHttpFixture();
  try {
    const input = await httpMemoryInput(f);
    expect((await f.storage.index()).entries).toEqual([]);
    expect(
      (await f.call("carrot_apply_memory_refresh", input, f.read)).error
        .message,
    ).toBe("Unknown tool");
    expect(
      (
        await f.call("carrot_apply_memory_refresh", {
          ...input,
          path: "C:/private",
        })
      ).error.code,
    ).toBe(-32602);
    const applied = await f.call("carrot_apply_memory_refresh", input);
    expect(applied.result.isError).toBe(false);
    const id = applied.result.structuredContent.id;
    expect(
      (await f.call("carrot_get_context_migration", { id }, f.other)).result
        .structuredContent.error,
    ).toBe("not_found");
    const inspect = await f.call("carrot_get_context_migration", { id });
    expect(inspect.result.structuredContent.canUndo).toBe(true);
    const undo = await f.call("carrot_undo_context_migration", {
      id,
      requestId: randomUUID(),
      referenceSnapshot: inspect.result.structuredContent.referenceSnapshot,
    });
    expect(undo.result.isError).toBe(false);
    expect(
      (await f.call("carrot_apply_memory_refresh", input)).result
        .structuredContent.status,
    ).toBe("already_applied");
    expect((await f.library.getChapterStoryMemory("chapter")).pages).toEqual(
      [],
    );
  } finally {
    await f.close();
  }
});

it("rechecks the actual grant during encrypted memory staging without publishing a revoked request", async () => {
  const f = await contextHttpFixture();
  const seal = f.codec.seal;
  let revoked = false;
  const hook = vi.spyOn(f.codec, "seal").mockImplementation(async (value) => {
    const result = await seal(value);
    if (
      !revoked &&
      typeof value === "object" &&
      value !== null &&
      "delta" in value
    ) {
      const id = f.provider.connectionIdFor(`Bearer ${f.full}`);
      if (!id) throw new Error("Missing test grant");
      revoked = true;
      f.provider.revokeConnection(id);
    }
    return result;
  });
  try {
    const input = await httpMemoryInput(f);
    const result = await f.call("carrot_apply_memory_refresh", input);
    expect(revoked).toBe(true);
    expect(result.result?.isError ?? Boolean(result.error)).toBe(true);
    expect((await f.storage.index()).entries).toEqual([]);
    expect((await f.library.getChapterStoryMemory("chapter")).pages).toEqual(
      [],
    );
  } finally {
    hook.mockRestore();
    await f.close();
  }
});

it("keeps memory reads when editing is disabled and rejects closed-session reads", async () => {
  const f = await memoryRefreshAppFixture();
  try {
    f.preferences.allowEditing = false;
    await f.restart();
    const names = f.current().tools.map((tool) => tool.name);
    expect(names).toContain("carrot_get_memory_status");
    expect(names).toContain("carrot_preview_memory_refresh");
    expect(names).not.toContain("carrot_apply_memory_refresh");
    expect((await f.status()).counts.missing).toBeGreaterThan(0);
    await f.current().session.close();
    await expect(f.status()).rejects.toThrow();
  } finally {
    await f.close();
  }
});
