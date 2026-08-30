import { z } from "zod";
import type { ImportPreviewSession } from "./importTypes";
import {
  defineIpcContract,
  defineIpcEventContract,
  MAX_ID_LIST_LENGTH,
  MAX_PAGES_PER_REQUEST,
  MAX_TITLE_LENGTH,
  nonNegativeInteger,
} from "./ipcContractCore";
import type {
  PrepareWebImportRequest,
  WebImportBooleanResult,
  WebImportProgressEvent,
  WebImportScanRequest,
  WebImportScanResponse,
} from "./webImportTypes";
import { WEB_IMPORT_MAX_STAGED_BYTES } from "./webImportTypes";

const opaqueId = z.string().uuid();
const webUrl = z.string().min(1).max(8_192);

const webImportCandidateSchema = z
  .object({
    id: opaqueId,
    previewUrl: z.string().min(1).max(2_048),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    pixelCount: z.number().int().positive(),
    byteSize: z.number().int().positive().max(WEB_IMPORT_MAX_STAGED_BYTES),
    format: z.enum(["jpeg", "png", "webp"]),
    storedExtension: z.enum([".jpg", ".png"]),
    pageIndex: nonNegativeInteger,
  })
  .strict();

const webImportSkipCountsSchema = z
  .object({
    unsupported: nonNegativeInteger,
    failed: nonNegativeInteger,
    duplicate: nonNegativeInteger,
    blocked: nonNegativeInteger,
  })
  .strict();

const webImportScanResultSchema = z
  .object({
    sessionId: opaqueId,
    pageTitle: z.string().max(MAX_TITLE_LENGTH),
    sourceHost: z.string().min(1).max(253),
    candidates: z.array(webImportCandidateSchema).max(MAX_PAGES_PER_REQUEST),
    skipped: webImportSkipCountsSchema,
    truncated: z.boolean(),
  })
  .strict();

const webImportScanResponseSchema = z.discriminatedUnion("status", [
  z
    .object({ status: z.literal("ready"), result: webImportScanResultSchema })
    .strict(),
  z
    .object({
      status: z.literal("rejected"),
      reason: z.enum([
        "busy",
        "cancelled",
        "invalid-url",
        "private-address",
        "page-unavailable",
        "timed-out",
      ]),
    })
    .strict(),
]);

const importPageDraftSchema = z
  .object({
    name: z.string().min(1).max(260),
    sourcePath: z.string().min(1).max(4_096),
    sourceKind: z.enum(["file", "zip-entry"]),
    zipEntryName: z.string().min(1).max(4_096).optional(),
    storageStem: z
      .string()
      .regex(/^[1-9]\d{0,5}$/)
      .optional(),
  })
  .strict();
const importChapterDraftSchema = z
  .object({
    draftId: z.string().min(1).max(4_096),
    title: z.string().max(MAX_TITLE_LENGTH),
    sourceKind: z.enum(["images", "folder", "zip", "rar", "pdf", "zip-folder"]),
    pages: z.array(importPageDraftSchema).max(MAX_PAGES_PER_REQUEST),
  })
  .strict();
const importPreviewSessionSchema = z
  .object({
    previewId: opaqueId,
    mode: z.enum(["single", "batch"]),
    sourceKind: z.enum(["images", "folder", "zip", "rar", "pdf", "zip-folder"]),
    suggestedWorkTitle: z.string().max(MAX_TITLE_LENGTH),
    chapters: z.array(importChapterDraftSchema).max(MAX_ID_LIST_LENGTH),
  })
  .strict();

const booleanResultSchema = z.object({ completed: z.boolean() }).strict();

const webImportProgressEventSchema = z
  .object({
    requestId: opaqueId,
    stage: z.enum([
      "validating",
      "loading",
      "scrolling",
      "discovering",
      "downloading",
    ]),
    completed: nonNegativeInteger,
    total: nonNegativeInteger,
  })
  .strict();

export const webImportIpcContracts = {
  scanWebImport: defineIpcContract<
    [WebImportScanRequest],
    WebImportScanResponse
  >({
    apiKey: "scanWebImport",
    channel: "web-import:scan",
    args: z.tuple([z.object({ requestId: opaqueId, url: webUrl }).strict()]),
    result: webImportScanResponseSchema,
  }),
  cancelWebImportScan: defineIpcContract<[string], WebImportBooleanResult>({
    apiKey: "cancelWebImportScan",
    channel: "web-import:cancel-scan",
    args: z.tuple([opaqueId]),
    result: booleanResultSchema,
  }),
  discardWebImportSession: defineIpcContract<[string], WebImportBooleanResult>({
    apiKey: "discardWebImportSession",
    channel: "web-import:discard-session",
    args: z.tuple([opaqueId]),
    result: booleanResultSchema,
  }),
  prepareWebImport: defineIpcContract<
    [PrepareWebImportRequest],
    ImportPreviewSession
  >({
    apiKey: "prepareWebImport",
    channel: "web-import:prepare",
    args: z.tuple([
      z
        .object({
          sessionId: opaqueId,
          selectedCandidateIds: z
            .array(opaqueId)
            .min(1)
            .max(MAX_PAGES_PER_REQUEST),
        })
        .strict(),
    ]),
    result: importPreviewSessionSchema,
  }),
  discardImportPreview: defineIpcContract<[string], WebImportBooleanResult>({
    apiKey: "discardImportPreview",
    channel: "import:discard-preview",
    args: z.tuple([opaqueId]),
    result: booleanResultSchema,
  }),
} as const;

export const webImportIpcEventContracts = {
  webImportProgress: defineIpcEventContract<WebImportProgressEvent>({
    eventKey: "webImportProgress",
    channel: "web-import:progress",
    payload: webImportProgressEventSchema,
  }),
} as const;
