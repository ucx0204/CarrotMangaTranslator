import { writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { PageDeletionRecordSchema } from "../src/main/application/mcpPageDeletionState";
import { pageDeletionFixture } from "./mcpPageDeletion.fixture";

it.each(["page", "memory", "after", "after-tree", "identity"] as const)(
  "rejects encrypted %s record tampering without restoring any page",
  async (kind) => {
    const f = await pageDeletionFixture();
    try {
      const saved = await f.applyPage(await f.commandPage());
      const original = PageDeletionRecordSchema.parse(
        await f.storage.record(saved.id),
      );
      const altered = structuredClone(original);
      if (kind === "page") altered.before.chapter.pages[0].name = "Forged page";
      if (kind === "memory" && altered.before.memory)
        altered.before.memory.pages[0].summary = "Forged memory";
      if (kind === "after") altered.after.chapter.title = "Forged after title";
      if (kind === "after-tree")
        altered.afterTree.files[0].sha256 = "0".repeat(64);
      if (kind === "identity") altered.createdAt += 1;
      const before = await f.capturePage();
      await writeFile(
        await f.storage.path(saved.id),
        JSON.stringify(await f.codec.seal(altered)),
      );
      await expect(f.inspectPage(saved.id)).rejects.toThrow();
      await expect(f.recoverPage(saved.id, "undo")).rejects.toThrow();
      await expect(
        f.call("carrot_discard_page_deletion", { id: saved.id, confirm: true }),
      ).rejects.toThrow();
      expect(await f.capturePage()).toEqual(before);
      await writeFile(
        await f.storage.path(saved.id),
        JSON.stringify(await f.codec.seal(original)),
      );
      await f.restart();
      await f.recoverPage(saved.id, "undo");
      await f.assertPageOriginal();
    } finally {
      await f.close();
    }
  },
);

it("verifies archived bytes and retained-index identity rather than trusting encryption success", async () => {
  const f = await pageDeletionFixture();
  try {
    const saved = await f.applyPage(await f.commandPage());
    const originalIndex = await f.storage.index();
    const changed = structuredClone(originalIndex);
    changed.entries[0].operation = "another-operation";
    await writeFile(
      await f.storage.path(),
      JSON.stringify(await f.codec.seal(changed)),
    );
    await expect(f.inspectPage(saved.id)).rejects.toThrow(/catalog/);
    await writeFile(
      await f.storage.path(),
      JSON.stringify(await f.codec.seal(originalIndex)),
    );
    const record = PageDeletionRecordSchema.parse(
      await f.storage.record(saved.id),
    );
    const hash = record.parts.flat()[0];
    await writeFile(
      await f.storage.path(saved.id, hash),
      JSON.stringify(
        await f.codec.seal({
          chunk: Buffer.from("Wrong bytes").toString("base64"),
        }),
      ),
    );
    await expect(f.inspectPage(saved.id)).rejects.toThrow(/inconsistent/);
    expect(
      (await f.library.openChapter(f.pageTarget.chapterId)).pages,
    ).toHaveLength(1);
    expect(f.app.jobs.gate.activities).toEqual([]);
  } finally {
    await f.close();
  }
});
