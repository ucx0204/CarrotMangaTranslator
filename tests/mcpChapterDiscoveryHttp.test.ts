import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { libraryImportHttpFixture } from "./mcpLibraryImportHttp.fixture";
import { chapterDiscoveryBoundary } from "./mcpChapterDiscovery.fixture";

it("registers strict HTTP discovery tools and restores the same owned review across server restart", async () => {
  let paths: string[] = [];
  const web = chapterDiscoveryBoundary(() => paths, 2);
  const f = await libraryImportHttpFixture({ web });
  paths = f.originals;
  try {
    const input = {
      requestId: randomUUID(),
      url: "https://chapters.example/book",
      allowNetwork: true,
    };
    expect(
      (await f.call("carrot_discover_chapters", input, f.read)).error.message,
    ).toBe("Unknown tool");
    expect(
      (
        await f.call("carrot_discover_chapters", {
          ...input,
          script: "alert(1)",
        })
      ).error.code,
    ).toBe(-32602);
    const accepted = await f.call("carrot_discover_chapters", input);
    expect(accepted.result.isError).toBe(false);
    const done = await f.settle(accepted.result.structuredContent);
    expect(done).toMatchObject({ status: "completed", kind: "importDiscover" });
    const ref = done.result?.chapterDiscovery;
    if (!ref) throw new Error("Missing retained discovery reference");
    const review = await f.call("carrot_get_chapter_discovery", { id: ref.id });
    expect(review.result.isError).toBe(false);
    expect(review.result.structuredContent.links).toHaveLength(2);
    expect(
      (await f.call("carrot_get_chapter_discovery", { id: ref.id }, f.other))
        .result.structuredContent.error,
    ).toBe("not_found");
    // The read-only grant sees the tool, but not another connection's metadata.
    expect(
      (await f.call("carrot_get_chapter_discovery", { id: ref.id }, f.read))
        .result.structuredContent.error,
    ).toBe("not_found");
    expect(
      (await f.call("carrot_list_chapter_discoveries", {}, f.read)).result
        .structuredContent.items,
    ).toEqual([]);
    await f.restart();
    expect(
      (await f.call("carrot_get_chapter_discovery", { id: ref.id })).result
        .structuredContent,
    ).toEqual(review.result.structuredContent);
    expect(
      (await f.call("carrot_list_chapter_discoveries", {})).result
        .structuredContent.items,
    ).toMatchObject([{ id: ref.id, kind: "chapter-discovery" }]);
    expect(
      (
        await f.settle(
          (await f.call("carrot_discover_chapters", input)).result
            .structuredContent,
        )
      ).result?.chapterDiscovery,
    ).toEqual(ref);
    expect(web.discoverChapters).toHaveBeenCalledOnce();
    expect(web.scan).not.toHaveBeenCalled();
    const scan = {
      requestId: randomUUID(),
      id: ref.id,
      snapshot: ref.snapshot,
      linkId: review.result.structuredContent.links[0].id,
      allowNetwork: true,
    };
    expect(
      (
        await f.call("carrot_scan_discovered_chapter", {
          ...scan,
          url: "https://other.example",
        })
      ).error.code,
    ).toBe(-32602);
    const scanned = await f.settle(
      (await f.call("carrot_scan_discovered_chapter", scan)).result
        .structuredContent,
    );
    expect(scanned).toMatchObject({
      status: "completed",
      result: { importPreview: { source: "web", retention: "session-only" } },
    });
    expect((await f.library.listLibrary()).works).toHaveLength(1);
  } finally {
    await f.close();
  }
});

it("rolls back discovery publication when the real OAuth connection is revoked during encryption", async () => {
  const web = chapterDiscoveryBoundary(() => [], 1);
  const f = await libraryImportHttpFixture({ web });
  const owner = f.provider.connectionIdFor(`Bearer ${f.full}`);
  if (!owner) throw new Error("Missing fixture owner");
  const seal = f.codec.seal.bind(f.codec);
  const hook = vi.spyOn(f.codec, "seal").mockImplementation(async (value) => {
    const encrypted = await seal(value);
    if (value && typeof value === "object" && "linkIds" in value)
      f.provider.revokeConnection(owner);
    return encrypted;
  });
  try {
    const input = {
      requestId: randomUUID(),
      url: "https://chapters.example/book",
      allowNetwork: true,
    };
    const accepted = await f.call("carrot_discover_chapters", input);
    const done = await f
      .current()
      .operations.waitForCompletion(
        accepted.result.structuredContent.jobId,
        owner,
        new AbortController().signal,
      );
    expect(done).toMatchObject({
      status: "failed",
      error: { code: "access_denied" },
    });
    expect((await f.storage.index()).entries).toEqual([]);
    expect((await f.library.listLibrary()).works).toHaveLength(1);
  } finally {
    hook.mockRestore();
    await f.close();
  }
});
