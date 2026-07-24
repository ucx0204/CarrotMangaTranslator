import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getLocale: () => "ko-KR",
    getVersion: () => "1.5.0",
    isPackaged: false,
  },
}));

import {
  buildErrorReportDraft,
  type ErrorReportBuildEnvironment,
} from "../src/main/errorReport";
import { redactDiagnosticText } from "../src/main/errorReportRedaction";
import type { AppPaths } from "../src/main/appPaths";
import type { AppSettings } from "../src/shared/settingsTypes";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("error report diagnostics", () => {
  it("redacts secrets, user content, and generic local paths idempotently", () => {
    const paths = makeAppPaths("C:\\Users\\sam\\Downloads\\translator");
    const input = [
      "C:\\Users\\sam\\private\\page.png",
      "D:\\external-manga\\chapter 1\\001.png",
      "file:///E:/projects/private-app/src/main.ts:42:1",
      "F%3A%5Cscans%5Csecret%5C002.png",
      "/Users/alice/Library/Application Support/private/page.png",
      "file%3A%2F%2F%2FUsers%2Falice%2Fprivate%2Fpage.png",
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
      "https://example.test/v1?api_key=very-secret-value",
      '{"apiKey":"sk-proj-abcdefghijklmnop","sourceText":"秘密","outputPreview":"translated page"}',
    ].join("\n");

    const first = redactDiagnosticText(input, {
      appPaths: paths,
      homeDir: "C:\\Users\\sam",
    });
    const second = redactDiagnosticText(first.text, {
      appPaths: paths,
      homeDir: "C:\\Users\\sam",
    });

    expect(first.redactionCount).toBeGreaterThan(6);
    expect(first.text).not.toContain("sam");
    expect(first.text).not.toContain("external-manga");
    expect(first.text).not.toContain("private-app");
    expect(first.text).not.toContain("alice");
    expect(first.text).not.toContain("very-secret-value");
    expect(first.text).not.toContain("秘密");
    expect(first.text).not.toContain("translated page");
    expect(first.text).toContain("<local-path>");
    expect(first.text).toContain("<redacted>");
    expect(second).toEqual({ text: first.text, redactionCount: 0 });
  });

  it("keeps only the latest 200 WARN/ERROR lines and exposes safe settings", async () => {
    const dir = createTempDir();
    const paths = makeAppPaths(dir);
    mkdirSync(paths.logsDir, { recursive: true });
    const previousLines = Array.from({ length: 210 }, (_, index) =>
      logLine("ERROR", `previous-entry-${String(index).padStart(3, "0")}`),
    );
    const currentLines = [
      logLine("INFO", "ignored-info"),
      ...Array.from({ length: 10 }, (_, index) =>
        logLine("WARN", `current-entry-${String(index).padStart(3, "0")}`),
      ),
    ];
    const previousLogPath = join(paths.logsDir, "previous.log");
    writeFileSync(previousLogPath, previousLines.join("\n"), "utf8");
    writeFileSync(paths.logFile, currentLines.join("\n"), "utf8");

    const draft = await buildErrorReportDraft(
      {
        source: "job-failure",
        summary: "Translation failed",
        message:
          "Authorization: Bearer abcdefghijklmnop at D:\\manga\\secret\\001.png",
        jobStage: "translation",
      },
      makeEnvironment(paths, previousLogPath),
    );
    const combined = `${draft.errorMarkdown}${draft.systemMarkdown}${draft.logsMarkdown}`;
    const logEntryCount =
      draft.logsMarkdown.match(/\[(?:current|previous)\]/g)?.length ?? 0;

    expect(draft.defaultTitle).toContain("job failed");
    expect(logEntryCount).toBe(200);
    expect(draft.logsMarkdown).not.toContain("previous-entry-000");
    expect(draft.logsMarkdown).not.toContain("previous-entry-019");
    expect(draft.logsMarkdown).toContain("previous-entry-020");
    expect(draft.logsMarkdown).toContain("current-entry-009");
    expect(draft.logsMarkdown).not.toContain("ignored-info");
    expect(draft.systemMarkdown).toContain("openai-api");
    expect(draft.systemMarkdown).toContain("safe-model-id");
    expect(combined).not.toContain("sk-private-api-key");
    expect(combined).not.toContain("Authorization: Bearer abcdefghijklmnop");
    expect(combined).not.toContain("D:\\manga");
    expect(Buffer.byteLength(combined, "utf8")).toBeLessThanOrEqual(54 * 1024);
  });

  it("caps logs at 48 KiB and leaves headroom below the 60 KiB IPC limit", async () => {
    const dir = createTempDir();
    const paths = makeAppPaths(dir);
    mkdirSync(paths.logsDir, { recursive: true });
    const previousLogPath = join(paths.logsDir, "previous.log");
    writeFileSync(previousLogPath, "", "utf8");
    writeFileSync(
      paths.logFile,
      Array.from({ length: 200 }, (_, index) =>
        logLine("ERROR", `entry-${index}-${"x".repeat(1200)}`),
      ).join("\n"),
      "utf8",
    );

    const draft = await buildErrorReportDraft(
      {
        source: "react-boundary",
        message: "renderer failed",
        stack: "stack frame\n".repeat(5000),
      },
      makeEnvironment(paths, previousLogPath),
    );
    const combined = `${draft.errorMarkdown}${draft.systemMarkdown}${draft.logsMarkdown}`;

    expect(draft.truncated).toBe(true);
    expect(Buffer.byteLength(draft.logsMarkdown, "utf8")).toBeLessThanOrEqual(
      48 * 1024,
    );
    expect(Buffer.byteLength(combined, "utf8")).toBeLessThanOrEqual(54 * 1024);
  });

  it("still builds a report when current and previous log files are missing", async () => {
    const dir = createTempDir();
    const paths = makeAppPaths(dir);
    const draft = await buildErrorReportDraft(
      { source: "manual" },
      makeEnvironment(paths, join(paths.logsDir, "previous.log")),
    );

    expect(draft.logsMarkdown).toContain("No WARN/ERROR entries");
  });

  it("prefixes Apple Silicon Alpha issues and includes Metal metadata", async () => {
    const dir = createTempDir();
    const paths = makeAppPaths(dir);
    const environment: ErrorReportBuildEnvironment = {
      ...makeEnvironment(paths, join(paths.logsDir, "previous.log")),
      platform: "darwin",
      arch: "arm64",
      osRelease: "23.6.0",
      buildChannel: "mac-alpha",
      gpu: {
        name: "Apple M2 Pro",
        memoryMb: 24 * 1024,
        unifiedMemoryMb: 24 * 1024,
        rtxGeneration: null,
        computeCapability: null,
        vendor: "apple",
        supportsMetal: true,
      },
    };

    const draft = await buildErrorReportDraft(
      { source: "job-failure", jobStage: "inpainting" },
      environment,
    );

    expect(draft.defaultTitle).toMatch(/^\[macOS Alpha\]/);
    expect(draft.systemMarkdown).toContain("Apple M2 Pro");
    expect(draft.systemMarkdown).toContain("24576 MiB");
    expect(draft.systemMarkdown).toContain("Build channel: `mac-alpha`");
  });
});

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "manga-error-report-"));
  tempDirs.push(dir);
  return dir;
}

