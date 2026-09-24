import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { importPublicationFixture } from "./mcpImportPublication.fixture";
import { mcpLibraryImportOutputs } from "../src/shared/mcpLibraryImport";
import { mcpImportDuplicateOutputs } from "../src/shared/mcpImportDuplicates";

it("detects duplicate content within one new group without changing parent progress or importing any sibling", async () => {
  const f = await importPublicationFixture(2);
  try {
    const before = await f.library.listLibrary();
    const plan = await f.get(f.publication.id);
    const done = await f.settle(
      await f.invoke("carrot_import_batch_chapters", {
        ...f.publication,
        duplicatePolicy: "reject-known",
      }),
    );
    expect(done).toMatchObject({
      status: "failed",
      error: { code: "invalid_edit" },
    });
    expect(await f.library.listLibrary()).toEqual(before);
    expect((await f.get(plan.id)).version).toBe(plan.version);
    expect((await f.get(plan.id)).items.map((item) => item.status)).toEqual([
      "ready",
      "ready",
    ]);
    const receipt = await f.publish({
      ...f.publication,
      requestId: randomUUID(),
      duplicatePolicy: "allow",
    });
    const chapters = await Promise.all(
      receipt.chapterIds.map((id) => f.library.openChapter(id)),
    );
    expect(chapters[0].importSource?.selectionSha256).toBe(
      chapters[1].importSource?.selectionSha256,
    );
    expect(chapters[0].importSource?.urlSha256).not.toBe(
      chapters[1].importSource?.urlSha256,
    );
  } finally {
    await f.close();
  }
});

it("omits a known earlier chapter explicitly and publishes only the unseen selection without rescanning", async () => {
  const f = await importPublicationFixture(2);
  try {
    const seed = await f.command(await f.prepare());
    seed.chapters[0].pageIds = seed.chapters[0].pageIds.slice(0, 1);
    const first = await f.create(seed);
    const before = await f.library.openChapter(first.chapterIds[0]);
    const original = await readFile(before.pages[0].imagePath);
    const target = mcpLibraryImportOutputs.carrot_get_import_target.parse(
      await f.invoke("carrot_get_import_target", { workId: first.workId }),
    );
    const input = structuredClone(f.publication);
    input.target = {
      mode: "existing",
      workId: first.workId,
      snapshot: target.snapshot,
    };
    input.items[0].chapters[0].pageIds =
      input.items[0].chapters[0].pageIds.slice(0, 1);
    input.items[1].chapters[0].pageIds =
      input.items[1].chapters[0].pageIds.slice(1);
    const statuses: string[] = [];
    for (const item of input.items) {
      const review =
        mcpImportDuplicateOutputs.carrot_get_import_duplicates.parse(
          await f.invoke("carrot_get_import_duplicates", {
            previewId: item.previewId,
            snapshot: item.snapshot,
            target: input.target,
            chapters: item.chapters,
          }),
        );
      statuses.push(review.chapters[0].status);
    }
    expect(statuses).toEqual(["known-content", "unseen"]);
    const rejected = await f.settle(
      await f.invoke("carrot_import_batch_chapters", {
        ...input,
        duplicatePolicy: "reject-known",
      }),
    );
    expect(rejected.status).toBe("failed");
    input.requestId = randomUUID();
    input.items = input.items.slice(1);
    input.duplicatePolicy = "reject-known";
    const result = await f.publish(input);
    expect(result.pageCount).toBe(1);
    expect(result.workId).toBe(first.workId);
    expect(await readFile(before.pages[0].imagePath)).toEqual(original);
    expect(
      await readFile(
        (await f.library.openChapter(result.chapterIds[0])).pages[0].imagePath,
      ),
    ).toEqual(await readFile(f.originals[1]));
    expect((await f.get(input.id)).items.map((item) => item.status)).toEqual([
      "ready",
      "imported",
    ]);
    expect(f.web.scan).toHaveBeenCalledTimes(2);
  } finally {
    await f.close();
  }
});
