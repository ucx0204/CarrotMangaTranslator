import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  convertImageToPngFileThroughRuntime,
  decodeImageThroughRuntime,
  loadSimplePageRuntime,
  validateImageThroughRuntime,
} from "../src/main/simplePageRuntime";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeRuntimeStub(label: string): string {
  const runtimeDir = mkdtempSync(join(tmpdir(), "mgt-simple-runtime-"));
  tempDirs.push(runtimeDir);
  writeFileSync(
    join(runtimeDir, "simple-page-translate.cjs"),
    `
module.exports = {
  label: ${JSON.stringify(label)},
  startServer: async () => ({ baseUrl: "http://127.0.0.1", child: null, startedByScript: false }),
  stopServer: async () => {},
  isModelCached: () => true,
  ensureOcrRuntime: async () => ({ runtimeVariant: "cpu", pythonPath: "python" }),
  validateImageFileWithFfmpeg: async () => {},
  convertImageToPngFileWithFfmpeg: async () => {},
  testModelReply: async () => ({ outputText: ${JSON.stringify(label)}, launchTarget: { launchMode: "unknown" } })
};
`,
    "utf8",
  );
  return runtimeDir;
}

function writeRuntimeModule(source: string): string {
  const runtimeDir = mkdtempSync(join(tmpdir(), "mgt-simple-runtime-"));
  tempDirs.push(runtimeDir);
  writeFileSync(join(runtimeDir, "simple-page-translate.cjs"), source, "utf8");
  return runtimeDir;
}

describe("simple page runtime loader", () => {
  it("keeps simple-page-translate exports limited to the public runtime API", () => {
    const runtime =
      require("../src/main/runtime/simple-page-translate.cjs") as Record<
        string,
        unknown
      >;

    expect(Object.keys(runtime).sort()).toEqual([
      "collectOcrBboxHints",
      "collectOcrBboxHintsBatch",
      "convertImageToPngBufferWithFfmpeg",
      "convertImageToPngFileWithFfmpeg",
      "ensureOcrRuntime",
      "isModelCached",
      "requestTranslation",
      "saveArtifacts",
      "startServer",
      "stopServer",
      "testModelReply",
      "validateImageFileWithFfmpeg",
      "waitForOcrIdle",
    ]);
  });

  it("caches runtime modules by runtimeDir instead of globally", () => {
    const firstDir = writeRuntimeStub("first");
    const secondDir = writeRuntimeStub("second");

    const firstRuntime = loadSimplePageRuntime(firstDir) as ReturnType<
      typeof loadSimplePageRuntime
    > & { label: string };
    const secondRuntime = loadSimplePageRuntime(secondDir) as ReturnType<
      typeof loadSimplePageRuntime
    > & { label: string };

    expect(firstRuntime.label).toBe("first");
    expect(secondRuntime.label).toBe("second");
    expect(loadSimplePageRuntime(firstDir)).toBe(firstRuntime);
    expect(loadSimplePageRuntime(secondDir)).toBe(secondRuntime);
  });

  it("throws a clear error when a required runtime export is missing", () => {
    const runtimeDir = writeRuntimeModule(`
module.exports = {
  startServer: async () => ({ baseUrl: "http://127.0.0.1", child: null, startedByScript: false }),
  stopServer: async () => {},
  isModelCached: () => true,
  ensureOcrRuntime: async () => ({ runtimeVariant: "cpu", pythonPath: "python" })
};
`);

    expect(() => loadSimplePageRuntime(runtimeDir)).toThrow(
      /simple-page-translate\.cjs.*testModelReply/,
    );
  });

  it("forwards decoder cancellation to the runtime boundary", async () => {
    const runtimeDir = writeRuntimeModule(`
module.exports = {
  startServer: async () => ({ baseUrl: "http://127.0.0.1", child: null, startedByScript: false }),
  stopServer: async () => {},
  isModelCached: () => true,
  ensureOcrRuntime: async () => ({ runtimeVariant: "cpu", pythonPath: "python" }),
  validateImageFileWithFfmpeg: async () => {},
  convertImageToPngFileWithFfmpeg: async () => {},
  testModelReply: async () => ({ outputText: "", launchTarget: { launchMode: "unknown" } }),
  convertImageToPngBufferWithFfmpeg: async (_filePath, options) =>
    Buffer.from(options.abortSignal && options.abortSignal.aborted ? "aborted" : "active")
};
`);
    const controller = new AbortController();
    controller.abort();

    const result = await decodeImageThroughRuntime(
      runtimeDir,
      "source.webp",
      controller.signal,
    );

    expect(result?.toString()).toBe("aborted");
  });

  it("forwards file image validation and conversion limits", async () => {
    const runtimeDir = writeRuntimeModule(`
module.exports = {
  startServer: async () => ({ baseUrl: "http://127.0.0.1", child: null, startedByScript: false }),
  stopServer: async () => {},
  isModelCached: () => true,
  ensureOcrRuntime: async () => ({ runtimeVariant: "cpu", pythonPath: "python" }),
  testModelReply: async () => ({ outputText: "", launchTarget: { launchMode: "unknown" } }),
  validateImageFileWithFfmpeg: async (filePath, options) => {
    if (filePath !== "input.png" || options.maxPixels !== 123 || options.timeoutMs !== 456 || !options.abortSignal) {
      throw new Error("invalid validation options");
    }
  },
  convertImageToPngFileWithFfmpeg: async (sourcePath, outputPath, options) => {
    if (sourcePath !== "input.webp" || outputPath !== "output.png" || options.maxPixels !== 789 || options.maxOutputBytes !== 1011 || options.timeoutMs !== 1213 || !options.abortSignal) {
      throw new Error("invalid conversion options");
    }
  }
};
`);
    const controller = new AbortController();

    await expect(
      validateImageThroughRuntime(runtimeDir, "input.png", {
        maxPixels: 123,
        timeoutMs: 456,
        signal: controller.signal,
      }),
    ).resolves.toBeUndefined();
    await expect(
      convertImageToPngFileThroughRuntime(
        runtimeDir,
        "input.webp",
        "output.png",
        {
          maxPixels: 789,
          maxOutputBytes: 1011,
          timeoutMs: 1213,
          signal: controller.signal,
        },
      ),
    ).resolves.toBeUndefined();
  });

  it("closes the abort race immediately after the FFmpeg process starts", async () => {
    const { convertImageToPngBufferWithFfmpeg } =
      require("../src/main/runtime/assets/image-source-assets.cjs") as {
        convertImageToPngBufferWithFfmpeg: (
          filePath: string,
          options: { abortSignal: AbortSignal; ffmpegPath: string },
        ) => Promise<Buffer>;
      };
    let listenerRegistered = false;
    let listenerRemoved = false;
    const signal = new AbortController().signal;
    Object.defineProperties(signal, {
      aborted: {
        configurable: true,
        get: () => listenerRegistered,
      },
      addEventListener: {
        configurable: true,
        value: () => {
          listenerRegistered = true;
        },
      },
      removeEventListener: {
        configurable: true,
        value: () => {
          listenerRemoved = true;
        },
      },
    });

    await expect(
      convertImageToPngBufferWithFfmpeg("missing-image.webp", {
        abortSignal: signal,
        ffmpegPath: process.execPath,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(listenerRegistered).toBe(true);
    expect(listenerRemoved).toBe(true);
  });
});
