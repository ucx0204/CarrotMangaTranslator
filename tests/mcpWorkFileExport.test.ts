import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { workFileExportFixture } from "./mcpWorkFileExport.fixture";
import { McpWorkFileCreateSchema } from "../src/shared/mcpWorkFileImport";
import { McpWorkFileExportTargetSchema } from "../src/shared/mcpWorkFileExport";

it("exports through actual tools and roundtrips editable native bytes through the existing importer", async () => {
  const f = await workFileExportFixture();
  try {
    const before = await readFile(f.chapterPath);
    const target = await f.exportCommand();
    const { accepted, done } = await f.exportFile(target);
    expect(done.status, JSON.stringify(f.outputErrors.map(String))).toBe(
      "completed",
    );
    expect(done.result).toMatchObject({
      kind: "native-work-file",
      workFileExport: {
        format: "mgtshare-v1",
        pageCount: 2,
        chapterCount: 1,
        sourceSnapshot: target.sourceSnapshot,
      },
    });
    expect(JSON.stringify(done)).not.toMatch(
      /mcp-artifacts|imagePath|dataUrl|https:/,
    );
    const file = (await f.invokeExport("carrot_get_job_file", {
      jobId: accepted.jobId,
    })) as { url: string; sha256: string; filename: string; mimeType: string };
    expect(file).toMatchObject({
      filename: "carrot-work.mgtshare",
      mimeType: "application/vnd.carrot.mgtshare",
    });
    const bytes = await f.artifacts.read(
      new URL(file.url).pathname.split("/")[2],
    );
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(file.sha256);
    const uploaded = await f.upload(bytes);
    const review = await f.review(uploaded.uploadId);
    const receipt = await f.createWorkFile(
      McpWorkFileCreateSchema.parse({
        uploadId: uploaded.uploadId,
        snapshot: review.snapshot,
        requestId: randomUUID(),
        target: { mode: "new", title: "Native output roundtrip" },
        chapters: review.chapters.map((chapter) => ({
          packageChapterId: chapter.packageChapterId,
          title: chapter.title,
        })),
        allowNativePreparation: true,
        acknowledgeV1Limitations: true,
      }),
    );
    const imported = await f.library.openChapter(receipt.chapterIds[0]);
    for (const [index, page] of imported.pages.entries()) {
      const original = f.originalChapter.pages[index];
      expect(page.blocks.map(({ id: _id, ...block }) => block)).toEqual(
        original.blocks.map(({ id: _id, ...block }) => block),
      );
      expect(await readFile(page.imagePath)).toEqual(
        await readFile(original.imagePath),
      );
    }
    expect(imported.pages[0].blockOrder).toEqual(
      imported.pages[0].blocks.map((block) => block.id).reverse(),
    );
    const processed = imported.pages[0].inpaintedImagePath;
    const originalProcessed = f.originalChapter.pages[0].inpaintedImagePath;
    if (!processed || !originalProcessed)
      throw new Error("Missing native processed image.");
    expect(await readFile(processed)).toEqual(
      await readFile(originalProcessed),
    );
    expect(
      JSON.parse(
        await readFile(
          join(f.env.libraryDir, "works", receipt.workId, "style-guide.json"),
          "utf8",
        ),
      ).workId,
    ).toBe(receipt.workId);
    expect(await readFile(f.chapterPath)).toEqual(before);
    expect(f.unusedRaster).not.toHaveBeenCalled();
    await expect(
      f.invokeExport(
        "carrot_get_job_file",
        { jobId: accepted.jobId },
        f.outputAuth("another-owner"),
      ),
    ).rejects.toThrow();
    f.permitOutput(false);
    await expect(f.artifacts.assertAvailable(file.url)).rejects.toThrow();
  } finally {
    await f.close();
  }
});

