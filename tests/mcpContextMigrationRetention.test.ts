import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { contextMigrationAppFixture } from "./mcpContextMigrationApp.fixture";

it("discards only an owned recovery record while preserving the migrated catalog and pages", async () => {
  const f = await contextMigrationAppFixture();
  try {
    const result = await f.apply();
    const saved = await f.graph();
    const bytes = await readFile(f.chapterPath);
    await expect(
      f.invoke(
        "carrot_discard_retained",
        { id: result.id, confirm: true },
        f.auth("another-owner"),
      ),
    ).rejects.toThrow();
    expect(
      await f.invoke("carrot_discard_retained", {
        id: result.id,
        confirm: true,
      }),
    ).toMatchObject({ status: "discarded", pageChanges: 0 });
    await f.restart();
    await expect(f.inspect(result.id)).rejects.toThrow();
    expect((await f.graph()).styleGuide).toEqual(saved.styleGuide);
    expect(await readFile(f.chapterPath)).toEqual(bytes);
    expect(await f.invoke("carrot_list_context_migrations", {})).toMatchObject({
      total: 0,
    });
  } finally {
    await f.close();
  }
});

it("refuses expired recovery and stale apply replay without changing the saved work", async () => {
  let now = Date.now();
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  const f = await contextMigrationAppFixture();
  try {
    const input = await f.input();
    const result = await f.apply(input);
    const recovery = await f.recoverInput(result.id);
    const bytes = await readFile(f.chapterPath);
    now += 8 * 24 * 60 * 60_000;
    await expect(f.inspect(result.id)).rejects.toThrow("expired");
    await expect(
      f.invoke("carrot_undo_context_migration", recovery),
    ).rejects.toThrow("expired");
    await expect(f.apply(input)).rejects.toThrow("expired");
    const list = await f.invoke("carrot_list_context_migrations", {});
    expect(list).toMatchObject({
      items: [{ id: result.id, available: false }],
    });
    expect(await readFile(f.chapterPath)).toEqual(bytes);
  } finally {
    await f.close();
    clock.mockRestore();
  }
});

it("keeps the thirty-two-action retained recovery bound and original record expiry", async () => {
  const f = await contextMigrationAppFixture();
  try {
    const applied = await f.apply();
    const expiry = (await f.inspect(applied.id)).expiresAt;
    for (let index = 0; index < 32; index++)
      await f.recover(applied.id, index % 2 === 0 ? "undo" : "redo");
    const final = await f.inspect(applied.id);
    expect(final).toMatchObject({
      actionsUsed: 32,
      canUndo: false,
      canRedo: false,
      expiresAt: expiry,
    });
    expect(final.warnings).toContain("action_history_full");
    const bytes = await readFile(f.chapterPath);
    await expect(
      f.invoke("carrot_undo_context_migration", {
        id: applied.id,
        requestId: randomUUID(),
        referenceSnapshot: final.referenceSnapshot,
      }),
    ).rejects.toThrow("history is full");
    expect(await readFile(f.chapterPath)).toEqual(bytes);
  } finally {
    await f.close();
  }
}, 60000);

it("retains metadata-only inspection after editing is disabled but removes context mutation tools", async () => {
  const f = await contextMigrationAppFixture();
  try {
    const applied = await f.apply();
    const bytes = await readFile(f.chapterPath);
    f.preferences.allowEditing = false;
    f.preferences.allowProcessing = false;
    await f.restart();
    const names = f.current().tools.map((tool) => tool.name);
    expect(names).toContain("carrot_get_context_migration");
    expect(names).toContain("carrot_list_context_migrations");
    for (const direction of ["apply", "undo", "redo"])
      expect(names).not.toContain(`carrot_${direction}_context_migration`);
    expect((await f.inspect(applied.id)).id).toBe(applied.id);
    expect(await readFile(f.chapterPath)).toEqual(bytes);
  } finally {
    await f.close();
  }
});
