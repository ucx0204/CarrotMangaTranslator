import { z } from "zod";
import { MAX_ID_LIST_LENGTH } from "./ipcSchemaPrimitives";
import type {
  RegionAnalysisRequest,
  RegionAnalysisResult,
  StartAnalysisRequest,
  StartAnalysisResult,
} from "./analysisTypes";
import type {
  ApplyInpaintingHistoryTransactionRequest,
  ApplyInpaintingHistoryTransactionResult,
  InpaintingColorSampleRequest,
  InpaintingColorSampleResult,
  InpaintingRetouchRequest,
  InpaintingRetouchResult,
  InpaintingRevertRequest,
  InpaintingRevertResult,
  ReleaseInpaintingHistoryTransactionsRequest,
  ReleaseInpaintingHistoryTransactionsResult,
  SetPageInpaintingResultRequest,
  SetPageInpaintingResultResult,
  StartInpaintingRequest,
  StartInpaintingResult,
} from "./inpaintingTypes";
import {
  PAGE_IMAGE_EXPORT_PREFLIGHT_ISSUE_CODES,
  type PageImageExportPreflightResult,
  type PageImageExportRequest,
  type PageImageExportResult,
  type PageExportSelectionRequest,
  type PagePsdExportRequest,
} from "./pageImageExportTypes";
import {
  ApplyInpaintingHistoryTransactionRequestSchema,
  ChapterSnapshotSchema,
  InpaintingColorSampleRequestSchema,
  InpaintingRetouchRequestSchema,
  InpaintingRevertRequestSchema,
  PageImageExportRequestSchema,
  PageImageExportPreflightRequestSchema,
  PagePsdExportRequestSchema,
  RegionAnalysisRequestSchema,
  ReleaseInpaintingHistoryTransactionsRequestSchema,
  SetPageInpaintingResultRequestSchema,
  StartAnalysisRequestSchema,
  StartInpaintingRequestSchema,
} from "./ipcSchemas";
import {
  analysisResultStatusSchema,
  defineIpcContract,
  diagnosticString,
  localPathResult,
  MAX_BLOCKS_PER_RESULT,
  MAX_WARNINGS,
  nonNegativeInteger,
  stringArg,
} from "./ipcContractCore";

const startAnalysisResultSchema = z
  .object({
    status: analysisResultStatusSchema,
    chapter: ChapterSnapshotSchema.optional(),
    warnings: z.array(diagnosticString).max(MAX_WARNINGS).optional(),
    error: diagnosticString.optional(),
  })
  .strict();
const regionAnalysisResultSchema = startAnalysisResultSchema
  .extend({
    pageId: stringArg.optional(),
    blockIds: z
      .array(z.string().min(1).max(200))
      .max(MAX_BLOCKS_PER_RESULT)
      .optional(),
  })
  .strict();
const inpaintingResultStatusSchema = z.enum([
  "completed",
  "partial",
  "cancelled",
  "failed",
]);
const startInpaintingResultSchema = z
  .object({
    status: inpaintingResultStatusSchema,
    chapter: ChapterSnapshotSchema.optional(),
    chapters: z.array(ChapterSnapshotSchema).max(MAX_ID_LIST_LENGTH).optional(),
    pagesChanged: nonNegativeInteger.optional(),
    blocksErased: nonNegativeInteger.optional(),
    pagesIncomplete: nonNegativeInteger.optional(),
    blocksIncomplete: nonNegativeInteger.optional(),
    historyTransaction: z
      .object({ transactionId: z.string().uuid() })
      .strict()
      .optional(),
    error: diagnosticString.optional(),
  })
  .strict();
const inpaintingRetouchResultSchema = z
  .object({
    chapter: ChapterSnapshotSchema,
    pageId: stringArg,
    historyTransaction: z
      .object({ transactionId: z.string().uuid() })
      .strict()
      .optional(),
  })
  .strict();
const inpaintingRevertResultSchema = z
  .object({
    chapter: ChapterSnapshotSchema,
    pagesChanged: nonNegativeInteger,
    historyTransaction: z
      .object({ transactionId: z.string().uuid() })
      .strict()
      .optional(),
  })
  .strict();
const inpaintingColorSampleResultSchema = z
  .object({ color: z.string().min(1).max(40) })
  .strict();
const applyInpaintingHistoryTransactionResultSchema = z
  .object({
    transactionId: z.string().uuid(),
    direction: z.enum(["undo", "redo"]),
    chapters: z.array(ChapterSnapshotSchema).max(MAX_ID_LIST_LENGTH),
    pagesChanged: nonNegativeInteger,
    invalidated: z.boolean(),
  })
  .strict();
const releaseInpaintingHistoryTransactionsResultSchema = z
  .object({ released: nonNegativeInteger })
  .strict();
const pageImageExportResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("completed"),
      outputDir: localPathResult,
      pageCount: nonNegativeInteger,
      openError: diagnosticString.optional(),
    })
    .strict(),
  z.object({ status: z.literal("cancelled") }).strict(),
]);
const pageImageExportPreflightResultSchema = z
  .object({
    workTitle: z.string().min(1).max(300),
    chapterCount: nonNegativeInteger,
    pageCount: nonNegativeInteger,
    sampleRelativePath: z.string().min(1).max(800),
    outputPolicy: z.enum(["new-timestamped-folder", "fixed-folder"]),
    issues: z
      .array(
        z
          .object({
            code: z.enum(PAGE_IMAGE_EXPORT_PREFLIGHT_ISSUE_CODES),
            severity: z.enum(["warning", "info"]),
            chapterId: stringArg,
            chapterTitle: z.string().min(1).max(300),
            pageId: stringArg,
            pageName: z.string().min(1).max(300),
          })
          .strict(),
      )
      .max(MAX_ID_LIST_LENGTH * 4),
    targets: z
      .array(
        z
          .object({
            chapterId: stringArg,
            pageId: stringArg,
            revision: z.string().regex(/^page-v1:[0-9a-f]{16}$/),
          })
          .strict(),
      )
      .max(MAX_ID_LIST_LENGTH),
  })
  .strict();
