import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { workDeletionFixture } from "./mcpWorkDeletion.fixture";

it("does not restore a deleted work when one of its chapter IDs now belongs to another work", async () => {
  const f = await workDeletionFixture();
  try {
    const saved = await f.applyWork(await f.commandWork());
    const directory = join(f.destinationRoot, "chapters", "chapter");
    await mkdir(directory);
    const other = JSON.parse(
      await readFile(
        join(f.destinationRoot, "chapters", "dest-chapter", "chapter.json"),
        "utf8",
      ),
    );
    await writeFile(
      join(directory, "chapter.json"),
      JSON.stringify({ ...other, id: "chapter" }),
    );
    const work = {
      ...f.destinationWork,
      chapterOrder: ["dest-chapter", "chapter"],
    };
    await writeFile(join(f.destinationRoot, "work.json"), JSON.stringify(work));
    await expect(
      f.call("carrot_undo_work_deletion", {
        id: saved.id,
        snapshot: saved.snapshot,
        requestId: randomUUID(),
        confirm: true,
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    await expect(lstat(f.workDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      JSON.parse(await readFile(join(f.destinationRoot, "work.json"), "utf8")),
    ).toEqual(work);
    expect(JSON.parse(await readFile(f.indexPath, "utf8"))).toEqual({
      workOrder: ["destination"],
    });
  } finally {
    await f.close();
  }
});
