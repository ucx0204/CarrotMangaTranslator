import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { WorkDeletionRecordSchema } from "../src/main/application/mcpWorkDeletionState";
import { workDeletionFixture } from "./mcpWorkDeletion.fixture";

it.each([
  "encryption",
  "revocation",
  "expiry",
  "session-stop",
  "editor-open",
  "source-edit",
  "wrong-record",
] as const)(
  "preserves the work and unpublished recovery on late %s",
  async (failure) => {
    const f = await workDeletionFixture();
    let authorized = true;
    try {
      const input = await f.commandWork();
      const seal = f.codec.seal.bind(f.codec);
      const note = join(f.directory, "runs", "preserved", "note.txt");
      let injected = false;
      vi.spyOn(f.codec, "seal").mockImplementation(async (value) => {
        const record = WorkDeletionRecordSchema.safeParse(value);
        if (record.success && !injected) {
          injected = true;
          if (failure === "encryption")
            throw new Error("Injected work record failure");
          if (failure === "revocation") authorized = false;
          if (failure === "expiry") f.clock(record.data.expiresAt);
          if (failure === "session-stop") f.organization().stop();
          if (failure === "editor-open") f.editorOpen("chapter");
          if (failure === "source-edit")
            await writeFile(note, "Newer manual content");
          if (failure === "wrong-record")
            return seal({
              ...record.data,
              summary: {
                ...record.data.summary,
                workTitle: "Not the reviewed work",
              },
            });
        }
        return seal(value);
      });
      await expect(
        f.applyWork(
          input,
          f.auth("import-owner", () => {
            if (!authorized) throw new Error("Revoked work removal grant");
          }),
        ),
      ).rejects.toThrow();
      vi.restoreAllMocks();
      expect(injected).toBe(true);
      if (failure === "source-edit") {
        expect(await readFile(note, "utf8")).toBe("Newer manual content");
        for (const [path, bytes] of f.original)
          if (join(f.directory, path) !== note)
            expect(await readFile(join(f.directory, path))).toEqual(bytes);
      } else await f.assertWorkOriginal();
      expect((await f.storage.index()).entries).toEqual([]);
      expect(f.notify).not.toHaveBeenCalled();
      expect(f.app.jobs.gate.activities).toEqual([]);
    } finally {
      vi.restoreAllMocks();
      await f.close();
    }
  },
);

it.each(["record-encryption", "staged-work-bytes"] as const)(
  "does not publish an incomplete restored work when %s fails",
  async (failure) => {
    const f = await workDeletionFixture();
    try {
      const saved = await f.applyWork(await f.commandWork());
      const original = await f.storage.record(saved.id);
      const seal = f.codec.seal.bind(f.codec);
      let injected = false;
      vi.spyOn(f.codec, "seal").mockImplementation(async (value) => {
        const record = WorkDeletionRecordSchema.safeParse(value);
        if (record.success && record.data.actions.length === 1 && !injected) {
          injected = true;
          if (failure === "record-encryption")
            throw new Error("Restoration record failed");
          const root = join(f.env.libraryDir, ".transactions");
          const files = (await readdir(root, { recursive: true })).filter(
            (path) => /[\\/]work\.json$/u.test(path),
          );
          expect(files).toHaveLength(1);
          await writeFile(join(root, files[0]), "Changed staged original");
        }
        return seal(value);
      });
      await expect(f.recoverWork(saved.id, "undo")).rejects.toThrow();
      vi.restoreAllMocks();
      expect(injected).toBe(true);
      await expect(lstat(f.workDirectory)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await f.storage.record(saved.id)).toEqual(original);
      expect((await f.inspectWork(saved.id)).canUndo).toBe(true);
      await f.recoverWork(saved.id, "undo");
      await f.assertWorkOriginal();
    } finally {
      vi.restoreAllMocks();
      await f.close();
    }
  },
);
