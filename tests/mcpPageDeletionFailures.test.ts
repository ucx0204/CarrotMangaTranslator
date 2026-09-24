import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { PageDeletionRecordSchema } from "../src/main/application/mcpPageDeletionState";
import { pageDeletionFixture } from "./mcpPageDeletion.fixture";

it.each([
  "encryption",
  "revocation",
  "expiry",
  "session-stop",
  "editor-open",
  "source-edit",
] as const)(
  "preserves page, memory and unpublished recovery after late %s",
  async (failure) => {
    const f = await pageDeletionFixture();
    let authorized = true;
    try {
      const input = await f.commandPage();
      const seal = f.codec.seal.bind(f.codec);
      let injected = false;
      vi.spyOn(f.codec, "seal").mockImplementation(async (value) => {
        const result = await seal(value);
        const parsed = PageDeletionRecordSchema.safeParse(value);
        if (!injected && parsed.success) {
          injected = true;
          if (failure === "encryption")
            throw new Error("Injected page record failure");
          if (failure === "revocation") authorized = false;
          if (failure === "expiry") f.clock(parsed.data.expiresAt);
          if (failure === "session-stop") f.organization().stop();
          if (failure === "editor-open") f.editorOpen(f.pageTarget.chapterId);
          if (failure === "source-edit")
            await writeFile(f.sibling.imagePath, "Later sibling bytes");
        }
        return result;
      });
      await expect(
        f.applyPage(
          input,
          f.auth("import-owner", () => {
            if (!authorized) throw new Error("Revoked page removal grant");
          }),
        ),
      ).rejects.toThrow();
      vi.restoreAllMocks();
      expect(injected).toBe(true);
      if (failure === "source-edit") {
        expect(await readFile(f.sibling.imagePath, "utf8")).toBe(
          "Later sibling bytes",
        );
        expect(
          (await f.library.openChapter(f.pageTarget.chapterId)).pages,
        ).toHaveLength(2);
        expect(await readFile(f.memoryPath)).toEqual(f.originalMemory);
      } else await f.assertPageOriginal();
      expect((await f.storage.index()).entries).toEqual([]);
      expect(f.notify).not.toHaveBeenCalled();
      expect(f.app.jobs.gate.activities).toEqual([]);
    } finally {
      vi.restoreAllMocks();
      await f.close();
    }
  },
);

it.each(["record-encryption", "restored-artifact"] as const)(
  "does not commit an incomplete page restoration on %s failure",
  async (failure) => {
    const f = await pageDeletionFixture();
    try {
      const saved = await f.applyPage(await f.commandPage());
      const before = await f.capturePage();
      const record = await f.storage.record(saved.id);
      const seal = f.codec.seal.bind(f.codec);
      let injected = false;
      vi.spyOn(f.codec, "seal").mockImplementation(async (value) => {
        const parsed = PageDeletionRecordSchema.safeParse(value);
        if (!injected && parsed.success && parsed.data.actions.length === 1) {
          injected = true;
          if (failure === "record-encryption")
            throw new Error("Undo record failed");
          const root = join(f.env.libraryDir, ".transactions");
          const paths = (await readdir(root, { recursive: true })).filter(
            (path) => /[\\/]original\.bin$/u.test(path),
          );
          expect(paths).toHaveLength(1);
          await writeFile(
            join(root, paths[0]),
            "Wrong restored artifact bytes",
          );
        }
        return seal(value);
      });
      await expect(f.recoverPage(saved.id, "undo")).rejects.toThrow();
      vi.restoreAllMocks();
      expect(injected).toBe(true);
      expect(await f.capturePage()).toEqual(before);
      expect(await f.storage.record(saved.id)).toEqual(record);
      expect((await f.inspectPage(saved.id)).canUndo).toBe(true);
      await f.restart();
      await f.recoverPage(saved.id, "undo");
      await f.assertPageOriginal();
    } finally {
      vi.restoreAllMocks();
      await f.close();
    }
  },
);
