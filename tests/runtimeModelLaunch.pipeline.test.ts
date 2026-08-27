import { describe, it, expect } from "vitest";
import {
  createTempDir,
  resolveFfmpegPath,
  withOcrBatchPipelineStubs,
  resolveOcrCpuWorkerMinFreeRamRatio,
  hasOcrCpuWorkerRamHeadroom,
  MAINLINE_LLAMA_RUNTIME_CUDA13,
  BEELLAMA_LLAMA_RUNTIME_CUDA13,
  shouldExtractLlamaRuntimeFile,
  collectOcrBboxHints,
  requestTranslation,
  resolveOcrInstallBatchProgressRanges,
} from "./helpers/runtimeModelContracts";
import { join } from "node:path";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";

const describeWindows = process.platform === "win32" ? describe : describe.skip;

describeWindows("runtime model support helpers: OCR pipeline execution", () => {
  it("prefers the bundled ffmpeg from the tools directory", () => {
    const toolsDir = createTempDir("tools-");
    const binaryName = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
    const ffmpegPath = join(toolsDir, "ffmpeg", binaryName);
    mkdirSync(join(toolsDir, "ffmpeg"), { recursive: true });
    writeFileSync(ffmpegPath, "binary");

    expect(resolveFfmpegPath({ toolsDir })).toBe(ffmpegPath);
  });

  it("does not fall back to system ffmpeg from a packaged tools directory", () => {
    const packagedRoot = createTempDir("packaged-");
    const toolsDir = join(packagedRoot, "resources", "tools");
    mkdirSync(toolsDir, { recursive: true });

    expect(() => resolveFfmpegPath({ toolsDir })).toThrow(
      "Bundled ffmpeg is missing",
    );
  });

  it("streams OCR batch progress without inheriting the first page index during runtime setup", async () => {
    const outputDir = createTempDir("ocr-batch-progress-");
    const progressEvents: Array<Record<string, unknown>> = [];
    const runtimeSetupOptions: Array<Record<string, unknown>> = [];
    let observedBatchPath = "";

    await withOcrBatchPipelineStubs(
      {
        ensurePaddleOcrRuntime(options) {
          runtimeSetupOptions.push({ ...options });
          return {
            pythonPath: "python",
            runtimeDir: join(outputDir, "runtime"),
            prepared: true,
            diagnostics: [],
          };
        },
        buildOcrBboxBatchCommand(_options, batchPath) {
          observedBatchPath = batchPath;
          return {
            executable: process.execPath,
            args: ["ocr-batch-command"],
          };
        },
        async runCommand(_command, options) {
          options.onOutput?.(
            JSON.stringify({ phase: "start", index: 1, total: 2, count: 0 }),
          );
          const batch = JSON.parse(readFileSync(observedBatchPath, "utf8")) as {
            items: Array<{ output: string }>;
          };
          for (const [index, item] of batch.items.entries()) {
            writeFileSync(
              item.output,
              JSON.stringify([
                {
                  label: "text",
                  bbox: [10 + index, 20, 40 + index, 60],
                  text: "日本語",
                },
              ]),
              "utf8",
            );
          }
          options.onOutput?.(
            JSON.stringify({ phase: "done", index: 1, total: 2, count: 1 }),
          );
          return { stdout: "", stderr: "" };
        },
      },
      async ({ collectOcrBboxHintsBatch }) => {
        const results = await collectOcrBboxHintsBatch([
          {
            imagePath: join(outputDir, "page-1.png"),
            outputDir,
            imageWidth: 100,
            imageHeight: 100,
            ocrBboxProvider: "paddleocr",
            ocrPageIndex: 7,
            ocrPageTotal: 9,
            ocrBatchCompletedBefore: 6,
            ocrBatchTotal: 9,
            onProgress: (event: Record<string, unknown>) => {
              progressEvents.push(event);
            },
          },
          {
            imagePath: join(outputDir, "page-2.png"),
            outputDir,
            imageWidth: 100,
            imageHeight: 100,
            ocrBboxProvider: "paddleocr",
            ocrPageIndex: 8,
            ocrPageTotal: 9,
            onProgress: (event: Record<string, unknown>) => {
              progressEvents.push(event);
            },
          },
        ]);

        expect(results).toHaveLength(2);
        expect(results[0]?.hints).toHaveLength(1);
      },
    );

    expect(runtimeSetupOptions).toHaveLength(1);
    expect(runtimeSetupOptions[0]).not.toHaveProperty("ocrPageIndex");
    expect(runtimeSetupOptions[0]).not.toHaveProperty("ocrPageTotal");
    expect(runtimeSetupOptions[0]).not.toHaveProperty("pageIndex");
    expect(runtimeSetupOptions[0]).not.toHaveProperty("pageTotal");
    expect(progressEvents[0]).toMatchObject({
      phase: "ocr_running",
      progressText: "Paddle OCR 배치 위치 분석 중",
      pageIndex: null,
      pageTotal: null,
      progressCurrent: 6,
      progressTotal: 9,
    });
    expect(progressEvents).toContainEqual(
      expect.objectContaining({
        phase: "ocr_running",
        progressText: "7 / 9 페이지 Paddle OCR 분석 중",
        pageIndex: 7,
        pageTotal: 9,
        progressCurrent: 6,
        progressTotal: 9,
      }),
    );
    expect(progressEvents).toContainEqual(
      expect.objectContaining({
        progressText: "7 / 9 페이지 Paddle OCR 분석 중",
        detail: "1개 후보",
        progressCurrent: 7,
      }),
    );
  });

  it("splits CPU PaddleOCR batches across workers with two threads each", async () => {
    const outputDir = createTempDir("ocr-cpu-parallel-");
    const commandBatchPaths = new Map<string, string>();
    const commandEnvs: Array<Record<string, string> | undefined> = [];
    const batchSizes: number[] = [];
    let commandIndex = 0;

    await withOcrBatchPipelineStubs(
      {
        ensurePaddleOcrRuntime() {
          return {
            pythonPath: "python",
            runtimeDir: join(outputDir, "runtime"),
            prepared: true,
            diagnostics: [],
          };
        },
        buildOcrBboxBatchCommand(_options, batchPath) {
          const commandId = `ocr-cpu-batch-${++commandIndex}`;
          commandBatchPaths.set(commandId, batchPath);
          return {
            executable: process.execPath,
            args: [commandId],
          };
        },
        async runCommand(command, options) {
          commandEnvs.push(options.env);
          const commandId = command.args[0] || "";
          const batchPath = commandBatchPaths.get(commandId);
          if (!batchPath) {
            throw new Error(`Missing batch path for ${commandId}`);
          }
          const batch = JSON.parse(readFileSync(batchPath, "utf8")) as {
            items: Array<{ output: string }>;
          };
          batchSizes.push(batch.items.length);
          for (const [index, item] of batch.items.entries()) {
            writeFileSync(
              item.output,
              JSON.stringify([
                {
                  label: "text",
                  bbox: [10 + index, 20, 40 + index, 60],
                  text: "日本語",
                },
              ]),
              "utf8",
            );
          }
          return { stdout: "", stderr: "" };
        },
      },
      async ({ collectOcrBboxHintsBatch }) => {
        const pages = Array.from({ length: 5 }, (_, index) => ({
          imagePath: join(outputDir, `page-${index + 1}.png`),
          outputDir: join(outputDir, `page-${index + 1}`),
          imageWidth: 100,
          imageHeight: 100,
          ocrBboxProvider: "paddleocr",
          ocrDevice: "cpu",
          ocrCpuWorkers: 2,
          ocrCpuWorkerMinFreeRamPercent: 0,
          ocrCpuWorkerStartDelayMs: 0,
        }));
        const results = await collectOcrBboxHintsBatch(pages);

        expect(results).toHaveLength(5);
        expect(results.every((result) => result.hints.length === 1)).toBe(true);
      },
    );

    expect(commandIndex).toBe(2);
    expect(batchSizes).toEqual([3, 2]);
    expect(commandEnvs).toHaveLength(2);
    for (const env of commandEnvs) {
      expect(env?.OMP_NUM_THREADS).toBe("2");
      expect(env?.MKL_NUM_THREADS).toBe("2");
      expect(env?.FLAGS_cpu_math_library_num_threads).toBe("2");
    }
  });

  it("uses a 20 percent free-RAM floor for extra CPU OCR workers", () => {
    expect(resolveOcrCpuWorkerMinFreeRamRatio()).toBe(0.2);
    expect(
      resolveOcrCpuWorkerMinFreeRamRatio({
        ocrCpuWorkerMinFreeRamPercent: 0,
      }),
    ).toBe(0);
    expect(
      resolveOcrCpuWorkerMinFreeRamRatio({
        ocrCpuWorkerMinFreeRamPercent: 35,
      }),
    ).toBe(0.35);
    expect(
      hasOcrCpuWorkerRamHeadroom(
        { freeBytes: 199, totalBytes: 1000, freeRatio: 0.199 },
        0.2,
      ),
    ).toBe(false);
    expect(
      hasOcrCpuWorkerRamHeadroom(
        { freeBytes: 200, totalBytes: 1000, freeRatio: 0.2 },
        0.2,
      ),
    ).toBe(true);
  });

  it("keeps the CUDA 13 llama-server implementation DLL in the managed runtime", () => {
    const flattenRequiredFiles = (files: Array<string | string[]>): string[] =>
      files.flatMap((file) => (Array.isArray(file) ? file : file));

    expect(MAINLINE_LLAMA_RUNTIME_CUDA13.id).toBe("llama-b9553-cuda13.3");
    expect(
      flattenRequiredFiles(MAINLINE_LLAMA_RUNTIME_CUDA13.requiredFiles),
    ).toContain("llama-server-impl.dll");
    expect(
      flattenRequiredFiles(BEELLAMA_LLAMA_RUNTIME_CUDA13.requiredFiles),
    ).not.toContain("llama-server-impl.dll");
    const extractionCases: Array<
      readonly [
        fileName: string,
        relativePath: string | undefined,
        kept: boolean,
      ]
    > = [
      ["llama-server-impl.dll", undefined, true],
      ["vendor-only.dll", undefined, true],
      ["llama-server.exe", undefined, true],
      ["llama-server", undefined, true],
      ["LICENSE", undefined, true],
      ["TensileLibrary.dat", "rocblas/library/TensileLibrary.dat", true],
      ["hipblaslt.dat", "hipblaslt/library/hipblaslt.dat", true],
      ["unrelated.dat", undefined, false],
      ["vendor-only.exe", undefined, false],
      ["readme.txt", undefined, false],
    ];
    for (const [fileName, relativePath, kept] of extractionCases) {
      expect(shouldExtractLlamaRuntimeFile(fileName, relativePath)).toBe(kept);
    }
  });

  it("treats an explicitly empty OCR hint array as a completed OCR pass", async () => {
    const result = await collectOcrBboxHints({
      ocrBboxHints: [],
      ocrBboxProvider: "none",
    });

    expect(result).toMatchObject({
      hints: [],
      diagnostics: [{ provider: "inline", hintCount: 0 }],
      noTextDetected: true,
      textEvidenceCount: 0,
    });
  });

  it("preserves OCR prepass no-text state when the full result is provided", async () => {
    const result = await collectOcrBboxHints({
      ocrBboxResult: {
        hints: [],
        diagnostics: [
          { provider: "paddleocr", reason: "uncertain-empty-result" },
        ],
        noTextDetected: false,
        textEvidenceCount: 0,
      },
      ocrBboxProvider: "none",
    });

    expect(result).toMatchObject({
      hints: [],
      diagnostics: [
        { provider: "paddleocr", reason: "uncertain-empty-result" },
      ],
      noTextDetected: false,
      textEvidenceCount: 0,
    });
  });

  it("does not skip model analysis when OCR found geometry without readable Japanese transcript", async () => {
    const noEvidence = await collectOcrBboxHints({
      ocrBboxHints: [{ id: 1, label: "text", x1: 10, y1: 20, x2: 80, y2: 90 }],
    });
    const hasEvidence = await collectOcrBboxHints({
      ocrBboxHints: [
        {
          id: 1,
          label: "text",
          x1: 10,
          y1: 20,
          x2: 80,
          y2: 90,
          ocrText: "1998年1月",
        },
      ],
    });

    expect(noEvidence).toMatchObject({
      noTextDetected: false,
      textEvidenceCount: 0,
    });
    expect(hasEvidence).toMatchObject({
      noTextDetected: false,
      textEvidenceCount: 1,
    });
  });

  it("returns a synthetic empty overlay instead of calling a model for no-text OCR pages", async () => {
    const result = await requestTranslation(
      { baseUrl: "http://127.0.0.1:1" },
      {
        label: "blank-page",
        modelProvider: "gemma",
        imageWidth: 1000,
        imageHeight: 1000,
        ocrBboxHints: [],
      },
    );

    expect(JSON.parse(result.outputText)).toEqual({ items: [] });
    expect(result.rawResponse).toMatchObject({
      skipped: true,
      reason: "ocr-no-text",
    });
    expect(result.requestBody).toMatchObject({
      noTextDetected: true,
      ocrTextEvidenceCount: 0,
    });
  });

  it("weights OCR GPU install batches so one completed download does not imply half the install is done", () => {
    const ranges = resolveOcrInstallBatchProgressRanges(
      [
        [
          "paddlepaddle-gpu==3.3.1",
          "--extra-index-url",
          "https://www.paddlepaddle.org.cn/packages/stable/cu126/",
        ],
        ["paddleocr[doc-parser]==3.7.0"],
      ],
      0.1,
      0.86,
    );

    expect(ranges).toHaveLength(2);
    expect(ranges[0].start).toBeCloseTo(0.1);
    expect(ranges[0].end).toBeGreaterThan(0.36);
    expect(ranges[0].end).toBeLessThan(0.39);
    expect(ranges[1].start).toBeCloseTo(ranges[0].end);
    expect(ranges[1].end).toBeCloseTo(0.86);
  });
});
