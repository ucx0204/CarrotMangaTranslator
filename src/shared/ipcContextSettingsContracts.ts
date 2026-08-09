import { z } from "zod";
import type {
  CustomFont,
  FontLibrarySnapshot,
  FontPreferences,
} from "./libraryTypes";
import type { LocalModelPickResult, ModelTestResult } from "./jobTypes";
import type {
  ExportReviewTextRequest,
  ImportReviewTextRequest,
  ImportReviewTextResult,
} from "./reviewTypes";
import type { AppSettings } from "./settingsTypes";
import type {
  ApiModelDiscoveryRequest,
  ApiModelDiscoveryResult,
} from "./apiProviderPresets";
import {
  MAX_API_KEYS,
  MAX_API_KEYS_TEXT_LENGTH,
  parseApiKeys,
} from "./apiKeySettings";
import type { SaveTextFileRequest, SaveTextFileResult } from "./shareTypes";
import type {
  AnalyzeWorkContextRequest,
  AnalyzeWorkContextResult,
} from "./workContextAnalysisTypes";
import type {
  ChapterStoryMemory,
  ResetWorkContextRequest,
  ResetWorkContextResult,
  WorkStyleGuide,
} from "./workContextTypes";
import type { WorkContextUsage } from "./workContextUsageTypes";
import { SUPPORTED_UI_LOCALES, type UiLocale } from "./uiLocales";
import {
  AnalyzeWorkContextRequestSchema,
  AppSettingsSchema,
  ChapterSnapshotSchema,
  ChapterStoryMemoryRequestSchema,
  ChapterStoryMemorySchema,
  ExportReviewTextRequestSchema,
  ImportReviewTextRequestSchema,
  SaveTextFileRequestSchema,
  WorkStyleGuideSchema,
} from "./ipcSchemas";
import {
  defineIpcContract,
  diagnosticString,
  localPathResult,
  MAX_WARNINGS,
  nonNegativeInteger,
  stringArg,
} from "./ipcContractCore";

const workContextAnalysisScopeSchema = z.enum(["chapter", "work", "missing"]);
const analyzeWorkContextResultSchema = z
  .object({
    styleGuide: WorkStyleGuideSchema,
    storyMemory: ChapterStoryMemorySchema,
    coverage: z
      .object({
        scope: workContextAnalysisScopeSchema,
        workId: stringArg,
        requestedChapterId: stringArg,
        totalChapters: nonNegativeInteger,
        includedChapters: nonNegativeInteger,
        totalPages: nonNegativeInteger,
        includedPages: nonNegativeInteger,
        selectedChars: nonNegativeInteger,
        maxInputChars: nonNegativeInteger,
        truncated: z.boolean(),
      })
      .strict(),
    counts: z
      .object({
        glossaryAdded: nonNegativeInteger,
        glossaryUpdated: nonNegativeInteger,
        charactersAdded: nonNegativeInteger,
        charactersUpdated: nonNegativeInteger,
        rulesUpdated: nonNegativeInteger,
        pageSummariesUpserted: nonNegativeInteger,
      })
      .strict(),
    warnings: z.array(diagnosticString).max(MAX_WARNINGS),
  })
  .strict();

const workContextUsageLastSeenSchema = z
  .object({
    chapterId: stringArg,
    chapterTitle: z.string().max(260),
    chapterIndex: nonNegativeInteger,
    pageId: stringArg,
    pageName: z.string().max(260),
    pageIndex: nonNegativeInteger,
  })
  .strict();

const workContextUsageMetricSchema = z
  .object({
    id: stringArg,
    pageCount: nonNegativeInteger,
    mentionCount: nonNegativeInteger,
    lastSeen: workContextUsageLastSeenSchema.optional(),
  })
  .strict();

const workContextUsageSchema = z
  .object({
    workId: stringArg,
    glossary: z.array(workContextUsageMetricSchema).max(1000),
    characters: z.array(workContextUsageMetricSchema).max(300),
  })
  .strict();

const resetWorkContextResultSchema = z
  .object({
    styleGuide: WorkStyleGuideSchema,
    storyMemory: ChapterStoryMemorySchema,
    resetChapterCount: nonNegativeInteger,
  })
  .strict();