it("binds reviewed original bytes even when a change keeps the same size and page revision", async () => {
  const f = await workFileExportFixture();
  try {
    const target = await f.exportCommand();
    const path = f.originalChapter.pages[0].imagePath;
    const before = await readFile(path);
    const changed = Buffer.from(before);
    changed[changed.length - 1] ^= 1;
    await writeFile(path, changed);
    const after = await f.preflight();
    expect(after.snapshot).toBe(target.snapshot);
    expect(after.sourceSnapshot).not.toBe(target.sourceSnapshot);
    const { done } = await f.exportFile(target);
    expect(done.status).toBe("failed");
    expect(done.error?.code).toBe("revision_conflict");
    expect(f.outputStore).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it("keeps a missing style-guide default stable across reads without saving one", async () => {
  const f = await workFileExportFixture();
  const guidePath = join(f.env.libraryDir, "works", "work", "style-guide.json");
  try {
    await rm(guidePath, { force: true });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const target = await f.exportCommand();
    vi.setSystemTime(new Date("2026-01-02T00:00:00Z"));
    const after = await f.preflight();
    expect(after.snapshot).toBe(target.snapshot);
    expect(after.sourceSnapshot).toBe(target.sourceSnapshot);
    const { done } = await f.exportFile(target);
    expect(done.status, JSON.stringify(f.outputErrors.map(String))).toBe(
      "completed",
    );
    await expect(readFile(guidePath)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    vi.useRealTimers();
    await f.close();
  }
});

it("withholds completed native bytes when the original changes during the writer call", async () => {
  const f = await workFileExportFixture();
  try {
    const target = await f.exportCommand();
    const source = f.originalChapter.pages[0].imagePath;
    const bytes = Buffer.from(await readFile(source));
    bytes[bytes.length - 1] ^= 1;
    f.outputStore.mockImplementationOnce((writer, ...args) =>
      f.putOutput(
        async (path, signal) => {
          await writer(path, signal);
          await writeFile(source, bytes);
        },
        ...args,
      ),
    );
    const { accepted, done } = await f.exportFile(target);
    expect(done.status).toBe("failed");
    await expect(
      f.invokeExport("carrot_get_job_file", { jobId: accepted.jobId }),
    ).rejects.toThrow();
    expect(f.unusedRaster).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it("requires the two disclosures and exact chapter selection before starting a job", async () => {
  const f = await workFileExportFixture();
  try {
    const target = await f.exportCommand();
    for (const field of [
      "acknowledgeOriginalImages",
      "acknowledgeV1Limitations",
    ] as const)
      await expect(
        f.invokeExport("carrot_export_work_file", {
          ...target,
          [field]: false,
        }),
      ).rejects.toThrow();
    expect(
      McpWorkFileExportTargetSchema.safeParse({
        ...target,
        outputPath: "C:/requested.mgtshare",
      }).success,
    ).toBe(false);
    await expect(
      f.invokeExport("carrot_preflight_work_file_export", {
        workId: "work",
        chapterIds: ["chapter", "chapter"],
      }),
    ).rejects.toThrow();
    await expect(
      f.invokeExport("carrot_preflight_work_file_export", {
        workId: "work",
        chapterIds: ["chapter", "missing"],
      }),
    ).rejects.toThrow();
    expect(f.outputStore).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it("cancels after the actual native writer finishes without publishing a job file", async () => {
  const f = await workFileExportFixture();
  let reached!: () => void;
  let resume!: () => void;
  const writingDone = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const release = new Promise<void>((resolve) => {
    resume = resolve;
  });
  try {
    const target = await f.exportCommand();
    f.outputStore.mockImplementationOnce((writer, ...args) =>
      f.putOutput(
        async (path, signal) => {
          await writer(path, signal);
          reached();
          await release;
        },
        ...args,
      ),
    );
    const accepted = (await f.invokeExport(
      "carrot_export_work_file",
      target,
    )) as { jobId: string };
    await writingDone;
    const cancellation = f.invokeExport("carrot_cancel_job", {
      jobId: accepted.jobId,
    });
    resume();
    await cancellation;
    const done = await f.operations.waitForCompletion(
      accepted.jobId,
      "export-owner",
      new AbortController().signal,
    );
    expect(done.status).toBe("cancelled");
    await expect(
      f.invokeExport("carrot_get_job_file", { jobId: accepted.jobId }),
    ).rejects.toThrow();
    expect(f.unusedRaster).not.toHaveBeenCalled();
  } finally {
    resume();
    await f.close();
  }
});

it("returns native order including empty chapters and rejects a different execution order", async () => {
  const f = await workFileExportFixture();
  try {
    const workPath = join(f.env.libraryDir, "works", "work", "work.json");
    const work = JSON.parse(await readFile(workPath, "utf8"));
    const chapterDirectory = join(
      f.env.libraryDir,
      "works",
      "work",
      "chapters",
      "empty",
    );
    await mkdir(chapterDirectory);
    await writeFile(
      join(chapterDirectory, "chapter.json"),
      JSON.stringify({
        ...f.originalChapter,
        id: "empty",
        title: "Empty selected chapter",
        pages: [],
        pageOrder: [],
      }),
    );
    await writeFile(
      workPath,
      JSON.stringify({ ...work, chapterOrder: ["empty", "chapter"] }),
    );
    const { McpWorkFileExportReviewSchema } =
      await import("../src/shared/mcpWorkFileExport");
    const review = McpWorkFileExportReviewSchema.parse(
      await f.invokeExport("carrot_preflight_work_file_export", {
        workId: "work",
        chapterIds: ["chapter", "empty"],
      }),
    );
    expect(review.chapterIds).toEqual(["empty", "chapter"]);
    expect(review.chapters.map((chapter) => chapter.pageCount)).toEqual([0, 2]);
    const target = McpWorkFileExportTargetSchema.parse({
      workId: review.workId,
      chapterIds: ["chapter", "empty"],
      snapshot: review.snapshot,
      sourceSnapshot: review.sourceSnapshot,
      requestId: randomUUID(),
      acknowledgeOriginalImages: true,
      acknowledgeV1Limitations: true,
    });
    expect((await f.exportFile(target)).done.error?.code).toBe(
      "revision_conflict",
    );
    const valid = {
      ...target,
      chapterIds: review.chapterIds,
      requestId: randomUUID(),
    };
    expect((await f.exportFile(valid)).done.status).toBe("completed");
  } finally {
    await f.close();
  }
});

it("rejects overlarge complete chapter selections without truncation or output", async () => {
  const f = await workFileExportFixture();
  try {
    const chapter = structuredClone(f.originalChapter);
    chapter.pages = Array.from({ length: 51 }, (_, index) => ({
      ...structuredClone(chapter.pages[0]),
      id: `page-${index}`,
    }));
    chapter.pageOrder = chapter.pages.map((page) => page.id);
    await writeFile(f.chapterPath, JSON.stringify(chapter));
    await expect(f.preflight()).rejects.toThrow(/fifty pages/);
    await expect(
      f.invokeExport("carrot_preflight_work_file_export", {
        workId: "work",
        chapterIds: Array.from(
          { length: 11 },
          (_, index) => `chapter-${index}`,
        ),
      }),
    ).rejects.toThrow();
    expect(f.outputStore).not.toHaveBeenCalled();
    expect(
      JSON.parse(await readFile(f.chapterPath, "utf8")).pages,
    ).toHaveLength(51);
  } finally {
    await f.close();
  }
});
