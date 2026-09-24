import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createPageRevision,
  createPageVisualRevision,
} from "../src/shared/pageRevision";
import { buildLinkedMirrorFileName } from "../src/main/linkedWorkspace/linkedWorkspacePaths";
import { buildLinkedMirrorChapter } from "../src/main/linkedWorkspace/linkedWorkspaceMirror";
import {
  REVIEW_PNG,
  reviewedWorkspace,
  reviewedExecution,
  reviewedTarget,
  type ReviewedFixture,
} from "./linkedWorkspaceReviewedOutput.fixture";

const desktop = vi.hoisted(() => ({ openPath: vi.fn(async () => "") }));
vi.mock("electron", () => ({
  app: { getVersion: () => "native-parity" },
  shell: { openPath: desktop.openPath },
}));
const fixtures: ReviewedFixture[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-23T00:00:00.000Z"));
});
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
  vi.useRealTimers();
  vi.clearAllMocks();
});
async function setup(counts?: number[]) {
  const fixture = await reviewedWorkspace(counts);
  fixtures.push(fixture);
  return fixture;
}

describe("reviewed native linked output", () => {
  it("inspects and prepares the complete mirror scope without rendering or mutating registry, queue or sources", async () => {
    const f = await setup([2, 1]);
    const registry = await readFile(join(f.dataRoot, "linked-workspaces.json"));
    const queue = await f.queue();
    const destination = await f.service.reviewedOutput.inspect(
      f.selection.chapterId,
      () => undefined,
    );
    const review = await f.service.reviewedOutput.preflight(
      { ...f.selection, pageIds: f.selection.pageIds.slice(0, 1) },
      () => undefined,
    );
    expect(destination).toMatchObject({
      available: true,
      destinationKind: "custom",
    });
    expect(review.mirrorScope.pageCount).toBe(3);
    expect(review.mirrorScope.chapters).toHaveLength(2);
    expect(review.pages).toHaveLength(1);
    expect(review.registryPublications.maximum).toBe(2);
    expect(JSON.stringify({ destination, review })).not.toContain(f.output);
    expect(JSON.stringify({ destination, review })).not.toContain(f.dataRoot);
    expect(await readFile(join(f.dataRoot, "linked-workspaces.json"))).toEqual(
      registry,
    );
    expect(await f.queue()).toBe(queue);
    expect(f.createRenderer).not.toHaveBeenCalled();
    expect(f.updatePagesAfterInpainting).not.toHaveBeenCalled();
    expect(desktop.openPath).not.toHaveBeenCalled();
  });

  it("uses native result/copy writers and complete mirror shape while preserving original files and the automatic queue", async () => {
    const f = await setup([2, 1]);
    const queue = await f.queue();
    const pending = f.service.getStatus(f.selection.chapterId).pendingCount;
    const review = await f.service.reviewedOutput.preflight(
      f.selection,
      () => undefined,
    );
    const execution = reviewedExecution();
    const result = await f.service.reviewedOutput.execute(
      reviewedTarget(review),
      execution.context,
    );
    expect(result).toMatchObject({
      status: "completed",
      metadata: "published",
      mirror: "published",
    });
    expect(
      execution.intents.filter((intent) => intent.role === "registry"),
    ).toHaveLength(3);
    expect(
      execution.intents.every((intent) =>
        /^[A-Za-z0-9:_-]{1,128}$/.test(intent.fileId),
      ),
    ).toBe(true);
    expect(execution.effects).toHaveLength(execution.intents.length);
    const registry = await f.registry();
    const record = registry.records.find(
      (record: { id: string }) => record.id === f.selection.connectionId,
    );
    if (!record) throw new Error("fixture record missing");
    for (const page of f.chapters[0]?.pages ?? []) {
      const artifacts = record.artifacts[page.id];
      if (!artifacts?.result || !artifacts.inpainted || !artifacts.mask)
        throw new Error("fixture artifacts missing");
      expect(
        await readFile(join(f.output, artifacts.result.path), "utf8"),
      ).toBe("native-render:" + page.id);
      expect(await readFile(join(f.output, artifacts.inpainted.path))).toEqual(
        REVIEW_PNG,
      );
      expect(await readFile(join(f.output, artifacts.mask.path))).toEqual(
        REVIEW_PNG,
      );
      expect(await readFile(page.imagePath)).toEqual(REVIEW_PNG);
      expect(record.publishedRevisions[page.id]).toBe(
        createPageVisualRevision(page),
      );
      expect(record.publishedMirrorRevisions[page.id]).toBe(
        createPageRevision(page),
      );
    }
    const mirror = JSON.parse(
      await readFile(
        join(f.output, buildLinkedMirrorFileName(f.output)),
        "utf8",
      ),
    );
    expect(mirror).toMatchObject({
      schemaVersion: 1,
      appVersion: "native-parity",
    });
    expect(
      mirror.chapters.map((chapter: { id: string }) => chapter.id),
    ).toEqual(f.chapters.map((chapter) => chapter.id));
    expect(
      mirror.chapters.flatMap((chapter: { pages: unknown[] }) => chapter.pages),
    ).toHaveLength(3);
    expect(JSON.stringify(mirror)).not.toContain(f.dataRoot);
    expect(JSON.stringify(mirror)).not.toContain("sourcePath");
    expect(f.renderPage).toHaveBeenCalledTimes(2);
    expect(f.renderPage.mock.calls[0]?.[1]).toEqual({
      format: "png",
      resolutionMode: "original",
    });
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(await f.queue()).toBe(queue);
    expect(f.service.getStatus(f.selection.chapterId).pendingCount).toBe(
      pending,
    );
    expect(f.updatePagesAfterInpainting).not.toHaveBeenCalled();
    expect(desktop.openPath).not.toHaveBeenCalled();
  });

  it.each(["jpeg", "webp"] as const)(
    "preserves native %s encoding options and allocated result extension",
    async (format) => {
      const f = await setup([1]);
      const record = (await f.registry()).records[0];
      if (!record) throw new Error("fixture record missing");
      await f.service.update({
        connectionId: record.id,
        output: { ...record.output, format },
      });
      const review = await f.service.reviewedOutput.preflight(
        f.selection,
        () => undefined,
      );
      const result = await f.service.reviewedOutput.execute(
        reviewedTarget(review),
        reviewedExecution().context,
      );
      expect(result.status).toBe("completed");
      expect(f.renderPage.mock.calls[0]?.[1]).toEqual({
        format,
        resolutionMode: "original",
        quality:
          format === "jpeg"
            ? record.output.jpegQuality
            : record.output.webpQuality,
      });
      const published = (await f.registry()).records[0]?.artifacts[
        f.selection.pageIds[0] ?? ""
      ]?.result;
      expect(
        published?.path.endsWith(format === "jpeg" ? ".jpg" : ".webp"),
      ).toBe(true);
    },
  );

  it("shares the native mirror field projection, including optional absence and local-path stripping", async () => {
    const f = await setup([1]);
    const record = (await f.registry()).records[0];
    const chapter = f.chapters[0];
    const page = chapter?.pages[0];
    if (!record || !chapter || !page) throw new Error("fixture page missing");
    record.artifacts[page.id] = {
      inpainted: {
        path: "inpainted/page.png",
        bytes: 7,
        sha256: "a".repeat(64),
        sourcePath: "private",
      },
    };
    const mirror = buildLinkedMirrorChapter(record, chapter, "Reviewed work");
    expect(mirror.pages[0]).toEqual({
      id: page.id,
      name: page.name,
      width: 1,
      height: 1,
      blocks: [],
      blockOrder: [],
      translationCompletion: undefined,
      maskProvenance: "derived-diff",
      sourceRelativePath: record.sourceRelativePaths?.[page.id],
      source: {
        path: record.sourceRelativePaths?.[page.id],
        bytes: REVIEW_PNG.length,
        sha256: record.sourceFingerprints[page.id].sha256,
      },
      inpainted: {
        path: "inpainted/page.png",
        bytes: 7,
        sha256: "a".repeat(64),
      },
    });
    expect(mirror.pages[0]).not.toHaveProperty("result");
    expect(mirror.pages[0]).not.toHaveProperty("mask");
  });
});
