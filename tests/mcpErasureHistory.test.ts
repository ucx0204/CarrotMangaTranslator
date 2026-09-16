import { rm, writeFile, mkdir } from "node:fs/promises";
import { expect, it } from "vitest";
import { recoveryLibrary } from "./mcpErasureRecovery.fixture";
import { createPageRevision } from "../src/shared/pageRevision";

it("inspects, undoes and redoes via the actual library while preserving blocks, original and retained output", async () => {
  const f = await recoveryLibrary();
  try {
    const beforeInspect = await f.snapshot();
    expect(await f.inspect()).toMatchObject({
      state: "applied",
      reason: "ready",
      revision: createPageRevision(f.after),
    });
    expect(await f.snapshot()).toEqual(beforeInspect);
    const undone = await f.store.applySinglePageTransaction(
      f.transactionId,
      "undo",
      {
        ...f.target,
        revision: createPageRevision(f.after),
        assertCanCommit: () => {},
      },
    );
    expect(undone.revision).toBe(createPageRevision(f.before));
    expect(await f.inspect()).toMatchObject({ state: "undone" });
    const redone = await f.store.applySinglePageTransaction(
      f.transactionId,
      "redo",
      { ...f.target, revision: undone.revision, assertCanCommit: () => {} },
    );
    expect(redone.revision).toBe(createPageRevision(f.after));
    const page = (await f.library.openChapter("chapter")).pages[0];
    expect(page.blocks).toEqual(f.before.blocks);
    expect((await f.snapshot()).original).toBe("original-pixels");
    expect(f.store.getRetainedArtifactPaths("chapter")).toContain(f.output);
  } finally {
    await f.close();
  }
});

it("rejects later manual text or geometry instead of reverting it", async () => {
  const f = await recoveryLibrary();
  try {
    const blocks = structuredClone(f.after.blocks);
    blocks[0].translatedText = "manual edit";
    await f.library.savePageBlocks({
      chapterId: "chapter",
      pageId: f.target.pageId,
      blocks,
      expectedRevision: createPageRevision(f.after),
      blockOrder: f.after.blockOrder,
    });
    expect(await f.inspect()).toMatchObject({
      state: "conflict",
      reason: "page_changed",
    });
    const snapshot = await f.snapshot();
    await expect(
      f.store.applySinglePageTransaction(f.transactionId, "undo", {
        ...f.target,
        revision: createPageRevision(f.after),
        assertCanCommit: () => {},
      }),
    ).rejects.toThrow();
    expect(await f.snapshot()).toEqual(snapshot);
  } finally {
    await f.close();
  }
});

it.each(["undo", "redo"] as const)(
  "refuses the wrong %s state and revision without writes",
  async (direction) => {
    const f = await recoveryLibrary();
    try {
      const snapshot = await f.snapshot();
      await expect(
        f.store.applySinglePageTransaction(f.transactionId, direction, {
          ...f.target,
          revision: createPageRevision(f.before),
          assertCanCommit: () => {},
        }),
      ).rejects.toThrow();
      expect(await f.snapshot()).toEqual(snapshot);
    } finally {
      await f.close();
    }
  },
);

it.each(["missing", "empty", "directory"])(
  "refuses %s output artifacts",
  async (kind) => {
    const f = await recoveryLibrary();
    try {
      if (kind === "empty") await writeFile(f.output, "");
      else {
        await rm(f.output);
        if (kind === "directory") await mkdir(f.output);
      }
      expect(await f.inspect()).toMatchObject({
        state: "unavailable",
        reason: "artifact_missing",
      });
      const snapshot = await f.snapshot();
      await expect(
        f.store.applySinglePageTransaction(f.transactionId, "undo", {
          ...f.target,
          revision: createPageRevision(f.after),
          assertCanCommit: () => {},
        }),
      ).rejects.toThrow();
      expect(await f.snapshot()).toEqual(snapshot);
    } finally {
      await f.close();
    }
  },
);

it("treats released, empty and different-target history as unavailable", async () => {
  const f = await recoveryLibrary();
  try {
    const empty = f.store.beginTransaction();
    expect(
      await f.store.inspectSinglePageTransaction(empty, f.target),
    ).toMatchObject({ state: "unavailable" });
    expect(
      await f.store.inspectSinglePageTransaction(f.transactionId, {
        ...f.target,
        pageId: "other",
      }),
    ).toMatchObject({ state: "unavailable" });
    await f.store.releaseTransactions([f.transactionId]);
    expect(await f.inspect()).toMatchObject({
      state: "unavailable",
      reason: "history_unavailable",
    });
    await expect(
      f.store.applySinglePageTransaction(f.transactionId, "undo", {
        ...f.target,
        revision: createPageRevision(f.after),
        assertCanCommit: () => {},
      }),
    ).rejects.toThrow();
  } finally {
    await f.close();
  }
});

it("revokes at the real commit point without publishing or issuing a compensating write", async () => {
  const f = await recoveryLibrary();
  const { setLibraryTransactionCrashInjectorForTests } =
    await import("../src/main/libraryStore/libraryTransaction");
  let allowed = true;
  const reset = setLibraryTransactionCrashInjectorForTests((point) => {
    if (point === "before-commit-point") allowed = false;
  });
  try {
    const snapshot = await f.snapshot();
    await expect(
      f.store.applySinglePageTransaction(f.transactionId, "undo", {
        ...f.target,
        revision: createPageRevision(f.after),
        assertCanCommit: () => {
          if (!allowed) throw new Error("revoked at commit");
        },
      }),
    ).rejects.toThrow("revoked at commit");
    expect(await f.snapshot()).toEqual(snapshot);
    expect(await f.inspect()).toMatchObject({ state: "applied" });
  } finally {
    reset();
    await f.close();
  }
});
