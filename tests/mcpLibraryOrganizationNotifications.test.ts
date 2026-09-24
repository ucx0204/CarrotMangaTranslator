import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { libraryOrganizationFixture } from "./mcpLibraryOrganization.fixture";

it.each(["rename-work", "rename-chapter", "reorder-chapters"] as const)(
  "announces committed %s metadata once and also announces reconstructed Undo/Redo",
  async (kind) => {
    const notify = vi.fn();
    const f = await libraryOrganizationFixture(notify);
    try {
      const imported = await f.create(await f.importCommand(await f.prepare()));
      const workId = imported.workId;
      const chapterId = imported.chapterIds[0];
      const intent =
        kind === "rename-work"
          ? { kind, workId, title: "New work title" }
          : kind === "rename-chapter"
            ? { kind, workId, chapterId, title: "New chapter title" }
            : { kind, workId: "work", chapterIds: ["chapter"] };
      const command = await f.command(intent);
      expect(notify).not.toHaveBeenCalled();
      const saved = await f.apply(command);
      if (kind === "reorder-chapters") {
        expect(saved.status).toBe("unchanged");
        expect(notify).not.toHaveBeenCalled();
        return;
      }
      expect(notify).toHaveBeenCalledExactlyOnceWith({
        workId,
        ...(kind === "rename-chapter" ? { chapterId } : {}),
      });
      expect(await f.apply(command)).toMatchObject({ historical: true });
      expect(notify).toHaveBeenCalledTimes(1);
      await f.restart();
      const undo = await f.recover(saved.id, "undo");
      expect(notify).toHaveBeenCalledTimes(2);
      await f.call("carrot_undo_library_change", undo.input);
      await f.apply(command);
      expect(notify).toHaveBeenCalledTimes(2);
      await f.recover(saved.id, "redo");
      expect(notify).toHaveBeenCalledTimes(3);
      await expect(
        f.apply({ ...command, requestId: randomUUID() }),
      ).rejects.toThrow();
      expect(notify).toHaveBeenCalledTimes(3);
    } finally {
      await f.close();
    }
  },
);

it("preserves committed recovery and returns a warning if the renderer notification fails", async () => {
  const notify = vi.fn(() => {
    throw new Error("Synthetic renderer closed");
  });
  const f = await libraryOrganizationFixture(notify);
  try {
    const command = await f.command({
      kind: "rename-work",
      workId: "work",
      title: "Durably saved",
    });
    const saved = await f.apply(command);
    expect(saved).toMatchObject({
      status: "saved",
      warnings: ["notification_failed_after_commit"],
    });
    expect(
      (await f.library.listLibrary()).works.find((work) => work.id === "work")
        ?.title,
    ).toBe("Durably saved");
    await f.restart();
    expect(await f.inspectChange(saved.id)).toMatchObject({ canUndo: true });
    expect(await f.apply(command)).toMatchObject({ historical: true });
    expect(notify).toHaveBeenCalledOnce();
  } finally {
    await f.close();
  }
});

it("does not announce an edit whose encrypted record could not be published", async () => {
  const notify = vi.fn();
  const f = await libraryOrganizationFixture(notify);
  try {
    const command = await f.command({
      kind: "rename-work",
      workId: "work",
      title: "Must roll back",
    });
    const before = await f.library.listLibrary();
    const seal = f.storage.codec.seal;
    f.storage.codec.seal = async () => {
      throw new Error("Synthetic encryption failure");
    };
    await expect(f.apply(command)).rejects.toThrow(
      "Synthetic encryption failure",
    );
    f.storage.codec.seal = seal;
    expect(notify).not.toHaveBeenCalled();
    expect(await f.library.listLibrary()).toEqual(before);
  } finally {
    await f.close();
  }
});
