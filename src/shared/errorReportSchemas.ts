import { z } from "zod";
import {
  ERROR_REPORT_LOG_MAX_BYTES,
  ERROR_REPORT_MAX_BYTES,
  type CopyErrorReportResult,
  type ErrorReportContext,
  type ErrorReportDraft,
  type ErrorReportSource,
  type OpenErrorReportIssueRequest,
  type OpenErrorReportIssueResult,
  type RestartAppResult,
} from "./errorReportTypes";

const errorReportSourceSchema: z.ZodType<ErrorReportSource> = z.enum([
  "manual",
  "job-failure",
  "react-boundary",
  "renderer-global",
  "main-process",
  "renderer-process",
]);

const boundedOptionalText = (maxLength: number) =>
  z.string().max(maxLength).optional();

export const ErrorReportContextSchema: z.ZodType<ErrorReportContext> = z
  .object({
    source: errorReportSourceSchema,
    summary: boundedOptionalText(1000),
    message: boundedOptionalText(16000),
    stack: boundedOptionalText(32000),
    componentStack: boundedOptionalText(32000),
    jobStage: boundedOptionalText(500),
  })
  .strict();

const reportTextBaseSchema = z.string().max(ERROR_REPORT_MAX_BYTES);
const reportTextSchema = reportTextBaseSchema.refine(
  (value) => utf8ByteLength(value) <= ERROR_REPORT_MAX_BYTES,
  "Error report section exceeds the maximum byte length",
);

const reportLogTextSchema = z
  .string()
  .max(ERROR_REPORT_LOG_MAX_BYTES)
  .refine(
    (value) => utf8ByteLength(value) <= ERROR_REPORT_LOG_MAX_BYTES,
    "Error report log section exceeds the maximum byte length",
  );

export const ErrorReportDraftSchema: z.ZodType<ErrorReportDraft> = z
  .object({
    defaultTitle: z.string().min(1).max(240),
    errorMarkdown: reportTextSchema,
    systemMarkdown: reportTextSchema,
    logsMarkdown: reportLogTextSchema,
    redactionCount: z.number().int().min(0),
    truncated: z.boolean(),
  })
  .strict()
  .refine(
    (draft) =>
      utf8ByteLength(
        `${draft.errorMarkdown}${draft.systemMarkdown}${draft.logsMarkdown}`,
      ) <= ERROR_REPORT_MAX_BYTES,
    "Combined error report exceeds the maximum byte length",
  );

export const CopyErrorReportBodySchema = reportTextBaseSchema
  .min(1)
  .refine(
    (value) => utf8ByteLength(value) <= ERROR_REPORT_MAX_BYTES,
    "Error report section exceeds the maximum byte length",
  );

export const CopyErrorReportResultSchema: z.ZodType<CopyErrorReportResult> = z
  .object({ copied: z.boolean() })
  .strict();

export const OpenErrorReportIssueRequestSchema: z.ZodType<OpenErrorReportIssueRequest> =
  z
    .object({
      title: z.string().trim().min(1).max(240),
      body: CopyErrorReportBodySchema,
    })
    .strict();

export const OpenErrorReportIssueResultSchema: z.ZodType<OpenErrorReportIssueResult> =
  z
    .object({
      opened: z.boolean(),
      mode: z.enum(["prefilled", "clipboard"]),
    })
    .strict();

export const RestartAppResultSchema: z.ZodType<RestartAppResult> = z
  .object({ restarting: z.boolean() })
  .strict();

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
