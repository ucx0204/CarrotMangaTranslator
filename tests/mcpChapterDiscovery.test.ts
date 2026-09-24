import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { chapterDiscoveryFixture } from "./mcpChapterDiscovery.fixture";
import { McpImportPreviewReferenceSchema } from "../src/shared/mcpLibraryImport";

it("retains exact chapter candidates and pagination after reconstruction without browsing again", async () => {
  const f = await chapterDiscoveryFixture();
  try {
    const before = await f.library.listLibrary();
    const ref = await f.discover();
    const review = await f.get(ref.id);
    expect(review).toMatchObject({
      total: 30,
      nextOffset: 25,
      linkCount: 30,
      exhaustive: false,
    });
    expect(review.links).toHaveLength(25);
    expect(
      await f.get(ref.id, { snapshot: ref.snapshot, offset: 25 }),
    ).toMatchObject({
      nextOffset: null,
      links: Array.from({ length: 5 }, (_, i) =>
        expect.objectContaining({ label: `Chapter ${i + 26}` }),
      ),
    });
    expect(await readFile(await f.storage.path(ref.id), "utf8")).not.toContain(
      "Untrusted chapter index",
    );
    expect(f.web.scan).not.toHaveBeenCalled();
    expect(f.validate).not.toHaveBeenCalled();
    await f.restart();
    expect(await f.get(ref.id)).toEqual(review);
    expect(await f.discover()).toEqual(ref);
    expect(f.web.discoverChapters).toHaveBeenCalledOnce();
    // Exercise repository-level idempotence too, without relying on the job journal.
    const load = vi.spyOn(f.persistence, "load").mockResolvedValue(null);
    await f.restart();
    expect(await f.discover()).toEqual(ref);
    expect(f.web.discoverChapters).toHaveBeenCalledOnce();
    load.mockRestore();
    expect(await f.library.listLibrary()).toEqual(before);
    expect((await f.storage.index()).entries).toHaveLength(1);
    expect(JSON.stringify(f.journal())).not.toMatch(
      /Untrusted chapter index|Chapter 30|sourcePath/,
    );
  } finally {
    await f.close();
  }
});

it("resolves only the selected owned link then uses existing reviewed image import", async () => {
  const f = await chapterDiscoveryFixture(2);
  try {
    const original = await readFile(f.originals[1]);
    const ref = await f.discover();
    const review = await f.get(ref.id);
    const scan = {
      requestId: randomUUID(),
      id: ref.id,
      snapshot: ref.snapshot,
      linkId: review.links[1].id,
      allowNetwork: true,
    };
    const done = await f.settle(
      await f.invoke("carrot_scan_discovered_chapter", scan),
    );
    expect(done).toMatchObject({ status: "completed", kind: "importPrepare" });
    const preview = McpImportPreviewReferenceSchema.parse(
      done.result?.importPreview,
    );
    expect(f.web.scan.mock.calls[0][0]).toMatchObject({
      url: "https://chapters.example/chapter/2",
      requestId: scan.requestId,
    });
    expect((await f.library.listLibrary()).works).toHaveLength(1);
    const input = await f.command(preview);
    input.chapters[0].pageIds = input.chapters[0].pageIds.slice(1);
    const receipt = await f.create(input);
    const chapter = await f.library.openChapter(receipt.chapterIds[0]);
    expect(chapter.pages).toHaveLength(1);
    expect(await readFile(chapter.pages[0].imagePath)).toEqual(original);
    expect(await readFile(f.originals[1])).toEqual(original);
    await f.restart();
    const replay = await f.settle(
      await f.invoke("carrot_scan_discovered_chapter", scan),
    );
    expect(replay.result?.importPreview).toBeUndefined();
    expect(replay.result?.importPreviewExpired).toBe(true);
    expect(f.web.scan).toHaveBeenCalledOnce();
    expect(await f.get(ref.id)).toEqual(review);
  } finally {
    await f.close();
  }
});