export const workContextIpcContracts = {
  getWorkStyleGuide: defineIpcContract<[string], WorkStyleGuide>({
    apiKey: "getWorkStyleGuide",
    channel: "context:get-work-style-guide",
    args: z.tuple([stringArg]),
    result: WorkStyleGuideSchema,
  }),
  saveWorkStyleGuide: defineIpcContract<[WorkStyleGuide], WorkStyleGuide>({
    apiKey: "saveWorkStyleGuide",
    channel: "context:save-work-style-guide",
    args: z.tuple([WorkStyleGuideSchema]),
    result: WorkStyleGuideSchema,
  }),
  getChapterStoryMemory: defineIpcContract<[string], ChapterStoryMemory>({
    apiKey: "getChapterStoryMemory",
    channel: "context:get-chapter-story-memory",
    args: z.tuple([stringArg]),
    result: ChapterStoryMemorySchema,
  }),
  saveChapterStoryMemory: defineIpcContract<
    [ChapterStoryMemory],
    ChapterStoryMemory
  >({
    apiKey: "saveChapterStoryMemory",
    channel: "context:save-chapter-story-memory",
    args: z.tuple([ChapterStoryMemorySchema]),
    result: ChapterStoryMemorySchema,
  }),
  resetWorkContext: defineIpcContract<
    [ResetWorkContextRequest],
    ResetWorkContextResult
  >({
    apiKey: "resetWorkContext",
    channel: "context:reset-work-context",
    args: z.tuple([ChapterStoryMemoryRequestSchema]),
    result: resetWorkContextResultSchema,
  }),
  getWorkContextUsage: defineIpcContract<[string], WorkContextUsage>({
    apiKey: "getWorkContextUsage",
    channel: "context:get-work-context-usage",
    args: z.tuple([stringArg]),
    result: workContextUsageSchema,
  }),
  analyzeWorkContext: defineIpcContract<
    [AnalyzeWorkContextRequest],
    AnalyzeWorkContextResult
  >({
    apiKey: "analyzeWorkContext",
    channel: "context:analyze-work-context",
    args: z.tuple([AnalyzeWorkContextRequestSchema]),
    result: analyzeWorkContextResultSchema,
  }),
} as const;

const saveTextFileResultSchema = z
  .object({ saved: z.boolean(), path: localPathResult.optional() })
  .strict();
const importReviewTextResultSchema = z
  .object({
    chapter: ChapterSnapshotSchema,
    updatedBlockCount: nonNegativeInteger,
    skippedRowCount: nonNegativeInteger,
    warnings: z.array(diagnosticString).max(MAX_WARNINGS),
  })
  .strict();

export const textReviewIpcContracts = {
  saveTextFile: defineIpcContract<
    [SaveTextFileRequest],
    SaveTextFileResult | null
  >({
    apiKey: "saveTextFile",
    channel: "text:save-file",
    args: z.tuple([SaveTextFileRequestSchema]),
    result: saveTextFileResultSchema.nullable(),
  }),
  exportReviewText: defineIpcContract<
    [ExportReviewTextRequest],
    SaveTextFileResult | null
  >({
    apiKey: "exportReviewText",
    channel: "review:export-text",
    args: z.tuple([ExportReviewTextRequestSchema]),
    result: saveTextFileResultSchema.nullable(),
  }),
  importReviewText: defineIpcContract<
    [ImportReviewTextRequest],
    ImportReviewTextResult
  >({
    apiKey: "importReviewText",
    channel: "review:import-text",
    args: z.tuple([ImportReviewTextRequestSchema]),
    result: importReviewTextResultSchema,
  }),
} as const;

const customFontSchema = z
  .object({
    id: stringArg,
    label: z.string().min(1).max(260),
    family: z.string().min(1).max(260),
    fileName: z.string().min(1).max(260),
  })
  .strict();

const FontPreferencesSchema = z
  .object({
    favoriteIds: z.array(stringArg).max(500),
    orderedIds: z.array(stringArg).max(500),
    defaultFontId: stringArg,
  })
  .strict();

export const FontLibrarySnapshotSchema = z
  .object({
    customFonts: z.array(customFontSchema).max(500),
    preferences: FontPreferencesSchema,
  })
  .strict();

export const fontIpcContracts = {
  getFontLibrary: defineIpcContract<[], FontLibrarySnapshot>({
    apiKey: "getFontLibrary",
    channel: "fonts:get-library",
    args: z.tuple([]),
    result: FontLibrarySnapshotSchema,
  }),
  saveFontPreferences: defineIpcContract<
    [FontPreferences],
    FontLibrarySnapshot
  >({
    apiKey: "saveFontPreferences",
    channel: "fonts:save-preferences",
    args: z.tuple([FontPreferencesSchema]),
    result: FontLibrarySnapshotSchema,
  }),
  listCustomFonts: defineIpcContract<[], CustomFont[]>({
    apiKey: "listCustomFonts",
    channel: "fonts:list",
    args: z.tuple([]),
    result: z.array(customFontSchema).max(500),
  }),
  registerCustomFont: defineIpcContract<[], CustomFont | null>({
    apiKey: "registerCustomFont",
    channel: "fonts:register",
    args: z.tuple([]),
    result: customFontSchema.nullable(),
  }),
  removeCustomFont: defineIpcContract<[string], CustomFont[]>({
    apiKey: "removeCustomFont",
    channel: "fonts:remove",
    args: z.tuple([stringArg]),
    result: z.array(customFontSchema).max(500),
  }),
} as const;

