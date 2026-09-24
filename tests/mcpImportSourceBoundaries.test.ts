import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { importDuplicateFixture } from "./mcpImportDuplicate.fixture";

it("rejects foreign previews, stale destinations and forged source metadata without publishing or starting another source operation", async () => {
  const f = await importDuplicateFixture();
  try {
    const input = await f.command(await f.prepare());
    input.target = await f.target("work");
    await expect(f.review(input, f.auth("other"))).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      f.review({
        ...input,
        target: { ...input.target, snapshot: "0".repeat(16) },
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    await expect(
      f.invoke("carrot_get_import_duplicates", {
        previewId: input.previewId,
        snapshot: input.snapshot,
        target: input.target,
        chapters: input.chapters,
        importSource: { selectionSha256: "a".repeat(64) },
      }),
    ).rejects.toThrow();
    const before = await f.library.listLibrary();
    expect((await f.review(input)).untrackedChapterCount).toBe(1);
    expect(await f.library.listLibrary()).toEqual(before);
    expect(f.choose).toHaveBeenCalledOnce();
    expect(f.web.scan).not.toHaveBeenCalled();
    expect(f.validate).not.toHaveBeenCalled();
    const saved = await f.create({ ...input, duplicatePolicy: "reject-known" });
    expect(saved.workId).toBe("work");
  } finally {
    await f.close();
  }
});

it("rechecks changed chapter provenance after encryption even when the destination membership revision is unchanged", async () => {
  const f = await importDuplicateFixture();
  try {
    const input = await f.command(await f.prepare());
    input.target = await f.target("work");
    const before = await f.library.listLibrary();
    const chapterPath = f.chapterPath;
    let changed = false;
    const seal = f.codec.seal.bind(f.codec);
    const hook = vi.spyOn(f.codec, "seal").mockImplementation(async (value) => {
      const result = await seal(value);
      if (
        !changed &&
        value &&
        typeof value === "object" &&
        "receipt" in value
      ) {
        const proposed = value as {
          receipt: { workId: string; chapterIds: string[] };
        };
        // The staged chapter is not published yet. Its identity can be derived from
        // the actual selected source SHA values without replacing internal policies.
        const { createHash } = await import("node:crypto");
        const pageHashes = await Promise.all(
          f.originals.map(async (path) =>
            createHash("sha256")
              .update(await readFile(path))
              .digest("hex"),
          ),
        );
        expect(proposed.receipt.workId).toBe("work");
        const old = JSON.parse(await readFile(chapterPath, "utf8"));
        old.importSource = {
          version: 1,
          basis: "selected-input-bytes",
          pageCount: 2,
          selectionSha256: createHash("sha256")
            .update(JSON.stringify(pageHashes))
            .digest("hex"),
        };
        await writeFile(chapterPath, JSON.stringify(old));
        changed = true;
      }
      return result;
    });
    const done = await f.settle(
      await f.invoke("carrot_import_chapters", {
        ...input,
        duplicatePolicy: "reject-known",
      }),
    );
    hook.mockRestore();
    expect(changed).toBe(true);
    expect(done).toMatchObject({
      status: "failed",
      error: { code: "invalid_edit" },
    });
    expect(await f.library.listLibrary()).toEqual(before);
    expect((await f.storage.index()).entries).toEqual([]);
    expect((await f.review(input)).chapters[0].status).toBe("known-content");
    expect(
      JSON.parse(await readFile(chapterPath, "utf8")).importSource,
    ).toBeDefined();
  } finally {
    vi.restoreAllMocks();
    await f.close();
  }
});

it("preserves historical identity across chapter edits and rejects malformed stored provenance instead of inventing unseen state", async () => {
  const f = await importDuplicateFixture();
  try {
    const original = await f.command(await f.prepare());
    const receipt = await f.create(original);
    const path = join(
      f.env.libraryDir,
      "works",
      receipt.workId,
      "chapters",
      receipt.chapterIds[0],
      "chapter.json",
    );
    const stored = JSON.parse(await readFile(path, "utf8"));
    const later = {
      ...stored,
      title: "User renamed chapter",
      pageOrder: [...stored.pageOrder].reverse(),
    };
    await writeFile(path, JSON.stringify(later));
    const fresh = await f.command(await f.prepare());
    fresh.target = await f.target(receipt.workId);
    expect((await f.review(fresh)).chapters[0].status).toBe("known-content");
    const invalid = {
      ...later,
      importSource: {
        ...later.importSource,
        url: "https://example.com/private",
      },
    };
    await writeFile(path, JSON.stringify(invalid));
    await expect(f.review(fresh)).rejects.toThrow();
    await writeFile(path, JSON.stringify(later));
    const copy = await f.create({
      ...fresh,
      requestId: randomUUID(),
      duplicatePolicy: "allow",
    });
    expect(copy.chapterIds[0]).not.toBe(receipt.chapterIds[0]);
    expect(
      (await f.library.openChapter(receipt.chapterIds[0])).importSource,
    ).toEqual(stored.importSource);
  } finally {
    await f.close();
  }
});
