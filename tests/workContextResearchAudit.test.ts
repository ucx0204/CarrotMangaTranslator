import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkContextResearchPromptInput } from "../src/main/workContextResearchPrompt";

const timestamp = "2026-09-08T00:00:00.000Z";
const workTitle = "星海の案内人は古都で眠る";
const evidence = {
  title: `${workTitle} | 公式作品紹介`,
  url: "https://publisher.example/work/guide",
  content: `${workTitle} の作品紹介。登場人物のルミナは旅を続ける。`,
  score: 0.95,
};
let rootDir = "";
let dispose: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.resetModules();
  rootDir = await mkdtemp(join(tmpdir(), "manga-research-audit-test-"));
  vi.doMock("../src/main/appPaths", () => ({
    getAppPaths: () => ({
      isPackaged: false,
      repoRoot: rootDir,
      dataRoot: rootDir,
      executableDir: rootDir,
      resourcesDir: rootDir,
      toolsDir: join(rootDir, "tools"),
      ocrRuntimeDir: join(rootDir, "ocr-runtime"),
      llamaRuntimeDir: join(rootDir, "llama"),
      llamaServerPath: join(rootDir, "llama", "llama-server.exe"),
      runtimeDir: join(rootDir, "runtime"),
      libraryDir: join(rootDir, "library"),
      settingsPath: join(rootDir, "settings.json"),
      fontsDir: join(rootDir, "fonts"),
      logsDir: join(rootDir, "logs"),
      logFile: join(rootDir, "logs", "app.log"),
    }),
  }));
  dispose = vi.fn(async () => undefined);
  vi.doMock("../src/main/translationRuntime", () => ({
    loadTranslationRuntimePort: () => ({
      startEndpointSession: async () => ({
        handle: {
          baseUrl: "https://provider.invalid/v1",
          child: null,
          provider: "openai-api",
          startedByScript: false,
        },
        dispose,
      }),
    }),
  }));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.doUnmock("../src/main/appPaths");
  vi.doUnmock("../src/main/translationRuntime");
  vi.resetModules();
  await rm(rootDir, { recursive: true, force: true });
});

describe("research final audit authority", () => {
  it("keeps a retained character update through coverage and postprocessing", async () => {
    const operation = characterUpdate("루미나", "검증된 말투");
    const result = await runAudit([operation], [operation]);
    expect(result.raw.operations).toEqual([operation]);
    expect(result.normalized.operations).toHaveLength(1);
    expect(result.normalized.operations[0]).toMatchObject({
      entity: "character",
      action: "update",
      after: { id: "character-1", note: "검증된 말투" },
    });
    expect(result.normalized.warnings).toEqual(
      expect.arrayContaining(["initial warning", "audit warning"]),
    );
  });

  it("does not reintroduce an existing-character update omitted by the audit", async () => {
    const result = await runAudit(
      [characterUpdate("루미나", "잘못 제안된 말투")],
      [],
    );
    expect(result.raw.operations).toEqual([]);
    expect(result.normalized.operations).toEqual([]);
    expect(result.normalized.warnings).toEqual(
      expect.arrayContaining(["initial warning", "audit warning"]),
    );
  });

  it("keeps only the audit's corrected replacement, including its new name", async () => {
    const replacement = characterUpdate("루미나", "검증된 설명");
    const result = await runAudit(
      [characterUpdate("루미나 오역", "잘못된 설명")],
      [replacement],
    );
    expect(result.raw.operations).toEqual([replacement]);
    expect(result.normalized.operations).toHaveLength(1);
    expect(result.normalized.operations[0]).toMatchObject({
      after: { targetName: "루미나", note: "검증된 설명" },
    });
  });

  it("falls back to the initial proposal when the audit request fails", async () => {
    const initial = characterUpdate("루미나", "초기 설명");
    const result = await runAudit([initial], new Error("audit unavailable"));
    expect(result.raw.operations).toEqual([initial]);
    expect(result.normalized.operations).toHaveLength(1);
    expect(result.normalized.operations[0]).toMatchObject({
      after: { note: "초기 설명" },
    });
    expect(result.normalized.warnings).toContain("initial warning");
  });

  it.each(["missing-operations", "malformed-json"] as const)(
    "preserves the initial proposal after an invalid audit: %s",
    async (invalidAudit) => {
      const initial = characterUpdate("루미나", "초기 설명");
      const result = await runAudit([initial], invalidAudit);
      expect(result.raw.operations).toEqual([initial]);
      expect(result.normalized.operations).toHaveLength(1);
      expect(result.normalized.operations[0]).toMatchObject({
        after: { note: "초기 설명" },
      });
      expect(result.normalized.warnings).toContain("initial warning");
    },
  );
});

