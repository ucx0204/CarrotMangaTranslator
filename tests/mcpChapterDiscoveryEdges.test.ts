import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { chapterDiscoveryFixture } from "./mcpChapterDiscovery.fixture";
import {
  WebChapterDiscoveryResultSchema,
  WebChapterLinkSchema,
} from "../src/shared/webChapterDiscovery";

it("rejects reconstructed discovery references that disagree with their admitted job", async () => {
  const f = await chapterDiscoveryFixture(1);
  try {
    await f.discover();
    const { parseMcpJobJournal } =
      await import("../src/main/application/mcpJobJournal");
    const original = JSON.stringify(f.journal());
    for (const patch of [{ requestId: randomUUID() }, { linkCount: 101 }]) {
      const changed = JSON.parse(original);
      Object.assign(changed.records[0].result.chapterDiscovery, patch);
      expect(() => parseMcpJobJournal(changed)).toThrow("inconsistent");
    }
    expect(parseMcpJobJournal(JSON.parse(original))).toHaveLength(1);
  } finally {
    await f.close();
  }
});

it("rejects tampered encrypted candidates and mismatched metadata without changing ordinary library data", async () => {
  const f = await chapterDiscoveryFixture(1);
  try {
    const before = await f.library.listLibrary();
    const ref = await f.discover();
    const record = z
      .object({
        data: WebChapterDiscoveryResultSchema,
        expiresAt: z.number(),
        createdAt: z.number(),
      })
      .passthrough()
      .parse(await f.storage.record(ref.id));
    const { withLibraryMutation } = await import("../src/main/library/lock");
    const { runLibraryTransaction } =
      await import("../src/main/libraryStore/libraryTransaction");
    const save = (value: unknown) =>
      withLibraryMutation(() =>
        runLibraryTransaction("test-discovery-record-edit", (transaction) =>
          f.storage.stageRecord(transaction, ref.id, value),
        ),
      );
    const changed = structuredClone(record);
    changed.data.links[0].label = "Modified after review";
    await save(changed);
    await expect(f.get(ref.id)).rejects.toThrow(
      "Inconsistent chapter discovery record",
    );
    await save({
      ...record,
      createdAt: record.createdAt + 1,
      expiresAt: record.expiresAt + 1,
    });
    await expect(f.get(ref.id)).rejects.toMatchObject({ code: "invalid_edit" });
    await save(record);
    expect((await f.get(ref.id)).links[0].label).toBe("Chapter 1");
    expect(await f.library.listLibrary()).toEqual(before);
  } finally {
    await f.close();
  }
});

it("disposes only owned discovery metadata and rejects catalog pagination after the list changes", async () => {
  const f = await chapterDiscoveryFixture(1);
  try {
    const before = await f.library.listLibrary();
    const ref = await f.discover();
    const listed = z
      .object({ snapshot: z.string() })
      .passthrough()
      .parse(await f.invoke("carrot_list_chapter_discoveries", {}));
    await f.discover({ ...f.input, requestId: randomUUID() });
    await expect(
      f.invoke("carrot_list_chapter_discoveries", {
        offset: 1,
        snapshot: listed.snapshot,
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    const { McpRetentionCatalog } =
      await import("../src/main/mcp/mcpRetentionCatalog");
    const catalog = new McpRetentionCatalog(
      f.storage,
      new AbortController().signal,
      false,
    );
    await expect(
      catalog.discard("other", ref.id, () => {}),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(
      await catalog.discard("import-owner", ref.id, () => {}),
    ).toMatchObject({ status: "discarded", pageChanges: 0 });
    await expect(f.get(ref.id)).rejects.toMatchObject({ code: "not_found" });
    expect(await f.invoke("carrot_list_chapter_discoveries", {})).toMatchObject(
      { total: 1 },
    );
    expect(await f.library.listLibrary()).toEqual(before);
  } finally {
    await f.close();
  }
});

it("does not let lost job history reuse a discovery request for different input", async () => {
  const f = await chapterDiscoveryFixture(1);
  const load = vi.spyOn(f.persistence, "load");
  try {
    await f.discover();
    load.mockResolvedValue(null);
    await f.restart();
    const done = await f.settle(
      await f.invoke("carrot_discover_chapters", {
        ...f.input,
        url: "https://chapters.example/different",
      }),
    );
    expect(done).toMatchObject({
      status: "failed",
      error: { code: "invalid_edit" },
    });
    expect(f.web.discoverChapters).toHaveBeenCalledOnce();
  } finally {
    load.mockRestore();
    await f.close();
  }
});

it.each([
  "file:///private",
  "not a URL",
  "https://user:secret@chapters.example/chapter/1",
  "https://chapters.example/chapter/1#fragment",
])(
  "returns schema failure, not an unhandled URL parser exception, for %s",
  (url) => {
    expect(
      WebChapterLinkSchema.safeParse({ url, label: "candidate", position: 0 })
        .success,
    ).toBe(false);
    expect(
      WebChapterDiscoveryResultSchema.safeParse({
        pageUrl: url,
        pageTitle: "index",
        links: [],
        examined: 0,
        skipped: { invalid: 0, offOrigin: 0, duplicate: 0, filtered: 0 },
        truncated: false,
        exhaustive: false,
      }).success,
    ).toBe(false);
  },
);