const disposeInpaintingResultSchema = z
  .object({ disposed: z.boolean() })
  .strict();
const cancelJobResultSchema = z.object({ cancelled: z.boolean() }).strict();

export const translationJobIpcContracts = {
  startAnalysis: defineIpcContract<[StartAnalysisRequest], StartAnalysisResult>(
    {
      apiKey: "startAnalysis",
      channel: "job:start-analysis",
      args: z.tuple([StartAnalysisRequestSchema]),
      result: startAnalysisResultSchema,
    },
  ),
  translateRegion: defineIpcContract<
    [RegionAnalysisRequest],
    RegionAnalysisResult
  >({
    apiKey: "translateRegion",
    channel: "job:translate-region",
    args: z.tuple([RegionAnalysisRequestSchema]),
    result: regionAnalysisResultSchema,
  }),
} as const;

export const inpaintingIpcContracts = {
  startInpainting: defineIpcContract<
    [StartInpaintingRequest],
    StartInpaintingResult
  >({
    apiKey: "startInpainting",
    channel: "job:start-inpainting",
    args: z.tuple([StartInpaintingRequestSchema]),
    result: startInpaintingResultSchema,
  }),
  applyInpaintingRetouch: defineIpcContract<
    [InpaintingRetouchRequest],
    InpaintingRetouchResult
  >({
    apiKey: "applyInpaintingRetouch",
    channel: "inpainting:apply-retouch",
    args: z.tuple([InpaintingRetouchRequestSchema]),
    result: inpaintingRetouchResultSchema,
  }),
  setPageInpaintingResult: defineIpcContract<
    [SetPageInpaintingResultRequest],
    SetPageInpaintingResultResult
  >({
    apiKey: "setPageInpaintingResult",
    channel: "inpainting:set-page-result",
    args: z.tuple([SetPageInpaintingResultRequestSchema]),
    result: inpaintingRetouchResultSchema,
  }),
  revertInpainting: defineIpcContract<
    [InpaintingRevertRequest],
    InpaintingRevertResult
  >({
    apiKey: "revertInpainting",
    channel: "inpainting:revert",
    args: z.tuple([InpaintingRevertRequestSchema]),
    result: inpaintingRevertResultSchema,
  }),
  applyInpaintingHistoryTransaction: defineIpcContract<
    [ApplyInpaintingHistoryTransactionRequest],
    ApplyInpaintingHistoryTransactionResult
  >({
    apiKey: "applyInpaintingHistoryTransaction",
    channel: "inpainting:apply-history-transaction",
    args: z.tuple([ApplyInpaintingHistoryTransactionRequestSchema]),
    result: applyInpaintingHistoryTransactionResultSchema,
  }),
  releaseInpaintingHistoryTransactions: defineIpcContract<
    [ReleaseInpaintingHistoryTransactionsRequest],
    ReleaseInpaintingHistoryTransactionsResult
  >({
    apiKey: "releaseInpaintingHistoryTransactions",
    channel: "inpainting:release-history-transactions",
    args: z.tuple([ReleaseInpaintingHistoryTransactionsRequestSchema]),
    result: releaseInpaintingHistoryTransactionsResultSchema,
  }),
  sampleInpaintingColor: defineIpcContract<
    [InpaintingColorSampleRequest],
    InpaintingColorSampleResult
  >({
    apiKey: "sampleInpaintingColor",
    channel: "inpainting:sample-color",
    args: z.tuple([InpaintingColorSampleRequestSchema]),
    result: inpaintingColorSampleResultSchema,
  }),
  disposeInpaintingEngine: defineIpcContract<[], { disposed: boolean }>({
    apiKey: "disposeInpaintingEngine",
    channel: "inpainting:dispose-engine",
    args: z.tuple([]),
    result: disposeInpaintingResultSchema,
  }),
} as const;

export const pageImageExportIpcContracts = {
  preflightPageImages: defineIpcContract<
    [PageExportSelectionRequest],
    PageImageExportPreflightResult
  >({
    apiKey: "preflightPageImages",
    channel: "page-images:preflight",
    args: z.tuple([PageImageExportPreflightRequestSchema]),
    result: pageImageExportPreflightResultSchema,
  }),
  exportPageImages: defineIpcContract<
    [PageImageExportRequest],
    PageImageExportResult | null
  >({
    apiKey: "exportPageImages",
    channel: "page-images:export",
    args: z.tuple([PageImageExportRequestSchema]),
    result: pageImageExportResultSchema.nullable(),
  }),
  exportPagePsd: defineIpcContract<
    [PagePsdExportRequest],
    PageImageExportResult | null
  >({
    apiKey: "exportPagePsd",
    channel: "page-images:export-psd",
    args: z.tuple([PagePsdExportRequestSchema]),
    result: pageImageExportResultSchema.nullable(),
  }),
} as const;

export const jobControlIpcContracts = {
  cancelJob: defineIpcContract<[], { cancelled: boolean }>({
    apiKey: "cancelJob",
    channel: "job:cancel",
    args: z.tuple([]),
    result: cancelJobResultSchema,
  }),
} as const;
