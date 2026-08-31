import { vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobEvent } from "../../src/shared/jobTypes";
import type { MangaPage } from "../../src/shared/libraryTypes";
import type { AppSettings } from "../../src/shared/settingsTypes";
import type { AutomaticFontCandidate } from "../../src/shared/fontMatchingTypes";
import type { TranslationOptions } from "../../src/main/appSettings";
import { resolveDefaultAppSettings } from "../../src/main/appSettings";
import type { AppPaths } from "../../src/main/appPaths";
import type {
  OcrBboxResult,
  PipelineWorkContext,
} from "../../src/main/pipeline/types";
import type { TranslationRuntimePort } from "../../src/main/pipeline/translationRuntimePort";
import type { WholePagePipelineDependencies } from "../../src/main/pipeline/wholePagePipelinePorts";
import { runWholePagePipeline as runWithDependencies } from "../../src/main/wholePagePipeline";
import { successTranslationResult } from "./wholePageTranslationResults";

const tempDirs: string[] = [];
let runSequence = 0;
const require = createRequire(import.meta.url);
const overlayParser = require(
  join(process.cwd(), "src", "main", "runtime", "overlay-parser.cjs"),
) as Pick<
  TranslationRuntimePort,
  | "normalizeItems"
  | "normalizeRegionSingleItem"
  | "parseJsonLenient"
  | "parseRegionSingleItem"
>;

export async function cleanupPipelineTempDirs(): Promise<void> {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}

export async function loadPipeline({
  ocrHintsByImagePath = new Map<string, OcrBboxResult>(),
  requestTranslation = vi.fn().mockResolvedValue(successTranslationResult()),
  sourceLanguage = "ja",
  startEndpointSession,
  fontMatchingCandidates = [],
  fontMatchingPageInference,
}: {
  ocrHintsByImagePath?: ReadonlyMap<string, OcrBboxResult>;
  requestTranslation?: TranslationRuntimePort["requestTranslation"];
  sourceLanguage?: string;
  startEndpointSession?: TranslationRuntimePort["startEndpointSession"];
  fontMatchingCandidates?: readonly AutomaticFontCandidate[];
  fontMatchingPageInference?: WholePagePipelineDependencies["fontMatching"]["pageInference"];
} = {}) {
  const rootDir = await mkdtemp(join(tmpdir(), "mgt-pipeline-"));
  tempDirs.push(rootDir);
  const disposeEndpoint = vi.fn(async (): Promise<void> => undefined);
  const resolveOcrResult = (options: TranslationOptions): OcrBboxResult =>
    ocrHintsByImagePath.get(options.imagePath) ?? emptyOcrResult();
  const collectOcrHints = vi.fn<TranslationRuntimePort["collectOcrHints"]>(
    async (options) => resolveOcrResult(options),
  );
  const collectOcrHintsBatch = vi.fn<
    TranslationRuntimePort["collectOcrHintsBatch"]
  >(async (options) => options.map(resolveOcrResult));
  const saveArtifacts = vi.fn<TranslationRuntimePort["saveArtifacts"]>(
    async (): Promise<void> => undefined,
  );
  const endpointStarter =
    startEndpointSession ??
    vi.fn<TranslationRuntimePort["startEndpointSession"]>(async () => ({
      handle: {
        baseUrl: "http://127.0.0.1:39281",
        child: null,
        startedByScript: false,
      },
      dispose: disposeEndpoint,
    }));
  const saveChapterStoryMemory = vi.fn<
    WholePagePipelineDependencies["pageContext"]["saveChapterStoryMemory"]
  >(async (memory) => memory);
  const saveWorkStyleGuide = vi.fn<
    WholePagePipelineDependencies["pageContext"]["saveWorkStyleGuide"]
  >(async (guide) => guide);
  const info = vi.fn<WholePagePipelineDependencies["diagnostics"]["info"]>();
  const warn = vi.fn<WholePagePipelineDependencies["diagnostics"]["warn"]>();
  const error = vi.fn<WholePagePipelineDependencies["diagnostics"]["error"]>();
  const loadFontMatchingCandidates = vi.fn(
    (_targetLanguage?: string) => fontMatchingCandidates,
  );
  const loadFontMatchingProfile = vi.fn(async (_workId: string) => null);
  const dependencies = {
    paths: makeAppPaths(rootDir),
    settings: {
      getAppSettings: vi.fn(async () => makeAppSettings(sourceLanguage)),
    },
    fontMatching: {
      loadCandidates: loadFontMatchingCandidates,
      loadProfile: loadFontMatchingProfile,
      pageInference: fontMatchingPageInference,
    },
    pageContext: { saveChapterStoryMemory, saveWorkStyleGuide },
    diagnostics: { info, warn, error },
    runtime: {
      isModelCached: () => true,
      startEndpointSession: endpointStarter,
      collectOcrHints,
      collectOcrHintsBatch,
      annotateOcrGroupingEvidenceBatch: async (_options, results) => results,
      requestTranslation,
      saveArtifacts,
      ...overlayParser,
    },
  } satisfies WholePagePipelineDependencies;
  return {
    runWholePagePipeline: (
      options: Parameters<typeof runWithDependencies>[0],
    ) => runWithDependencies(options, dependencies),
    runtime: {
      collectOcrHintsBatch,
      disposeEndpoint,
      saveArtifacts,
      saveChapterStoryMemory,
      saveWorkStyleGuide,
      info,
      warn,
      error,
      loadFontMatchingCandidates,
      loadFontMatchingProfile,
      startEndpointSession: endpointStarter,
    },
  };
}