it("rejects foreign owners, stale snapshots, fabricated links and caller URL overrides", async () => {
  const f = await chapterDiscoveryFixture(2);
  try {
    const ref = await f.discover();
    const review = await f.get(ref.id);
    await expect(f.get(ref.id, {}, f.auth("other"))).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(f.get(ref.id, { offset: 1 })).rejects.toMatchObject({
      code: "revision_conflict",
    });
    await expect(
      f.get(ref.id, { snapshot: "0".repeat(16) }),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    const base = {
      requestId: randomUUID(),
      id: ref.id,
      snapshot: ref.snapshot,
      linkId: review.links[0].id,
      allowNetwork: true,
    };
    for (const patch of [
      { snapshot: "0".repeat(16) },
      { linkId: randomUUID() },
    ]) {
      const done = await f.settle(
        await f.invoke("carrot_scan_discovered_chapter", {
          ...base,
          ...patch,
          requestId: randomUUID(),
        }),
      );
      expect(done.status).toBe("failed");
    }
    await expect(
      f.invoke("carrot_scan_discovered_chapter", {
        ...base,
        url: "https://other.example/",
      }),
    ).rejects.toThrow();
    await expect(
      f.invoke("carrot_discover_chapters", { ...f.input, allowNetwork: false }),
    ).rejects.toThrow();
    await expect(
      f.invoke("carrot_discover_chapters", {
        ...f.input,
        url: "https://other.example/",
      }),
    ).rejects.toMatchObject({ code: "invalid_edit" });
    expect(f.web.scan).not.toHaveBeenCalled();
    expect(f.web.discoverChapters).toHaveBeenCalledOnce();
  } finally {
    await f.close();
  }
});

it("expires retained metadata at the exact boundary without implying that discovery restarts", async () => {
  const f = await chapterDiscoveryFixture(1);
  try {
    const ref = await f.discover();
    const review = await f.get(ref.id);
    f.clock(ref.expiresAt);
    await expect(f.get(ref.id)).rejects.toMatchObject({ code: "not_found" });
    const list = await f.invoke("carrot_list_chapter_discoveries", {});
    expect(list).toMatchObject({ items: [{ id: ref.id, available: false }] });
    const done = await f.settle(
      await f.invoke("carrot_scan_discovered_chapter", {
        requestId: randomUUID(),
        id: ref.id,
        snapshot: ref.snapshot,
        linkId: review.links[0].id,
        allowNetwork: true,
      }),
    );
    expect(done).toMatchObject({
      status: "failed",
      error: { code: "not_found" },
    });
    expect(f.web.scan).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it("rolls back discovery storage when continuing approval is revoked during encryption", async () => {
  const f = await chapterDiscoveryFixture(1);
  const { McpEditError } =
    await import("../src/main/application/mcpEditPolicy");
  let allowed = true;
  const seal = f.codec.seal.bind(f.codec);
  const hook = vi.spyOn(f.codec, "seal").mockImplementation(async (value) => {
    const result = await seal(value);
    if (value && typeof value === "object" && "linkIds" in value)
      allowed = false;
    return result;
  });
  try {
    const before = await f.library.listLibrary();
    const caller = f.auth("import-owner", () => {
      if (!allowed) throw new McpEditError("access_denied", "Approval revoked");
    });
    const done = await f.settle(
      await f.invoke("carrot_discover_chapters", f.input, caller),
    );
    expect(done).toMatchObject({
      status: "failed",
      error: { code: "access_denied" },
    });
    expect((await f.storage.index()).entries).toEqual([]);
    expect(await f.library.listLibrary()).toEqual(before);
  } finally {
    hook.mockRestore();
    await f.close();
  }
});

it("propagates session stop into an active browser inspection and never publishes late results", async () => {
  const f = await chapterDiscoveryFixture(1);
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.web.discoverChapters.mockImplementationOnce(async (_request, signal) => {
    started();
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
      if (signal.aborted) reject(signal.reason);
    });
    throw new Error("Unreachable after abort");
  });
  try {
    const accepted = await f.invoke("carrot_discover_chapters", f.input);
    await ready;
    f.current().session.stop();
    const done = await f.settle(accepted);
    expect(["failed", "cancelled"]).toContain(done.status);
    expect(done.result?.chapterDiscovery).toBeUndefined();
    expect((await f.storage.index()).entries).toEqual([]);
    expect(f.web.scan).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it("keeps read-only discovery metadata usable while withholding new network tools", async () => {
  const f = await chapterDiscoveryFixture(0);
  try {
    const ref = await f.discover();
    f.preferences.allowEditing = false;
    f.preferences.allowProcessing = false;
    await f.restart();
    expect(await f.get(ref.id)).toMatchObject({
      links: [],
      total: 0,
      exhaustive: false,
    });
    expect(f.current().session.tools.map((tool) => tool.name)).not.toContain(
      "carrot_discover_chapters",
    );
    expect(f.current().session.tools.map((tool) => tool.name)).not.toContain(
      "carrot_scan_discovered_chapter",
    );
    expect(
      await f.invoke("carrot_list_chapter_discoveries", {}, f.auth("other")),
    ).toMatchObject({ total: 0, items: [] });
    expect(f.web.discoverChapters).toHaveBeenCalledOnce();
  } finally {
    await f.close();
  }
});
