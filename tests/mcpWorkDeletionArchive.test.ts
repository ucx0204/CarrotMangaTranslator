import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { workDeletionFixture } from "./mcpWorkDeletion.fixture";
import { WorkDeletionRecordSchema } from "../src/main/application/mcpWorkDeletionState";

it("rejects a validly encrypted forged chapter summary before trusting its editor-probe targets", async () => {
  const f = await workDeletionFixture();
  try {
    const saved = await f.applyWork(await f.commandWork());
    const original = WorkDeletionRecordSchema.parse(
      await f.storage.record(saved.id),
    );
    const changed = structuredClone(original);
    changed.summary.chapters[0].chapterId = "other-chapter";
    expect(WorkDeletionRecordSchema.safeParse(changed).success).toBe(true);
    await writeFile(
      await f.storage.path(saved.id),
      JSON.stringify(await f.codec.seal(changed)),
    );
    await expect(f.inspectWork(saved.id)).rejects.toThrow(
      /verified archived chapters/,
    );
    await expect(
      f.call("carrot_undo_work_deletion", {
        id: saved.id,
        snapshot: saved.snapshot,
        requestId: randomUUID(),
        confirm: true,
      }),
    ).rejects.toThrow(/verified archived chapters/);
    await writeFile(
      await f.storage.path(saved.id),
      JSON.stringify(await f.codec.seal(original)),
    );
    await f.recoverWork(saved.id, "undo");
    await f.assertWorkOriginal();
  } finally {
    await f.close();
  }
});

it("keeps chapter-root defaults strict while bounding metadata decoding to recorded files", async () => {
  const f = await workDeletionFixture();
  try {
    const saved = await f.applyWork(await f.commandWork());
    const record = WorkDeletionRecordSchema.parse(
      await f.storage.record(saved.id),
    );
    const files = await import("../src/main/mcp/mcpChapterDeletionFiles");
    expect(() => files.validateChapterDeletionTree(record.tree)).toThrow(
      /metadata/,
    );
    await expect(
      files.readRecoveryMetadata(
        f.storage,
        record,
        "not-recorded.json",
        () => {},
      ),
    ).rejects.toThrow(/absent/);
    await expect(
      files.readRecoveryMetadata(f.storage, record, "../work.json", () => {}),
    ).rejects.toThrow();
    const huge = structuredClone(record);
    const entry = huge.tree.files.find((file) => file.path === "work.json");
    if (!entry) throw new Error("Missing work fixture metadata");
    entry.bytes = 4 * 1024 * 1024 + 1;
    await expect(
      files.readRecoveryMetadata(f.storage, huge, "work.json", () => {}),
    ).rejects.toThrow(/4 MiB/);
    await f.recoverWork(saved.id, "undo");
    expect(
      await files.readRecoveryMetadata(
        f.storage,
        record,
        "work.json",
        () => {},
      ),
    ).toEqual(f.source.work);
    await f.assertWorkOriginal();
    expect((await readFile(f.chapterPath)).length).toBeGreaterThan(0);
  } finally {
    await f.close();
  }
});
