import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const progress = require("../src/main/runtime/simple-page-progress.cjs") as {
  parseOcrBatchProgressLine: (line: unknown) => unknown;
};
const commands =
  require("../src/main/runtime/simple-page-ocr-commands.cjs") as {
    buildOcrBboxBatchCommand: (
      options: Record<string, unknown>,
      batchPath: string,
      runtime: { pythonPath: string },
    ) => string;
  };
const config =
  require("../src/main/runtime/simple-page-ocr-runtime-config.cjs") as {
    buildPaddleOcrGpuFailureMessage: (
      error: unknown,
      options?: Record<string, unknown>,
    ) => string;
  };
const manager =
  require("../src/main/runtime/simple-page-ocr-runtime-manager.cjs") as {
    createOcrRuntimeError: (
      message: string,
      detail?: Record<string, unknown>,
      cause?: unknown,
    ) => Error & Record<string, unknown>;
    resolveOcrInstallBatchProgressRanges: (
      batches: string[][],
      start: number,
      end: number,
    ) => Array<{ start: number; end: number }>;
  };

function replaceCachedExports(modulePath: string, exports: unknown): void {
  const cached = require.cache[modulePath];
  if (!cached) {
    throw new Error(`Expected a cached CommonJS module: ${modulePath}`);
  }
  require.cache[modulePath] = { ...cached, exports } as NodeJS.Module;
}

const describeWindows = process.platform === "win32" ? describe : describe.skip;

