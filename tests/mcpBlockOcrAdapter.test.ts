import { randomUUID, createHash } from "node:crypto";
import { readFile, writeFile, access } from "node:fs/promises";
import { dirname } from "node:path";
import { PNG } from "pngjs";
import { expect, it, vi } from "vitest";
import type { recognizeMcpBlock } from "../src/main/mcp/mcpBlockOcrAdapter";
import { recoveryLibrary } from "./mcpErasureRecovery.fixture";

type Runtime = NonNullable<Parameters<typeof recognizeMcpBlock>[5]>;
function nativePng(bytes: Buffer) {
  const png = PNG.sync.read(bytes);
  return {
    isEmpty: () => false,
    getSize: () => ({ width: png.width, height: png.height }),
    toPNG: () => PNG.sync.write(png),
    crop: (rect: { x: number; y: number; width: number; height: number }) => {
      const target = new PNG({ width: rect.width, height: rect.height });
      PNG.bitblt(png, target, rect.x, rect.y, rect.width, rect.height, 0, 0);
      return nativePng(PNG.sync.write(target));
    },
  };
}
async function fixture() {
  const nativeImage = {
    createFromPath: () => ({ getSize: () => ({ width: 1000, height: 1600 }) }),
    createFromBuffer: nativePng,
  };
  const f = await recoveryLibrary(nativeImage);
  const raster = new PNG({ width: 1000, height: 1600 });
  raster.data.fill(255);
  raster.data[4 * (20 * 1000 + 10)] = 37;
  const original = PNG.sync.write(raster);
  await writeFile(f.original, original);
  const { recognizeMcpBlock } =
    await import("../src/main/mcp/mcpBlockOcrAdapter");
  const { getAppPaths } = await import("../src/main/appPaths");
  const { ActiveJobStore } = await import("../src/main/jobs/activeJob");
  const app = {
    appPaths: getAppPaths(),
    jobs: new ActiveJobStore({ info: vi.fn(), error: vi.fn() }),
    getMainWindow: () => null,
    decodeImage: async () => null,
  };
  const controller = new AbortController();
  const operation = {
    id: randomUUID(),
    signal: controller.signal,
    progress: vi.fn(),
    assertAuthorized: vi.fn(() => controller.signal.throwIfAborted()),
  };
  const result = {
    hints: [
      {
        x1: 0,
        y1: 0,
        x2: 50,
        y2: 40,
        ocrText: "再読\n한글 🥕",
        direction: "vertical",
      },
    ],
    diagnostics: [],
  };
  const runtime: Runtime = {
    collect: vi.fn<Runtime["collect"]>(async () => structuredClone(result)),
    release: vi.fn<Runtime["release"]>(async () => true),
  };
  const rect = { x: 10, y: 20, w: 90, h: 120 };
  const run = () =>
    recognizeMcpBlock(app, "chapter", f.after, rect, operation, runtime);
  return {
    ...f,
    app,
    originalBytes: original,
    rect,
    operation,
    controller,
    result,
    runtime,
    run,
  };
}

it("reads original pixels into a fresh containing crop, maps evidence back, then removes its temporary files", async () => {
  const f = await fixture();
  try {
    const before = await f.snapshot();
    const inputs: string[] = [];
    const hashes: string[] = [];
    vi.mocked(f.runtime.collect).mockImplementation(async (options) => {
      const bytes = await readFile(options.imagePath);
      const crop = PNG.sync.read(bytes);
      expect(crop.width).toBe(90);
      expect(crop.height).toBe(120);
      expect(crop.data[0]).toBe(37);
      expect(options.imagePath).not.toBe(f.output);
      expect(options.outputDir).not.toContain("ocr-hints");
      expect(options.skipOcrBboxHints).toBe(false);
      expect(options).toMatchObject({ ocrInputKind: "known-block-crop" });
      expect(options.abortSignal).toBe(f.operation.signal);
      options.onProgress?.({ phase: "ocr_running", progressText: "fixture" });
      inputs.push(options.imagePath);
      hashes.push(createHash("sha256").update(bytes).digest("hex"));
      return f.result;
    });
    const first = await f.run();
    const second = await f.run();
    expect(first.sourceCropSha256).toBe(hashes[0]);
    expect(second.sourceCropSha256).toBe(first.sourceCropSha256);
    expect(first.regions[0]).toMatchObject({
      sourceRect: { x: 10, y: 20, w: 50, h: 40 },
      sourceText: "再読\n한글 🥕",
      sourceDirection: "vertical",
    });
    expect(inputs[0]).not.toBe(inputs[1]);
    for (const path of inputs)
      await expect(access(dirname(path))).rejects.toMatchObject({
        code: "ENOENT",
      });
    expect(f.runtime.release).toHaveBeenCalledTimes(2);
    expect(await f.snapshot()).toEqual(before);
    expect(await readFile(f.original)).toEqual(f.originalBytes);
  } finally {
    await f.close();
  }
});