export function basePipelineOptions(
  pages: MangaPage[],
  events: JobEvent[],
): Parameters<typeof runWithDependencies>[0] {
  const rootDir = join(
    tmpdir(),
    `mgt-pipeline-run-${process.pid}-${runSequence++}`,
  );
  tempDirs.push(rootDir);
  return {
    jobId: "job-1",
    emit: (event) => events.push(event),
    pages,
    runPaths: {
      chapterDir: join(rootDir, "chapter"),
      runDir: join(rootDir, "run"),
    },
    signal: new AbortController().signal,
  };
}

export function makePage(
  id: string,
  name: string,
  overrides: Partial<MangaPage> = {},
): MangaPage {
  return {
    id,
    name,
    imagePath: `C:\\images\\${name}`,
    dataUrl: "",
    width: 1000,
    height: 1400,
    blocks: [],
    analysisStatus: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeStyleGuide() {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    schemaVersion: 1 as const,
    workId: "work-a",
    glossary: [
      {
        id: "glossary-1",
        source: "魔王",
        target: "마왕",
        category: "term" as const,
        aliases: ["魔王様"],
        enabled: true,
        createdAt: now,
        updatedAt: now,
      },
    ],
    characters: [],
    rules: {
      honorifics: "adapt" as const,
      sfxMode: "translate" as const,
      defaultTone: "natural_korean" as const,
    },
    createdAt: now,
    updatedAt: now,
  };
}

function makeStoryMemory() {
  return {
    schemaVersion: 1 as const,
    workId: "work-a",
    chapterId: "chapter-a",
    updatedAt: "2026-01-01T00:00:00.000Z",
    pages: [0, 1, 2].map((pageIndex) => ({
      pageId: `memory-${pageIndex}`,
      pageName: `${pageIndex + 1}.png`,
      pageIndex,
      sourceDigest: `source ${pageIndex}`,
      translatedDigest: `translated ${pageIndex}`,
      summary: `summary ${pageIndex}`,
      updatedAt: "2026-01-01T00:00:00.000Z",
    })),
  };
}

export function makeEmptyWorkContext(): PipelineWorkContext {
  return {
    workId: "work-a",
    chapterId: "chapter-a",
    styleGuide: { ...makeStyleGuide(), glossary: [] },
    storyMemory: { ...makeStoryMemory(), pages: [] },
    recentPageCount: 6,
  };
}

function makeAppPaths(rootDir: string): AppPaths {
  return {
    isPackaged: false,
    repoRoot: rootDir,
    executableDir: rootDir,
    resourcesDir: rootDir,
    dataRoot: rootDir,
    settingsPath: join(rootDir, "settings.json"),
    libraryDir: join(rootDir, "library"),
    fontsDir: join(rootDir, "fonts"),
    logsDir: join(rootDir, "logs"),
    logFile: join(rootDir, "logs", "app.log"),
    runtimeDir: join(rootDir, "runtime"),
    toolsDir: join(rootDir, "tools"),
    ocrRuntimeDir: join(rootDir, "ocr-runtime"),
    llamaRuntimeDir: join(rootDir, "tools", "llama"),
    llamaServerPath: join(rootDir, "tools", "llama", "llama-server.exe"),
    hfHomeDir: join(rootDir, "hf-home"),
    hfHubCacheDir: join(rootDir, "hf-home", "hub"),
    llamaCacheDir: join(rootDir, "llama-cache"),
  };
}

function makeAppSettings(sourceLanguage: string): AppSettings {
  return {
    modelProvider: "gemma",
    translation: { sourceLanguage, targetLanguage: "ko" },
    gemma: {
      modelSource: "huggingface",
      modelRepo: "repo/model",
      modelFile: "model.gguf",
      vramMode: "minimum12b",
      llamaRuntimeProfile: "cuda12",
    },
    codex: { model: "gpt-5", reasoningEffort: "medium" },
    internetResearch: resolveDefaultAppSettings().internetResearch,
    api: { baseUrl: "https://api.openai.com/v1", model: "gpt-5" },
    ocr: {
      device: "cpu",
      qualityMode: "economy",
      gpuBackend: "cuda",
      gpuCudaTag: "cu124",
    },
    maxTokens: 4096,
    ctx: 131072,
  };
}

function emptyOcrResult(): OcrBboxResult {
  return {
    hints: [],
    diagnostics: [],
    noTextDetected: false,
    textEvidenceCount: 0,
  };
}