describeWindows("OCR runtime boundary behavior", () => {
  it("rejects malformed batch progress and clamps valid producer values", () => {
    expect(progress.parseOcrBatchProgressLine("{")).toBeNull();
    expect(
      progress.parseOcrBatchProgressLine(
        '{"phase":"done","index":0,"total":3,"count":1}',
      ),
    ).toBeNull();
    expect(
      progress.parseOcrBatchProgressLine(
        '{"phase":"unexpected","index":9,"total":3,"count":-4}',
      ),
    ).toEqual({ phase: "done", index: 3, total: 3, count: 0 });
  });

  it("allocates bounded install progress even for reversed input bounds", () => {
    expect(manager.resolveOcrInstallBatchProgressRanges([], -1, 2)).toEqual([]);
    expect(
      manager.resolveOcrInstallBatchProgressRanges(
        [["paddlepaddle"], ["paddleocr"], ["safetensors"]],
        0.9,
        0.2,
      ),
    ).toEqual([
      { start: 0.9, end: 0.9 },
      { start: 0.9, end: 0.9 },
      { start: 0.9, end: 0.9 },
    ]);
  });

  it("keeps ROCm fallback command defaults while honoring explicit model names", () => {
    const command = commands.buildOcrBboxBatchCommand(
      {
        ocrDevice: "gpu:0",
        ocrGpuBackend: "rocm-transformers",
        ocrTextDetectionModelName: "custom-det",
      },
      "batch.json",
      { pythonPath: "python.exe" },
    );

    expect(command).toContain('--engine "transformers"');
    expect(command).toContain('--dtype "float32"');
    expect(command).toContain('--bbox-mode "ocr"');
    expect(command).toContain('--text-detection-model-name "custom-det"');
  });

  it("classifies nested OOM failures without masking unrelated failures", () => {
    const oomMessage = config.buildPaddleOcrGpuFailureMessage(
      {
        message: "OCR subprocess failed",
        cause: new Error("CUDA error: out of memory"),
      },
      { ocrDevice: "gpu:0" },
    );
    const genericMessage = config.buildPaddleOcrGpuFailureMessage(
      new Error("unexpected decoder failure"),
      { ocrDevice: "gpu:0" },
    );

    expect(oomMessage).toContain("VRAM");
    expect(oomMessage).toContain("CUDA error: out of memory");
    expect(genericMessage).toContain("Paddle OCR GPU 실행에 실패");
    expect(genericMessage).not.toContain("VRAM");
  });

  it("preserves the cause and non-retriable runtime failure contract", () => {
    const cause = new Error("pip exited with code 1");
    const error = manager.createOcrRuntimeError(
      "OCR installation failed",
      { step: "pip-install" },
      cause,
    );

    expect(error.cause).toBe(cause);
    expect(error.failureCategory).toBe("ocr-runtime");
    expect(error.nonRetriable).toBe(true);
    expect(error.step).toBe("pip-install");
  });

  it("downloads, extracts, and initializes managed Python on first use", async () => {
    const managedPath =
      require.resolve("../src/main/runtime/ocr/managed-python.cjs");
    const hostPath =
      require.resolve("../src/main/runtime/ocr/host-services.cjs");
    const downloadPath =
      require.resolve("../src/main/runtime/simple-page-download-utils.cjs");
    const shellPath =
      require.resolve("../src/main/runtime/simple-page-shell-utils.cjs");
    const affectedPaths = [managedPath, hostPath, downloadPath, shellPath];
    for (const modulePath of affectedPaths) require(modulePath);
    const originalEntries = new Map(
      affectedPaths.map((modulePath) => [
        modulePath,
        require.cache[modulePath],
      ]),
    );
    const actualHost = require(hostPath) as Record<string, unknown>;
    const actualDownload = require(downloadPath) as Record<string, unknown>;
    const actualShell = require(shellPath) as Record<string, unknown>;
    const root = mkdtempSync(join(tmpdir(), "ocr-managed-python-"));
    const pythonDir = join(root, "bootstrap-python", "python-3.12.7");
    const downloads: Array<{
      file: string;
      url: string;
      progressTitle?: string;
    }> = [];
    const commands: string[] = [];
    const progressEvents: Array<{ title: string; detail: string }> = [];
    const platformDescriptor = Object.getOwnPropertyDescriptor(
      process,
      "platform",
    );

    try {
      Object.defineProperty(process, "platform", {
        configurable: true,
        value: "win32",
      });
      replaceCachedExports(hostPath, {
        ...actualHost,
        runtimeOverrideEnv: () => undefined,
        emitRuntimeProgress(
          _options: unknown,
          _phase: string,
          title: string,
          detail: string,
        ) {
          progressEvents.push({ title, detail });
        },
      });
      replaceCachedExports(downloadPath, {
        ...actualDownload,
        async probeContentLength() {
          return 128;
        },
        async downloadHfFileWithProgress(task: {
          destination: string;
          file: string;
          progressTitle?: string;
          url: string;
        }) {
          downloads.push({
            file: task.file,
            url: task.url,
            progressTitle: task.progressTitle,
          });
          mkdirSync(dirname(task.destination), { recursive: true });
          writeFileSync(task.destination, task.file);
        },
      });
      replaceCachedExports(shellPath, {
        ...actualShell,
        async runShellCommand(command: string) {
          commands.push(command);
          if (command.includes("Expand-Archive")) {
            mkdirSync(pythonDir, { recursive: true });
            writeFileSync(join(pythonDir, "python.exe"), "python");
          }
        },
      });
      delete require.cache[managedPath];
      const managed = require(managedPath) as {
        ensureManagedBootstrapPython: (
          options: Record<string, unknown>,
          runtimeDir: string,
        ) => Promise<string>;
      };

      await expect(
        managed.ensureManagedBootstrapPython({}, root),
      ).resolves.toBe(join(pythonDir, "python.exe"));
      expect(downloads).toEqual([
        {
          file: "python-3.12.7-embed-amd64.zip",
          url: "https://www.python.org/ftp/python/3.12.7/python-3.12.7-embed-amd64.zip",
          progressTitle: "Paddle OCR Python 다운로드 중",
        },
        {
          file: "get-pip.py",
          url: "https://bootstrap.pypa.io/get-pip.py",
          progressTitle: "Paddle OCR pip 다운로드 중",
        },
      ]);
      expect(
        commands.some((command) => command.includes("Expand-Archive")),
      ).toBe(true);
      expect(commands.some((command) => command.includes("get-pip.py"))).toBe(
        true,
      );
      expect(progressEvents.map((event) => event.title)).toEqual(
        expect.arrayContaining([
          "Paddle OCR Python 준비 중",
          "Paddle OCR Python 압축 해제 중",
          "Paddle OCR pip 설치 중",
          "Paddle OCR Python 준비 완료",
        ]),
      );
    } finally {
      if (platformDescriptor) {
        Object.defineProperty(process, "platform", platformDescriptor);
      }
      for (const [modulePath, entry] of originalEntries) {
        if (entry) require.cache[modulePath] = entry;
        else delete require.cache[modulePath];
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("retries a failed venv package install through managed Python", async () => {
    const flowPath =
      require.resolve("../src/main/runtime/ocr/runtime-install-flow.cjs");
    const installerPath =
      require.resolve("../src/main/runtime/ocr/runtime-installer.cjs");
    const verificationPath =
      require.resolve("../src/main/runtime/ocr/runtime-verification.cjs");
    const preparationPath =
      require.resolve("../src/main/runtime/ocr/runtime-preparation.cjs");
    const affectedPaths = [
      flowPath,
      installerPath,
      verificationPath,
      preparationPath,
    ];
    for (const modulePath of affectedPaths) {
      require(modulePath);
    }
    const originalEntries = new Map(
      affectedPaths.map((modulePath) => [
        modulePath,
        require.cache[modulePath],
      ]),
    );
    const actualInstaller = require(installerPath) as Record<string, unknown>;
    const actualVerification = require(verificationPath) as Record<
      string,
      unknown
    >;
    const actualPreparation = require(preparationPath) as Record<
      string,
      unknown
    >;
    const root = mkdtempSync(join(tmpdir(), "ocr-install-fallback-"));
    const venvPython = join(root, "venv", "python.exe");
    const bootstrapPython = join(root, "bootstrap", "python.exe");
    const packageDir = join(root, "packages");
    mkdirSync(join(root, "venv"), { recursive: true });
    writeFileSync(venvPython, "");
    const installCalls: Array<{
      pythonPath: string;
      targetDir: string | null;
    }> = [];
    const embeddedPathCalls: string[] = [];
    let markerPayload: Record<string, unknown> | null = null;

    try {
      replaceCachedExports(installerPath, {
        ...actualInstaller,
        async installOcrPythonPackages(
          pythonPath: string,
          _batches: string[][],
          targetDir: string | null,
        ) {
          installCalls.push({ pythonPath, targetDir });
          if (installCalls.length === 1) {
            throw new Error("venv pip failed");
          }
        },
      });
      replaceCachedExports(verificationPath, {
        ...actualVerification,
        async checkPaddleOcrImport() {
          return { ok: true, message: "" };
        },
        async writeOcrInstallMarker(
          _target: string,
          payload: Record<string, unknown>,
        ) {
          markerPayload = payload;
        },
      });
      replaceCachedExports(preparationPath, {
        ...actualPreparation,
        ensureEmbeddedPythonPackagePath(pythonPath: string) {
          embeddedPathCalls.push(pythonPath);
        },
        async finalizePaddleOcrRuntime(
          _options: Record<string, unknown>,
          runtime: Record<string, unknown>,
        ) {
          return runtime;
        },
      });
      delete require.cache[flowPath];
      const flow = require(flowPath) as {
        installAndFinalizeRuntime: (
          options: Record<string, unknown>,
          state: Record<string, unknown>,
        ) => Promise<Record<string, unknown>>;
      };
      const diagnostics: unknown[] = [];
      const runtime = await flow.installAndFinalizeRuntime(
        { ocrDevice: "cpu" },
        {
          runtimeDir: root,
          runtimeVariant: "cpu",
          venvPython,
          packageDir,
          cachePaths: {},
          diagnostics,
          bootstrapPython,
        },
      );

      expect(installCalls).toEqual([
        { pythonPath: venvPython, targetDir: null },
        { pythonPath: bootstrapPython, targetDir: packageDir },
      ]);
      expect(embeddedPathCalls).toEqual([bootstrapPython]);
      expect(diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            step: "venv-pip-install-failed",
            message: "venv pip failed",
          }),
          expect.objectContaining({ step: "pip-installed" }),
        ]),
      );
      expect(markerPayload).toEqual(
        expect.objectContaining({
          targetDir: packageDir,
          runtimeVariant: "cpu",
        }),
      );
      expect(runtime).toEqual(
        expect.objectContaining({
          pythonPath: bootstrapPython,
          usesTargetPackageDir: true,
        }),
      );
    } finally {
      for (const [modulePath, entry] of originalEntries) {
        if (entry) {
          require.cache[modulePath] = entry;
        } else {
          delete require.cache[modulePath];
        }
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});
