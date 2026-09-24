import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { importPublicationFixture } from "./mcpImportPublication.fixture";
import { mcpLibraryImportOutputs } from "../src/shared/mcpLibraryImport";

it.each(["encryption", "revocation", "expiry"] as const)(
  "rolls back every chapter, receipt and batch checkpoint after late %s failure",
  async (failure) => {
    const f = await importPublicationFixture(2);
    const { McpEditError } =
      await import("../src/main/application/mcpEditPolicy");
    let allowed = true;
    const guard = () => {
      if (!allowed)
        throw new McpEditError("access_denied", "Fixture grant revoked");
    };
    try {
      const before = await f.library.listLibrary();
      const index = await f.storage.index();
      const plan = await f.storage.record(f.publication.id);
      const expiry = (await f.get(f.publication.id)).items[0].preview
        ?.expiresAt;
      if (!expiry) throw new Error("Missing preview expiry");
      const seal = f.codec.seal.bind(f.codec);
      const spy = vi
        .spyOn(f.codec, "seal")
        .mockImplementation(async (value) => {
          const encrypted = await seal(value);
          if (value && typeof value === "object" && "receipt" in value) {
            if (failure === "encryption")
              throw new Error("Fixture encryption failure");
            if (failure === "revocation") allowed = false;
            if (failure === "expiry") f.clock(expiry);
          }
          return encrypted;
        });
      const done = await f.settle(
        await f.invoke(
          "carrot_import_batch_chapters",
          f.publication,
          f.auth("import-owner", guard),
        ),
      );
      expect(done.status).toBe("failed");
      expect(f.validate).toHaveBeenCalledTimes(4);
      spy.mockRestore();
      expect(await f.library.listLibrary()).toEqual(before);
      expect(await f.storage.index()).toEqual(index);
      expect(await f.storage.record(f.publication.id)).toEqual(plan);
      expect(await readFile(f.originals[0])).toEqual(f.bytes);
      if (failure !== "expiry") {
        allowed = true;
        const receipt = await f.publish({
          ...f.publication,
          requestId: randomUUID(),
        });
        expect(receipt.chapterIds).toHaveLength(2);
      }
    } finally {
      await f.close();
    }
  },
);

it("preserves all committed chapters and parent progress after a lost response without importing again", async () => {
  const f = await importPublicationFixture(2);
  const tx = await import("../src/main/libraryStore/libraryTransaction");
  let removeCrash = () => {};
  try {
    removeCrash = tx.setLibraryTransactionCrashInjectorForTests((point) => {
      if (point === "after-commit-point")
        throw new tx.SimulatedLibraryTransactionCrash(point);
    });
    const done = await f.settle(
      await f.invoke("carrot_import_batch_chapters", f.publication),
    );
    expect(["completed", "failed"]).toContain(done.status);
    removeCrash();
    const receipt = mcpLibraryImportOutputs.carrot_get_import_receipt.parse(
      await f.invoke("carrot_get_import_receipt", {
        requestId: f.publication.requestId,
      }),
    );
    expect(receipt.availableChapterIds).toHaveLength(2);
    expect(
      (await f.get(f.publication.id)).items.every(
        (item) => item.status === "imported",
      ),
    ).toBe(true);
    const before = await f.library.listLibrary();
    await f.restart();
    // Lose the independent job journal as well; the native retained receipt remains authoritative.
    await f.persistence.save(null);
    await f.restart();
    const replay = await f.publish();
    expect(replay.id).toBe(receipt.id);
    expect(await f.library.listLibrary()).toEqual(before);
    expect(f.validate).toHaveBeenCalledTimes(4);
    expect(f.web.scan).toHaveBeenCalledTimes(2);
  } finally {
    removeCrash();
    await f.close();
  }
});

it("cancels an active group before publication and rejects disposal while encrypted staging is pending", async () => {
  const f = await importPublicationFixture(2);
  let release!: () => void;
  const stalled = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let cancellation: Promise<unknown> | undefined;
  try {
    const before = await f.library.listLibrary();
    const seal = f.codec.seal.bind(f.codec);
    const spy = vi.spyOn(f.codec, "seal").mockImplementation(async (value) => {
      const encrypted = await seal(value);
      if (value && typeof value === "object" && "receipt" in value) {
        entered();
        await stalled;
      }
      return encrypted;
    });
    const accepted = await f.invoke(
      "carrot_import_batch_chapters",
      f.publication,
    );
    await started;
    await expect(
      f.invoke("carrot_discard_import_batch", {
        id: f.publication.id,
        confirm: true,
      }),
    ).rejects.toMatchObject({ code: "editor_busy" });
    cancellation = f.invoke("carrot_cancel_import_batch", {
      id: f.publication.id,
    });
    release();
    const done = await f.settle(accepted);
    await cancellation;
    spy.mockRestore();
    expect(done.status).toBe("cancelled");
    expect(await f.library.listLibrary()).toEqual(before);
    expect(
      (await f.get(f.publication.id)).items.map((item) => item.status),
    ).toEqual(["ready", "ready"]);
    expect(
      (await f.storage.index()).entries.filter(
        (entry) => entry.kind === "import",
      ),
    ).toEqual([]);
  } finally {
    release();
    await cancellation;
    await f.close();
  }
});
