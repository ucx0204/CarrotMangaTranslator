import { readFile, writeFile, access } from "node:fs/promises";
import { dirname } from "node:path";
import { PNG } from "pngjs";
import { expect, it, vi } from "vitest";
import { selectionAppFixture } from "./mcpSelectionApp.fixture";

it("observes multiple blocks and regions with exact original-pixel mapping and no saved changes", async () => {
  const f = await selectionAppFixture();
  const before = await readFile(f.chapterPath);
  const settings = structuredClone(f.settings);
  try {
    const { job } = await f.run("carrot_run_selection_ocr", {
      ...(await f.ocrInput()),
      sourceLanguage: "ja",
    });
    expect(job.status).toBe("completed");
    expect(job.result).toMatchObject({
      pagesChanged: 0,
      performed: ["selected-ocr"],
      selectionAnalysis: { total: 4 },
    });
    const result = await f.get(job.jobId);
    expect(result.items).toHaveLength(4);
    expect(result.items[1].ocr).toMatchObject({
      cropRect: { x: 10, y: 20, w: 16, h: 16 },
      sourceRect: { x: 10.25, y: 20.25, w: 15.5, h: 15.5 },
      regions: [
        expect.objectContaining({ sourceRect: { x: 10, y: 20, w: 10, h: 10 } }),
      ],
    });
    expect(result.items[1].overlaps[0].blockIds).toContain("a");
    expect((await f.get(job.jobId, 1, 1)).items[0]).toEqual(result.items[1]);
    expect(f.collect).toHaveBeenCalledTimes(4);
    expect(f.release).toHaveBeenCalledTimes(4);
    expect(
      f.collect.mock.calls.map(([options]) => options.ocrInputKind),
    ).toEqual(["known-block-crop", "page", "known-block-crop", "page"]);
    for (const [options] of f.collect.mock.calls)
      await expect(access(dirname(options.imagePath))).rejects.toMatchObject({
        code: "ENOENT",
      });
    expect(f.request).not.toHaveBeenCalled();
    expect(await readFile(f.chapterPath)).toEqual(before);
    for (const page of f.chapter.pages)
      expect(await readFile(page.imagePath)).toEqual(f.bytes);
    expect(f.settings).toEqual(settings);
    expect(f.app.jobs.all).toEqual([]);
    expect(f.app.jobs.pageHandoffs.activities).toEqual([]);
    expect(JSON.stringify(result)).not.toMatch(
      /imagePath|dataUrl|fixture-key|apiKey|sourceHash/,
    );
  } finally {
    await f.close();
  }
});

it("validates every requested rectangle and explicit permission before model work", async () => {
  const f = await selectionAppFixture();
  try {
    const input = await f.ocrInput();
    const denied = await f.run("carrot_run_selection_ocr", {
      ...input,
      allowAssetDownloads: false,
    });
    expect(denied.job.status).toBe("failed");
    expect(denied.job.error?.code).toBe("access_denied");
    const invalid = await f.ocrInput();
    invalid.pages[1].targets.push({
      kind: "region",
      regionId: "outside",
      sourceRect: { x: 99, y: 0, w: 10, h: 10 },
    });
    expect((await f.run("carrot_run_selection_ocr", invalid)).job.status).toBe(
      "failed",
    );
    expect(f.collect).not.toHaveBeenCalled();
    expect(f.request).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it("rejects changed original bytes even when they remain decodable and regions succeeded", async () => {
  const f = await selectionAppFixture();
  const before = await readFile(f.chapterPath);
  f.collect.mockImplementationOnce(async () => {
    const png = PNG.sync.read(f.bytes);
    png.data[0] = 25;
    await writeFile(f.chapter.pages[1].imagePath, PNG.sync.write(png));
    return {
      hints: [{ x1: 0, y1: 0, x2: 1, y2: 1, ocrText: "changed-source-probe" }],
      diagnostics: [],
    };
  });
  try {
    const { job } = await f.run("carrot_run_selection_ocr", await f.ocrInput());
    expect(job.status).toBe("failed");
    expect(job.error?.code).toBe("revision_conflict");
    expect(job.result?.selectionAnalysis).toBeUndefined();
    await expect(f.get(job.jobId)).rejects.toThrow();
    expect(await readFile(f.chapterPath)).toEqual(before);
  } finally {
    await f.close();
  }
});

it("retains selected-page leases until cancellation cleanup settles and publishes no cancelled evidence", async () => {
  const f = await selectionAppFixture();
  let finish!: () => void;
  const barrier = new Promise<boolean>((resolve) => {
    finish = () => resolve(true);
  });
  f.release.mockImplementationOnce(() => barrier);
  try {
    const receipt = await f.invoke(
      "carrot_run_selection_ocr",
      await f.ocrInput(),
    );
    const id = String(receipt.jobId);
    await vi.waitFor(() => expect(f.release).toHaveBeenCalledOnce());
    await f.operations.cancel(id, f.owner);
    expect(f.operations.status(id, f.owner).status).toBe("running");
    expect(f.app.jobs.pageHandoffs.activities).toHaveLength(2);
    expect(f.app.jobs.all).toHaveLength(1);
    finish();
    expect((await f.settle(id)).status).toBe("cancelled");
    expect(f.collect).toHaveBeenCalledOnce();
    await expect(f.get(id)).rejects.toThrow();
    expect(f.app.jobs.all).toEqual([]);
  } finally {
    finish();
    await f.close();
  }
});

it("retains both inference and cleanup failures and reports empty OCR without erasing existing text", async () => {
  const f = await selectionAppFixture();
  const before = await readFile(f.chapterPath);
  try {
    f.collect.mockRejectedValueOnce(new Error("inference failed"));
    f.release.mockRejectedValueOnce(new Error("cleanup failed"));
    const failed = await f.run("carrot_run_selection_ocr", await f.ocrInput());
    expect(failed.job.status).toBe("failed");
    expect(f.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          errors: expect.arrayContaining([
            expect.objectContaining({ message: "inference failed" }),
            expect.objectContaining({ message: "cleanup failed" }),
          ]),
        }),
      ]),
    );
    f.collect.mockResolvedValue({ hints: [], diagnostics: [] });
    const empty = await f.run("carrot_run_selection_ocr", await f.ocrInput());
    expect(empty.job.status).toBe("completed");
    expect((await f.get(empty.job.jobId)).items[0].ocr?.warnings).toContain(
      "no_text_keep_existing",
    );
    expect(await readFile(f.chapterPath)).toEqual(before);
  } finally {
    await f.close();
  }
});
