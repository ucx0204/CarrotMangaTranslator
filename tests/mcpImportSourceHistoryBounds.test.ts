import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { importDuplicateFixture } from "./mcpImportDuplicate.fixture";

it.each(["over-limit", "missing-chapter"] as const)(
  "does not treat %s destination history as unseen or publish from it",
  async (kind) => {
    const f = await importDuplicateFixture();
    const workPath = join(f.env.libraryDir, "works", "work", "work.json");
    const originalWork = await readFile(workPath);
    const originalChapter = await readFile(f.chapterPath);
    const originalImages = await Promise.all(
      f.originals.map((path) => readFile(path)),
    );
    try {
      const ref = await f.prepare();
      const input = await f.command(ref);
      input.target = await f.target("work");
      const work = JSON.parse(originalWork.toString("utf8"));
      work.chapterOrder =
        kind === "over-limit"
          ? Array.from({ length: 2001 }, (_, index) => `history-${index}`)
          : [...work.chapterOrder, "missing-history-chapter"];
      await writeFile(workPath, JSON.stringify(work));
      const changedWork = await readFile(workPath);
      if (kind === "over-limit") {
        // The canonical work-file reader rejects 2,001 entries before the
        // duplicate policy can read a destination snapshot or any chapter.
        await expect(f.target("work")).rejects.toThrow(/chapterOrder.*2000/);
        await expect(f.review(input)).rejects.toThrow(/chapterOrder.*2000/);
      } else {
        input.target = await f.target("work");
        await expect(f.review(input)).rejects.toMatchObject({
          code: "revision_conflict",
        });
      }
      expect((await f.inspect(ref)).status).toBe("ready");
      const rejected = await f.settle(
        await f.invoke("carrot_import_chapters", {
          ...input,
          duplicatePolicy: "reject-known",
        }),
      );
      expect(rejected.status).toBe("failed");
      if (kind === "missing-chapter")
        expect(rejected.error).toMatchObject({ code: "revision_conflict" });
      expect(f.validate).not.toHaveBeenCalled();
      expect(f.web.scan).not.toHaveBeenCalled();
      expect((await f.storage.index()).entries).toEqual([]);
      expect(await readFile(workPath)).toEqual(changedWork);
      expect(await readFile(f.chapterPath)).toEqual(originalChapter);
      expect(
        await Promise.all(f.originals.map((path) => readFile(path))),
      ).toEqual(originalImages);
    } finally {
      await writeFile(workPath, originalWork);
      await f.close();
    }
  },
);
