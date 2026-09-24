import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { importPublicationFixture } from "./mcpImportPublication.fixture";
import { mcpLibraryImportOutputs } from "../src/shared/mcpLibraryImport";

it("publishes selected URL previews in reviewed order in one new work and preserves omitted items", async () => {
  const f = await importPublicationFixture();
  try {
    const original = await readFile(f.chapterPath);
    const input = f.publication;
    input.items = [input.items[2], input.items[0]];
    input.items[0].chapters[0].pageIds.reverse();
    input.items[1].chapters[0].pageIds =
      input.items[1].chapters[0].pageIds.slice(1);
    const receipt = await f.publish();
    expect(receipt).toMatchObject({
      pageCount: 3,
      source: "web",
      batch: { id: input.id },
    });
    expect(receipt.chapterIds).toHaveLength(2);
    expect(receipt.batch?.items.map((item) => item.itemId)).toEqual(
      input.items.map((item) => item.itemId),
    );
    expect(receipt.batch?.items.map((item) => item.chapterIds)).toEqual(
      receipt.chapterIds.map((id) => [id]),
    );
    for (const [index, id] of receipt.chapterIds.entries()) {
      const chapter = await f.library.openChapter(id);
      expect(chapter.title).toBe(input.items[index].chapters[0].title);
      expect(await readFile(chapter.pages[0].imagePath)).toEqual(
        await readFile(f.originals[1]),
      );
      expect(
        chapter.pages.map((page) =>
          page.imagePath.replaceAll("\\", "/").split("/").at(-1),
        ),
      ).toEqual(index === 0 ? ["1.png", "2.png"] : ["1.png"]);
    }
    expect((await f.library.listLibrary()).works).toHaveLength(2);
    expect(await readFile(f.chapterPath)).toEqual(original);
    const view = await f.get(input.id);
    expect(view.version).toBe(input.version + 1);
    expect(view.items.map((item) => item.status)).toEqual([
      "imported",
      "ready",
      "imported",
    ]);
    expect(f.web.scan).toHaveBeenCalledTimes(3);
    expect(f.validate).toHaveBeenCalledTimes(3);
  } finally {
    await f.close();
  }
});

it("appends later reviewed selections using the new destination snapshot without touching prior chapters", async () => {
  const f = await importPublicationFixture(2);
  try {
    const target = mcpLibraryImportOutputs.carrot_get_import_target.parse(
      await f.invoke("carrot_get_import_target", { workId: "work" }),
    );
    const original = await readFile(f.chapterPath);
    const remaining = f.publication.items[1];
    f.publication.target = {
      mode: "existing",
      workId: "work",
      snapshot: target.snapshot,
    };
    f.publication.items = [f.publication.items[0]];
    await f.publish();
    const stale = {
      ...f.publication,
      requestId: randomUUID(),
      version: (await f.get(f.publication.id)).version,
      items: [remaining],
    };
    const failure = await f.settle(
      await f.invoke("carrot_import_batch_chapters", stale),
    );
    expect(failure).toMatchObject({
      status: "failed",
      error: { code: "revision_conflict" },
    });
    const current = mcpLibraryImportOutputs.carrot_get_import_target.parse(
      await f.invoke("carrot_get_import_target", { workId: "work" }),
    );
    const receipt = await f.publish({
      ...stale,
      requestId: randomUUID(),
      target: { mode: "existing", workId: "work", snapshot: current.snapshot },
    });
    expect(receipt.workId).toBe("work");
    expect((await f.get(f.publication.id)).status).toBe("completed");
    expect((await f.library.listLibrary()).works).toHaveLength(1);
    expect(await readFile(f.chapterPath)).toEqual(original);
  } finally {
    await f.close();
  }
});

it("replays a grouped receipt after restart without source bytes or duplicate chapters, retaining progress after receipt disposal", async () => {
  const f = await importPublicationFixture(2);
  try {
    const receipt = await f.publish();
    const imported = await f.library.listLibrary();
    await f.restart();
    expect(await f.publish()).toEqual(receipt);
    expect(await f.library.listLibrary()).toEqual(imported);
    expect(f.web.scan).toHaveBeenCalledTimes(2);
    expect(f.validate).toHaveBeenCalledTimes(4);
    const { McpRetentionCatalog } =
      await import("../src/main/mcp/mcpRetentionCatalog");
    await new McpRetentionCatalog(
      f.storage,
      new AbortController().signal,
      false,
    ).discard("import-owner", receipt.id, () => {});
    await f.restart();
    const view = await f.get(f.publication.id);
    expect(view.items.every((item) => item.status === "imported")).toBe(true);
    const duplicate = {
      ...f.publication,
      requestId: randomUUID(),
      version: view.version,
    };
    const done = await f.settle(
      await f.invoke("carrot_import_batch_chapters", duplicate),
    );
    expect(done).toMatchObject({
      status: "failed",
      error: { code: "invalid_edit" },
    });
    expect(await f.library.listLibrary()).toEqual(imported);
  } finally {
    await f.close();
  }
});
