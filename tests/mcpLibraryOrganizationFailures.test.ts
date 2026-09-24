import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { libraryOrganizationFixture } from "./mcpLibraryOrganization.fixture";
import { McpLibraryOrganizationRecordSchema } from "../src/main/application/mcpLibraryOrganizationState";

it("rejects stale intent and later native edits instead of overwriting newer library state", async () => {
  const f = await libraryOrganizationFixture();
  try {
    const intent = {
      kind: "rename-work" as const,
      workId: "work",
      title: "Reviewed name",
    };
    const stale = await f.command(intent);
    await f.library.renameWork("work", "Manual name");
    await expect(f.apply(stale)).rejects.toMatchObject({
      code: "revision_conflict",
    });
    const input = await f.command(intent);
    const saved = await f.apply(input);
    await expect(
      f.apply({ ...input, intent: { ...intent, title: "Unreviewed name" } }),
    ).rejects.toMatchObject({ code: "invalid_edit" });
    await f.library.renameChapter("chapter", "Later native chapter name");
    const before = await f.library.listLibrary();
    expect(await f.inspectChange(saved.id)).toMatchObject({
      canUndo: false,
      canRedo: false,
    });
    await expect(f.recover(saved.id, "undo")).rejects.toMatchObject({
      code: "revision_conflict",
    });
    expect(await f.library.listLibrary()).toEqual(before);
    expect(await f.apply(input)).toMatchObject({ historical: true });
    expect(await f.library.listLibrary()).toEqual(before);
  } finally {
    await f.close();
  }
});

it.each(["encryption", "revocation", "expiry", "session-stop"] as const)(
  "rolls back names and retained metadata together after late %s",
  async (failure) => {
    const f = await libraryOrganizationFixture();
    let authorized = true;
    const guard = () => {
      if (!authorized) throw new Error("Revoked test grant");
    };
    try {
      const path = join(f.env.libraryDir, "works", "work", "work.json");
      const before = await readFile(path);
      const chapter = await readFile(f.chapterPath);
      const input = await f.command({
        kind: "rename-work",
        workId: "work",
        title: "Must not publish",
      });
      const seal = f.codec.seal.bind(f.codec);
      let injected = false;
      const hook = vi
        .spyOn(f.codec, "seal")
        .mockImplementation(async (value) => {
          const encoded = await seal(value);
          const parsed = McpLibraryOrganizationRecordSchema.safeParse(value);
          if (!injected && parsed.success) {
            injected = true;
            if (failure === "encryption")
              throw new Error("Late encryption failure");
            if (failure === "revocation") authorized = false;
            if (failure === "expiry") f.clock(parsed.data.expiresAt);
            if (failure === "session-stop") f.organization().stop();
          }
          return encoded;
        });
      await expect(
        f.call(
          "carrot_apply_library_change",
          input,
          f.auth("import-owner", guard),
        ),
      ).rejects.toThrow();
      hook.mockRestore();
      expect(injected).toBe(true);
      expect(await readFile(path)).toEqual(before);
      expect(await readFile(f.chapterPath)).toEqual(chapter);
      expect((await f.storage.index()).entries).toEqual([]);
      expect(f.app.jobs.gate.activities).toEqual([]);
    } finally {
      vi.restoreAllMocks();
      await f.close();
    }
  },
);

it("refuses corrupted recovery fields both in availability lookup and actual restore", async () => {
  const f = await libraryOrganizationFixture();
  try {
    const saved = await f.apply(
      await f.command({
        kind: "rename-work",
        workId: "work",
        title: "Published name",
      }),
    );
    const record = McpLibraryOrganizationRecordSchema.parse(
      await f.storage.record(saved.id),
    );
    const altered = structuredClone(record);
    altered.before.fields.work.title = "Forged previous name";
    await writeFile(
      await f.storage.path(saved.id),
      JSON.stringify(await f.codec.seal(altered)),
    );
    const before = await f.library.listLibrary();
    await expect(f.inspectChange(saved.id)).rejects.toThrow();
    await expect(
      f.call("carrot_undo_library_change", {
        id: saved.id,
        snapshot: saved.snapshot,
        requestId: crypto.randomUUID(),
      }),
    ).rejects.toThrow();
    expect(await f.library.listLibrary()).toEqual(before);
    await writeFile(
      await f.storage.path(saved.id),
      JSON.stringify(await f.codec.seal(record)),
    );
    expect((await f.inspectChange(saved.id)).canUndo).toBe(true);
  } finally {
    await f.close();
  }
});