const localModelPickResultSchema = z
  .object({
    modelPath: localPathResult,
    detectedMmprojPath: localPathResult.optional(),
  })
  .strict();
const modelTestResultSchema = z
  .object({
    ok: z.boolean(),
    message: diagnosticString,
    launchMode: z.enum([
      "huggingface",
      "cached-hf",
      "local",
      "openai-codex",
      "openai-api",
    ]),
    resolvedModelPath: localPathResult.nullable().optional(),
    resolvedMmprojPath: localPathResult.nullable().optional(),
    resolvedEndpoint: z.string().min(1).max(2000).nullable().optional(),
  })
  .strict();
const optionalModelTestArgsSchema = z.union([
  z.tuple([AppSettingsSchema]),
  z.tuple([AppSettingsSchema, z.unknown()]),
]);
const discoverableApiProviderSchema = z.enum([
  "nvidia-nim",
  "google-ai-studio",
  "google-vertex",
  "openrouter",
  "ollama",
]);
const apiModelDiscoveryRequestSchema = z
  .object({
    provider: discoverableApiProviderSchema,
    apiKey: z
      .string()
      .max(MAX_API_KEYS_TEXT_LENGTH)
      .refine((value) => parseApiKeys(value).length <= MAX_API_KEYS),
    vertexProject: z.string().max(100).optional(),
    vertexLocation: z.string().max(100).optional(),
  })
  .strict();
const apiModelDiscoveryResultSchema = z
  .object({
    provider: discoverableApiProviderSchema,
    models: z
      .array(
        z
          .object({
            id: z.string().min(1).max(300),
            label: z.string().min(1).max(500),
            baseUrl: z.string().url().max(2000),
          })
          .strict(),
      )
      .max(2000),
    checkedCount: z.number().int().nonnegative(),
    unverifiedCount: z.number().int().nonnegative(),
  })
  .strict();

export const settingsIpcContracts = {
  getUiLocale: defineIpcContract<[], UiLocale>({
    apiKey: "getUiLocale",
    channel: "settings:get-ui-locale",
    args: z.tuple([]),
    result: z.enum(SUPPORTED_UI_LOCALES),
  }),
  getSettings: defineIpcContract<[], AppSettings>({
    apiKey: "getSettings",
    channel: "settings:get",
    args: z.tuple([]),
    result: AppSettingsSchema,
  }),
  getDefaultSettings: defineIpcContract<[], AppSettings>({
    apiKey: "getDefaultSettings",
    channel: "settings:get-defaults",
    args: z.tuple([]),
    result: AppSettingsSchema,
  }),
  saveSettings: defineIpcContract<[AppSettings], AppSettings>({
    apiKey: "saveSettings",
    channel: "settings:save",
    args: z.tuple([AppSettingsSchema]),
    result: AppSettingsSchema,
  }),
  resetSettings: defineIpcContract<[], AppSettings>({
    apiKey: "resetSettings",
    channel: "settings:reset",
    args: z.tuple([]),
    result: AppSettingsSchema,
  }),
  pickLocalModelFile: defineIpcContract<[], LocalModelPickResult | null>({
    apiKey: "pickLocalModelFile",
    channel: "settings:pick-local-model",
    args: z.tuple([]),
    result: localModelPickResultSchema.nullable(),
  }),
  pickLocalMmprojFile: defineIpcContract<[], string | null>({
    apiKey: "pickLocalMmprojFile",
    channel: "settings:pick-local-mmproj",
    args: z.tuple([]),
    result: localPathResult.nullable(),
  }),
  testModelSettings: defineIpcContract<
    [AppSettings, providedTestId?: unknown],
    ModelTestResult
  >({
    apiKey: "testModelSettings",
    channel: "settings:test-model",
    args: optionalModelTestArgsSchema,
    result: modelTestResultSchema,
  }),
  discoverApiModels: defineIpcContract<
    [ApiModelDiscoveryRequest],
    ApiModelDiscoveryResult
  >({
    apiKey: "discoverApiModels",
    channel: "settings:discover-api-models",
    args: z.tuple([apiModelDiscoveryRequestSchema]),
    result: apiModelDiscoveryResultSchema,
  }),
} as const;