async function runAudit(
  initial: unknown[],
  audit: unknown[] | Error | "missing-operations" | "malformed-json",
) {
  let modelRequests = 0;
  const fetchMock = vi.fn<typeof fetch>(async (url) => {
    if (String(url) === "https://api.tavily.com/usage") {
      return Response.json({ key: { usage: 0, limit: 1 } });
    }
    if (String(url) === "https://api.tavily.com/search") {
      return Response.json({ results: [evidence], usage: { credits: 1 } });
    }
    expect(String(url)).toBe("https://provider.invalid/v1/chat/completions");
    modelRequests += 1;
    if (modelRequests === 3 && audit instanceof Error) throw audit;
    if (modelRequests >= 3 && audit === "malformed-json") {
      return Response.json({ choices: [{ message: { content: "{broken" } }] });
    }
    const payload =
      modelRequests === 1
        ? { queries: [`"${workTitle}" 登場人物`] }
        : modelRequests === 2
          ? { operations: initial, warnings: ["initial warning"] }
          : modelRequests === 3
            ? audit === "missing-operations"
              ? { warnings: ["invalid audit"] }
              : { operations: audit, warnings: ["audit warning"] }
            : { translations: [] };
    return Response.json({
      choices: [{ message: { content: JSON.stringify(payload) } }],
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  const { resolveDefaultAppSettings } = await import("../src/main/appSettings");
  const { researchWithTavily } =
    await import("../src/main/workContextResearchGemma");
  const { postprocessWorkContextResearch } =
    await import("../src/main/workContextResearchPostprocess");
  const settings = resolveDefaultAppSettings({}, null);
  settings.api = {
    ...settings.api,
    baseUrl: "https://provider.invalid/v1",
    apiKey: "audit-test-key",
    keyMaxAttempts: 0,
    retryDelaySeconds: 0,
  };
  settings.internetResearch = {
    ...settings.internetResearch,
    tavilyApiKey: "tavily-test-key",
    tavilyMaxCreditsPerRun: 1,
    tavilyAnalysisProvider: "api",
    apiModel: "test-model",
  };
  const promptInput = makeInput();
  const stages: string[] = [];
  const result = await researchWithTavily(
    promptInput,
    settings,
    undefined,
    (progress) => stages.push(progress.progressText ?? ""),
  );
  expect(stages).toContain("핵심 항목 누락 확인 중");
  expect(result.queryCount).toBe(1);
  expect(modelRequests).toBe(audit === "malformed-json" ? 4 : 3);
  expect(dispose).toHaveBeenCalledOnce();
  const normalized = postprocessWorkContextResearch({
    ...result,
    promptInput,
    usage: { workId: "work-1", glossary: [], characters: [] },
    allowedSourceUrls: [...result.allowedSourceUrls],
  });
  return { raw: result.raw as { operations: unknown[] }, normalized };
}

function characterUpdate(targetName: string, note: string) {
  return {
    entity: "character",
    action: "update",
    entryId: "character-1",
    sourceNames: ["ルミナ"],
    targetName,
    note,
    reason: "작품의 등장인물 설명과 대조했습니다.",
    confidence: "high",
    sources: [{ title: evidence.title, url: evidence.url }],
  };
}

function makeInput(): WorkContextResearchPromptInput {
  return {
    workTitle,
    guide: {
      schemaVersion: 1,
      workId: "work-1",
      glossary: [],
      characters: [
        {
          id: "character-1",
          displayName: "루미나",
          sourceNames: ["ルミナ"],
          targetName: "루미나",
          speechStyle: "neutral",
          origin: "ai",
          enabled: true,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
      rules: {
        honorifics: "adapt",
        sfxMode: "translate",
        defaultTone: "natural_korean",
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    selection: {
      text: 'B1: source="ルミナ、行こう" | target="루미나, 가자"',
      basePages: [],
      coverage: {
        scope: "work",
        workId: "work-1",
        requestedChapterId: "chapter-1",
        totalChapters: 1,
        includedChapters: 1,
        totalPages: 1,
        includedPages: 1,
        selectedChars: 40,
        maxInputChars: 65_536,
        truncated: false,
      },
    },
  };
}
