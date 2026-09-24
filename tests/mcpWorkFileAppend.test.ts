import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { workFileAppendFixture } from "./mcpWorkFileAppend.fixture";

it("reviews append without mutation and preserves existing chapters, guide and editable imported content", async () => {
  const f = await workFileAppendFixture();
  try {
    const before = await f.capture();
    const { input, review, command } = await f.prepareAppend();
    expect(review).toMatchObject({
      eligible: true,
      preservedChapterCount: 1,
      referenceIssues: [],
    });
    expect(await f.inspectAppend(input)).toEqual(review);
    expect(await f.capture()).toEqual(before);
    expect(f.validateShare).not.toHaveBeenCalled();
    const receipt = await f.createWorkFile(command);
    expect(receipt.workId).toBe("work");
    expect(receipt.chapterIds).toHaveLength(1);
    const current = await f.capture();
    expect(current.chapter).toEqual(before.chapter);
    expect(current.guide).toEqual(before.guide);
    expect(current.library.works).toHaveLength(before.library.works.length);
    expect(JSON.parse(current.work.toString()).chapterOrder).toEqual([
      "chapter",
      ...receipt.chapterIds,
    ]);
    const added = await f.library.openChapter(receipt.chapterIds[0]);
    expect(added.title).toBe(review.chapters[0].title);
    expect(added.title).not.toBe(f.originalChapter.title);
    expect(added.pages[0].blockOrder).toEqual(
      added.pages[0].blocks.map((block) => block.id).reverse(),
    );
    expect(added.pages[0].blocks.map(({ id: _id, ...block }) => block)).toEqual(
      f.originalChapter.pages[0].blocks.map(({ id: _id, ...block }) => block),
    );
    expect(await readFile(added.pages[0].imagePath)).toEqual(
      await readFile(f.originalChapter.pages[0].imagePath),
    );
    expect(await readFile(f.packagePath)).toEqual(f.packageBytes);
    expect(JSON.stringify(review)).not.toMatch(/imagePath|sourcePath|dataUrl/);
  } finally {
    await f.close();
  }
});

it("replays append after upload disposal and reconstruction without duplicating existing or imported chapters", async () => {
  const f = await workFileAppendFixture();
  try {
    const { command } = await f.prepareAppend();
    const receipt = await f.createWorkFile(command);
    const before = await f.capture();
    await f.invoke("carrot_discard_file_upload", {
      uploadId: command.uploadId,
    });
    await f.restart();
    expect(await f.createWorkFile(command)).toEqual(receipt);
    vi.spyOn(f.persistence, "load").mockResolvedValueOnce(null);
    await f.restart();
    expect(await f.createWorkFile(command)).toEqual(receipt);
    expect(await f.capture()).toEqual(before);
    const { McpRetentionCatalog } =
      await import("../src/main/mcp/mcpRetentionCatalog");
    await new McpRetentionCatalog(
      f.storage,
      new AbortController().signal,
      false,
    ).discard("import-owner", receipt.id, () => {});
    expect(await f.capture()).toEqual(before);
  } finally {
    await f.close();
  }
});

it("rejects modified selection or reference policy under an old append target before image preparation", async () => {
  const f = await workFileAppendFixture();
  try {
    const { command } = await f.prepareAppend();
    const before = await f.capture();
    const changed = {
      ...command,
      chapters: [{ ...command.chapters[0], title: "Changed selection" }],
    };
    expect(
      (await f.settle(await f.invoke("carrot_import_work_file", changed)))
        .status,
    ).toBe("failed");
    await expect(
      f.invoke("carrot_import_work_file", {
        ...command,
        target: { ...command.target, contextPolicy: "replace" },
      }),
    ).rejects.toThrow();
    expect(f.validateShare).not.toHaveBeenCalled();
    expect(await f.capture()).toEqual(before);
  } finally {
    await f.close();
  }
});

it.each(["work", "guide"] as const)(
  "rejects stale %s state rather than overwriting a later edit",
  async (kind) => {
    const f = await workFileAppendFixture();
    try {
      const { command } = await f.prepareAppend();
      const path = kind === "work" ? f.workPath : f.guidePath;
      const value = JSON.parse(await readFile(path, "utf8"));
      if (kind === "work") value.title = "Later manual title";
      else value.rules.defaultTone = "literal";
      await writeFile(path, JSON.stringify(value));
      const before = await f.capture();
      expect(
        (await f.settle(await f.invoke("carrot_import_work_file", command)))
          .status,
      ).toBe("failed");
      expect(f.validateShare).not.toHaveBeenCalled();
      expect(await f.capture()).toEqual(before);
      expect((await f.storage.index()).entries).toEqual([]);
    } finally {
      await f.close();
    }
  },
);

it("rolls back append if the destination guide changes during native image preparation", async () => {
  const f = await workFileAppendFixture();
  try {
    const { command } = await f.prepareAppend();
    const before = await f.capture();
    const guide = JSON.parse(before.guide.toString());
    guide.rules.defaultTone = "literal";
    f.boundary.beforeImage = async () => {
      f.boundary.beforeImage = undefined;
      await writeFile(f.guidePath, JSON.stringify(guide));
    };
    expect(
      (await f.settle(await f.invoke("carrot_import_work_file", command)))
        .status,
    ).toBe("failed");
    expect(await readFile(f.workPath)).toEqual(before.work);
    expect(await readFile(f.chapterPath)).toEqual(before.chapter);
    expect(JSON.parse(await readFile(f.guidePath, "utf8"))).toEqual(guide);
    expect((await f.storage.index()).entries).toEqual([]);
    const { input } = await f.prepareAppend();
    const review = await f.inspectAppend(input);
    const saved = await f.createWorkFile({
      ...command,
      requestId: randomUUID(),
      uploadId: input.uploadId,
      snapshot: input.snapshot,
      target: review.target,
    });
    expect(saved.workId).toBe("work");
  } finally {
    await f.close();
  }
});
