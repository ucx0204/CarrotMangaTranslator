import { copyFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { importDuplicateFixture } from "./mcpImportDuplicate.fixture";

it("retains original input identity beyond receipt expiry and rejects a fresh renamed duplicate without changing artwork", async () => {
  const f = await importDuplicateFixture();
  try {
    const first = await f.command(await f.prepare());
    const receipt = await f.create(first);
    const saved = await f.library.openChapter(receipt.chapterIds[0]);
    expect(saved.importSource).toMatchObject({
      version: 1,
      basis: "selected-input-bytes",
      pageCount: 2,
    });
    const before = await readFile(saved.pages[0].imagePath);
    f.clock(receipt.expiresAt + 1);
    await f.restart();
    await expect(
      f.invoke("carrot_get_import_receipt", { requestId: first.requestId }),
    ).rejects.toThrow();
    const copies = [
      join(f.env.root, "renamed-A.png"),
      join(f.env.root, "renamed-B.png"),
    ];
    await Promise.all(
      copies.map((path, index) => copyFile(f.originals[index], path)),
    );
    f.choose.mockResolvedValue(copies);
    const second = await f.command(await f.prepare());
    second.target = await f.target(receipt.workId);
    const decoderCalls = f.validate.mock.calls.length;
    const review = await f.review(second);
    expect(review).toMatchObject({
      historicalOnly: true,
      historyChapterCount: 1,
      untrackedChapterCount: 0,
    });
    expect(review.chapters[0]).toMatchObject({
      status: "known-content",
      matches: [{ chapterId: saved.id, match: "content" }],
    });
    expect(f.validate).toHaveBeenCalledTimes(decoderCalls);
    const rejected = await f.settle(
      await f.invoke("carrot_import_chapters", {
        ...second,
        duplicatePolicy: "reject-known",
      }),
    );
    expect(rejected).toMatchObject({
      status: "failed",
      error: { code: "invalid_edit" },
    });
    expect((await f.target(receipt.workId)).snapshot).toBe(
      second.target.snapshot,
    );
    expect(await readFile(saved.pages[0].imagePath)).toEqual(before);
    expect((await f.library.openChapter(saved.id)).importSource).toEqual(
      saved.importSource,
    );
  } finally {
    await f.close();
  }
});

it("distinguishes URL history from equal selected bytes and never calls a matching title a duplicate", async () => {
  const f = await importDuplicateFixture();
  try {
    const original = await f.scan("https://example.com/chapter?id=1#start");
    const receipt = await f.create(original);
    const saved = await f.library.openChapter(receipt.chapterIds[0]);
    expect(JSON.stringify(saved.importSource)).not.toMatch(
      /example|chapter\?|sourcePath|authorized-input/,
    );
    const same = await f.scan("https://example.com/chapter?id=1#different");
    same.target = await f.target(receipt.workId);
    expect((await f.review(same)).chapters[0]).toMatchObject({
      status: "known-content",
      matches: [{ match: "content-and-url" }],
    });
    same.chapters[0].pageIds.reverse();
    expect((await f.review(same)).chapters[0]).toMatchObject({
      status: "known-url",
      matches: [{ match: "url" }],
    });
    const mirror = await f.scan("https://example.com/chapter?id=2");
    mirror.target = same.target;
    expect((await f.review(mirror)).chapters[0]).toMatchObject({
      status: "known-content",
      matches: [{ match: "content" }],
    });
    mirror.chapters[0].pageIds = mirror.chapters[0].pageIds.slice(0, 1);
    expect((await f.review(mirror)).chapters[0].status).toBe("unseen");
    const legacy = { ...mirror, target: await f.target("work") };
    expect(await f.review(legacy)).toMatchObject({
      untrackedChapterCount: 1,
      historyChapterCount: 0,
      chapters: [{ status: "unseen" }],
    });
    expect(f.web.scan).toHaveBeenCalledTimes(3);
  } finally {
    await f.close();
  }
});
