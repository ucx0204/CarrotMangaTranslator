import { randomUUID } from "node:crypto";
import { readFile, writeFile, access } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { retentionFixture } from "./mcpRetention.fixture";
import { createPageRevision } from "../src/shared/pageRevision";

it("keeps existing pages and records intact when encryption becomes unavailable", async () => {
  const f = await retentionFixture();
  try {
    await f.edit("saved while encryption available");
    const page = await readFile(f.chapterPath);
    const index = await readFile(await f.storage.path());
    const available = vi
      .spyOn(f.encryption, "available")
      .mockReturnValue(false);
    await expect(f.edit("must not save plaintext")).rejects.toThrow();
    expect(await readFile(f.chapterPath)).toEqual(page);
    expect(await readFile(await f.storage.path())).toEqual(index);
    available.mockRestore();
    expect((await f.list()).total).toBe(1);
  } finally {
    await f.close();
  }
});

it("preserves original save history after a renderer notification failure and avoids no-op records", async () => {
  const f = await retentionFixture();
  try {
    const original = (await f.snapshot()).pages[0].blocks[0].translatedText;
    await f.edit(original);
    expect((await f.list()).total).toBe(0);
    f.editing.notifySaved.mockImplementationOnce(() => {
      throw new Error("synthetic notification failure");
    });
    await expect(f.edit("committed before notification")).rejects.toThrow();
    const id = (await f.list()).items[0].id;
    await f.restart();
    await f.recover(id, "undo");
    expect((await f.snapshot()).pages[0].blocks[0].translatedText).toBe(
      original,
    );
  } finally {
    await f.close();
  }
});

it("revokes a pending save even after encrypted staging started and creates no historical record", async () => {
  const f = await retentionFixture();
  try {
    const before = await readFile(f.chapterPath);
    let authorized = true;
    const caller = f.auth();
    const guard = () => {
      if (!authorized) throw new Error("grant revoked");
    };
    caller.assertAuthorized.mockImplementation(guard);
    caller.assertJobAuthorized.mockImplementation(guard);
    const encrypt = f.encryption.encrypt;
    const hook = vi
      .spyOn(f.encryption, "encrypt")
      .mockImplementation((text) => {
        if (text.includes('"domain":"carrot-retention-v1"')) authorized = false;
        return encrypt(text);
      });
    const page = (await f.snapshot()).pages[0];
    await expect(
      f.invoke(
        "carrot_update_page_blocks",
        {
          chapterId: "chapter",
          pageId: page.id,
          revision: createPageRevision(page),
          edits: [
            {
              blockId: page.blocks[0].id,
              fields: { translatedText: "revoked pending edit" },
            },
          ],
        },
        caller,
      ),
    ).rejects.toThrow();
    hook.mockRestore();
    expect(await readFile(f.chapterPath)).toEqual(before);
    expect((await f.list()).total).toBe(0);
  } finally {
    await f.close();
  }
});

it("expires records without touching current images and prunes only expired store-owned copies on the next commit", async () => {
  const f = await retentionFixture();
  try {
    await f.paint();
    const page = (await f.snapshot()).pages[0];
    if (!page.inpaintedImagePath) throw new Error("Expected painted image");
    const image = await readFile(page.inpaintedImagePath);
    const index = await f.storage.index();
    const expired = index.entries[0].id;
    index.entries[0].expiresAt = 1;
    await writeFile(
      await f.storage.path(),
      JSON.stringify(await f.codec.seal(index)),
    );
    expect((await f.list()).items[0].available).toBe(false);
    await expect(f.inspect(expired)).rejects.toThrow();
    await f.edit("next unrelated text commit");
    expect((await f.list()).total).toBe(1);
    await expect(access(await f.storage.path(expired))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(page.inpaintedImagePath)).toEqual(image);
  } finally {
    await f.close();
  }
});

it("fails closed at the bounded catalog capacity without evicting another connection or changing the page", async () => {
  const f = await retentionFixture();
  try {
    await f.edit("kept history");
    const index = await f.storage.index();
    const first = index.entries[0];
    index.entries = Array.from({ length: 256 }, (_, i) => ({
      ...first,
      id: i ? randomUUID() : first.id,
      owner: i ? "different-owner" : first.owner,
    }));
    await writeFile(
      await f.storage.path(),
      JSON.stringify(await f.codec.seal(index)),
    );
    const before = await readFile(f.chapterPath);
    await expect(f.edit("capacity must not evict history")).rejects.toThrow();
    expect(await readFile(f.chapterPath)).toEqual(before);
    expect((await f.storage.index()).entries).toEqual(index.entries);
    expect((await f.list()).total).toBe(1);
  } finally {
    await f.close();
  }
});

it("rejects inconsistent pagination instead of merging snapshots from different commits", async () => {
  const f = await retentionFixture();
  try {
    await f.edit("first");
    await f.edit("second");
    const first = await f.list("changes", { limit: 1 });
    expect(first.nextOffset).toBe(1);
    await expect(f.list("changes", { offset: 1 })).rejects.toThrow();
    expect(
      (await f.list("changes", { offset: 1, snapshot: first.snapshot })).items,
    ).toHaveLength(1);
    await f.edit("third");
    await expect(
      f.list("changes", { offset: 1, snapshot: first.snapshot }),
    ).rejects.toThrow();
  } finally {
    await f.close();
  }
});
