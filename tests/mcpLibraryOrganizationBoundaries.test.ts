import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { libraryOrganizationFixture } from "./mcpLibraryOrganization.fixture";
import { createDeferred } from "./inpaintingSelectionJobFixtures";
import { libraryStructureResource } from "../src/shared/appActivityTypes";
import { McpLibraryOrganizationRecordSchema } from "../src/main/application/mcpLibraryOrganizationState";

it("rejects incomplete, duplicate, foreign and overbroad intents without changing library data", async () => {
  const f = await libraryOrganizationFixture();
  try {
    const before = await f.library.listLibrary();
    for (const intent of [
      { kind: "reorder-chapters", workId: "work", chapterIds: [] },
      {
        kind: "reorder-chapters",
        workId: "work",
        chapterIds: ["chapter", "chapter"],
      },
      { kind: "reorder-chapters", workId: "work", chapterIds: ["foreign"] },
      { kind: "rename-work", workId: "work", title: " " },
      { kind: "rename-work", workId: "../private", title: "Name" },
      {
        kind: "rename-chapter",
        workId: "work",
        chapterId: "foreign",
        title: "Name",
      },
      { kind: "delete-work", workId: "work" },
      {
        kind: "rename-work",
        workId: "work",
        title: "Name",
        path: "C:/private",
      },
    ])
      await expect(
        f.call("carrot_preview_library_change", { intent }),
      ).rejects.toThrow();
    const input = await f.command({
      kind: "rename-work",
      workId: "work",
      title: "Reviewed",
    });
    await expect(
      f.apply({ ...input, planFingerprint: "0".repeat(16) }),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    expect(await f.library.listLibrary()).toEqual(before);
    expect((await f.storage.index()).entries).toEqual([]);
    const saved = await f.apply(input);
    await expect(
      f.call("carrot_get_library_change", { id: saved.id }, f.auth("other")),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(
      await f.call("carrot_list_library_changes", {}, f.auth("other")),
    ).toMatchObject({ total: 0 });
    f.preferences.allowEditing = false;
    await f.restart();
    expect(f.organization().tools).toHaveLength(15);
    expect(f.organization().tools.every((tool) => tool.readOnly)).toBe(true);
  } finally {
    await f.close();
  }
});

it("respects existing work activity ownership and releases only its own admission", async () => {
  const f = await libraryOrganizationFixture();
  const entered = createDeferred<void>(),
    release = createDeferred<void>();
  let blocking: Promise<unknown> | undefined;
  try {
    const { withLibraryContentEdit } = await import("../src/main/library/lock");
    const input = await f.command({
      kind: "rename-work",
      workId: "work",
      title: "After activity",
    });
    blocking = withLibraryContentEdit(
      [libraryStructureResource("work", "work")],
      async () => {
        entered.resolve();
        await release.promise;
      },
    );
    await entered.promise;
    await expect(f.apply(input)).rejects.toThrow();
    expect(f.app.jobs.gate.activities).toHaveLength(1);
    release.resolve();
    await blocking;
    expect((await f.apply(input)).status).toBe("saved");
    expect(f.app.jobs.gate.activities).toEqual([]);
  } finally {
    release.resolve();
    await blocking;
    await f.close();
  }
});

it("keeps later out-of-process metadata when publication detects a change after encryption", async () => {
  const f = await libraryOrganizationFixture();
  try {
    const path = join(f.env.libraryDir, "works", "work", "work.json");
    const input = await f.command({
      kind: "rename-work",
      workId: "work",
      title: "Do not overwrite later state",
    });
    const manual = {
      ...JSON.parse(await readFile(path, "utf8")),
      title: "External edit",
      updatedAt: "later",
    };
    const seal = f.codec.seal.bind(f.codec);
    let injected = false;
    const hook = vi.spyOn(f.codec, "seal").mockImplementation(async (value) => {
      const encoded = await seal(value);
      if (
        !injected &&
        McpLibraryOrganizationRecordSchema.safeParse(value).success
      ) {
        injected = true;
        await writeFile(path, JSON.stringify(manual));
      }
      return encoded;
    });
    await expect(f.apply(input)).rejects.toThrow(/changed before publication/);
    hook.mockRestore();
    expect(injected).toBe(true);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(manual);
    expect((await f.storage.index()).entries).toEqual([]);
  } finally {
    vi.restoreAllMocks();
    await f.close();
  }
});

it("caps recovery actions while keeping historical retries valid and never expires ordinary names", async () => {
  const f = await libraryOrganizationFixture();
  try {
    const input = await f.command({
      kind: "rename-work",
      workId: "work",
      title: "Persistent ordinary name",
    });
    const saved = await f.apply(input);
    let last: { id: string; snapshot: string; requestId: string } | undefined;
    for (let index = 0; index < 32; index++) {
      const action = await f.recover(saved.id, index % 2 ? "redo" : "undo");
      last = action.input;
    }
    expect(await f.inspectChange(saved.id)).toMatchObject({
      actionsUsed: 32,
      canUndo: false,
      canRedo: false,
    });
    if (!last) throw new Error("Missing action");
    expect(await f.call("carrot_redo_library_change", last)).toMatchObject({
      historical: true,
    });
    await expect(
      f.call("carrot_undo_library_change", last),
    ).rejects.toMatchObject({ code: "invalid_edit" });
    await expect(
      f.call("carrot_undo_library_change", {
        id: saved.id,
        snapshot: saved.snapshot,
        requestId: input.requestId,
      }),
    ).rejects.toMatchObject({ code: "invalid_edit" });
    await expect(
      f.call("carrot_undo_library_change", {
        id: saved.id,
        snapshot: saved.snapshot,
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "invalid_edit" });
    f.clock(saved.expiresAt);
    await expect(f.inspectChange(saved.id)).rejects.toMatchObject({
      code: "not_found",
    });
    expect(await f.call("carrot_list_library_changes", {})).toMatchObject({
      items: [{ available: false }],
    });
    expect((await f.library.listLibrary()).works[0].title).toBe(
      "Persistent ordinary name",
    );
  } finally {
    await f.close();
  }
});