function logLine(level: "INFO" | "WARN" | "ERROR", message: string): string {
  return `[2026-07-16T00:00:00.000Z] [${level}] ${message}`;
}

function makeEnvironment(
  paths: AppPaths,
  previousLogPath: string,
): ErrorReportBuildEnvironment {
  return {
    appPaths: paths,
    appVersion: "1.5.0",
    locale: "ko-KR",
    isPackaged: true,
    platform: "win32",
    arch: "x64",
    osRelease: "10.0.26100",
    electronVersion: "39.2.7",
    nodeVersion: "22.0.0",
    settings: makeSettings(),
    gpu: {
      name: "Example GPU",
      memoryMb: 16384,
      rtxGeneration: null,
      computeCapability: null,
      vendor: "amd",
      rocmTarget: "gfx110X",
    },
    currentLogPath: paths.logFile,
    previousLogPath,
    homeDir: join(paths.dataRoot, ".."),
  };
}

function makeSettings(): AppSettings {
  return {
    modelProvider: "openai-api",
    translation: {
      sourceLanguage: "ja",
      targetLanguage: "ko",
    },
    gemma: {
      modelSource: "local",
      localModelPath: "D:\\private\\model.gguf",
      modelRepo: "private/repo",
      modelFile: "private.gguf",
      vramMode: "economy26b",
    },
    codex: {
      model: "gpt-test",
      reasoningEffort: "low",
      oauthPort: 10531,
    },
    api: {
      baseUrl: "https://private.example.test/v1?api_key=secret",
      model: "safe-model-id",
      apiKey: "sk-private-api-key",
      customHeadersJson: '{"Authorization":"Bearer private"}',
      extraBodyJson: '{"prompt":"private manga text"}',
    },
    ocr: {
      device: "gpu",
      qualityMode: "economy",
      gpuBackend: "rocm-transformers",
    },
    inpainting: {
      model: "lama-manga",
      fluxBackend: "zluda-native",
      koharuBackend: "zluda-native",
    },
    maxTokens: 12000,
    ctx: 16384,
  };
}

function makeAppPaths(dataRoot: string): AppPaths {
  const logsDir = join(dataRoot, "logs");
  const toolsDir = join(dataRoot, "tools");
  return {
    isPackaged: false,
    repoRoot: dataRoot,
    executableDir: dataRoot,
    resourcesDir: join(dataRoot, "resources"),
    dataRoot,
    settingsPath: join(dataRoot, "settings.json"),
    libraryDir: join(dataRoot, "library"),
    fontsDir: join(dataRoot, "fonts"),
    logsDir,
    logFile: join(logsDir, "app.log"),
    runtimeDir: join(dataRoot, "runtime"),
    toolsDir,
    ocrRuntimeDir: join(dataRoot, "ocr-runtime"),
    llamaRuntimeDir: toolsDir,
    llamaServerPath: join(toolsDir, "llama-server.exe"),
  };
}