it("includes separately returned effect evidence without running translation or saving blocks", async () => {
  const f = await fixture();
  try {
    vi.mocked(f.runtime.collect).mockResolvedValueOnce({
      ...f.result,
      effectReviewRegions: [
        {
          id: "effect",
          bbox: { x: 500, y: 500, w: 250, h: 250 },
          detectorConfidence: 0.9,
          recognizedText: "ドン",
        },
      ],
    });
    const result = await f.run();
    expect(result.regions).toHaveLength(2);
    expect(result.regions[1]).toMatchObject({
      sourceText: "ドン",
      textRole: "sound",
    });
    expect(result.recognizedText).toContain("ドン");
    expect(JSON.stringify(result)).not.toMatch(
      /confidence|detectorConfidence|imagePath|dataUrl/,
    );
  } finally {
    await f.close();
  }
});

it("waits for model cleanup after successful inference before returning an observation", async () => {
  const f = await fixture();
  let finish!: () => void;
  let entered!: () => void;
  const released = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const releasing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let completed = false;
  vi.mocked(f.runtime.release).mockImplementation(async () => {
    entered();
    await released;
    return true;
  });
  const request = f.run().then((value) => {
    completed = true;
    return value;
  });
  try {
    await releasing;
    expect(completed).toBe(false);
    finish();
    expect((await request).regions).toHaveLength(1);
  } finally {
    finish();
    await f.close();
  }
});

it("keeps the inference failure and the cleanup failure instead of publishing partial text", async () => {
  const f = await fixture();
  try {
    const inference = new Error("OCR failed");
    const cleanup = new Error("release failed");
    vi.mocked(f.runtime.collect).mockRejectedValueOnce(inference);
    vi.mocked(f.runtime.release).mockRejectedValueOnce(cleanup);
    await expect(f.run()).rejects.toMatchObject({
      errors: [inference, cleanup],
    });
  } finally {
    await f.close();
  }
});

it("rejects cleanup failure even when inference succeeded", async () => {
  const f = await fixture();
  try {
    vi.mocked(f.runtime.release).mockRejectedValueOnce(
      new Error("release failed"),
    );
    await expect(f.run()).rejects.toThrow("release failed");
  } finally {
    await f.close();
  }
});

it("cleans up after cancellation without returning stale text", async () => {
  const f = await fixture();
  try {
    vi.mocked(f.runtime.collect).mockImplementationOnce(async () => {
      f.controller.abort();
      return f.result;
    });
    await expect(f.run()).rejects.toThrow();
    expect(f.runtime.release).toHaveBeenCalledOnce();
    expect(await readFile(f.original)).toEqual(f.originalBytes);
  } finally {
    await f.close();
  }
});

it("detects source-file changes occurring during OCR", async () => {
  const f = await fixture();
  try {
    vi.mocked(f.runtime.collect).mockImplementationOnce(async () => {
      await writeFile(f.original, "replaced original");
      return f.result;
    });
    await expect(f.run()).rejects.toMatchObject({ code: "revision_conflict" });
    expect(f.runtime.release).toHaveBeenCalledOnce();
  } finally {
    await f.close();
  }
});

it("rejects raster dimension changes before inference and still releases temporary resources", async () => {
  const f = await fixture();
  try {
    f.after.width = 999;
    await expect(f.run()).rejects.toMatchObject({ code: "revision_conflict" });
    expect(f.runtime.collect).not.toHaveBeenCalled();
    expect(f.runtime.release).toHaveBeenCalledOnce();
  } finally {
    await f.close();
  }
});

it("rejects an oversized observation instead of silently keeping only the first regions", async () => {
  const f = await fixture();
  try {
    vi.mocked(f.runtime.collect).mockResolvedValueOnce({
      hints: Array.from({ length: 101 }, () => f.result.hints[0]),
      diagnostics: [],
    });
    await expect(f.run()).rejects.toMatchObject({ code: "invalid_edit" });
  } finally {
    await f.close();
  }
});

it("composes the actual block OCR executor under app page/model ownership without a write", async () => {
  const f = await fixture();
  const { createMcpBlockOcrExecutor } =
    await import("../src/main/mcp/mcpBlockOcrSession");
  const { createPageRevision } = await import("../src/shared/pageRevision");
  const stop = f.app.jobs.pageHandoffs.subscribe(() => {
    for (const page of f.app.jobs.pageHandoffs.activities)
      if (page.phase === "finishing-edits" && page.requestId)
        f.app.jobs.pageHandoffs.respond({ requestId: page.requestId });
  });
  try {
    const before = await f.snapshot();
    vi.mocked(f.runtime.collect).mockImplementationOnce(async () => {
      expect(f.app.jobs.gate.activities.length).toBeGreaterThan(0);
      expect(f.app.jobs.pageHandoffs.activities).toContainEqual(
        expect.objectContaining({
          pageId: f.target.pageId,
          phase: "processing",
        }),
      );
      return f.result;
    });
    const execute = createMcpBlockOcrExecutor(f.app, f.runtime);
    const result = await execute(
      {
        ...f.target,
        revision: createPageRevision(f.after),
        requestId: randomUUID(),
      },
      f.operation,
    );
    expect(result).toMatchObject({ status: "observed", pagesChanged: 0 });
    expect(await f.snapshot()).toEqual(before);
    expect(f.runtime.collect).toHaveBeenCalledOnce();
    expect(f.runtime.release).toHaveBeenCalledOnce();
    expect(f.app.jobs.gate.activities).toEqual([]);
  } finally {
    stop();
    await f.close();
  }
});
