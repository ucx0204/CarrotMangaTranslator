import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { chapterMoveFixture } from "./mcpChapterMove.fixture";

it.each(["work", "destination"])(
  "native deletion retires only the selected %s work and preserves external source files",
  async (workId) => {
    const f = await chapterMoveFixture();
    try {
      const other = workId === "work" ? "destination" : "work";
      const path = join(f.env.libraryDir, "works", other, "work.json");
      const before = await readFile(path);
      const originals = await Promise.all(
        f.originals.map((file) => readFile(file)),
      );
      await f.library.deleteWork(workId);
      await expect(
        lstat(join(f.env.libraryDir, "works", workId)),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        JSON.parse(
          await readFile(join(f.env.libraryDir, "index.json"), "utf8"),
        ),
      ).toEqual({ workOrder: [other] });
      expect(await readFile(path)).toEqual(before);
      expect(
        await Promise.all(f.originals.map((file) => readFile(file))),
      ).toEqual(originals);
      expect((await f.storage.index()).entries).toEqual([]);
      await expect(f.library.deleteWork(workId)).rejects.toThrow();
    } finally {
      await f.close();
    }
  },
);
