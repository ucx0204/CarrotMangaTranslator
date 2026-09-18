import { z } from "zod/v4";
import {
  McpTypographyPreflightInput,
  McpTypographyPreflightOutput,
} from "./mcpTypographyRead";
import { McpSourceSizeObservationSchema } from "./mcpSourceSize";

const id = McpTypographyPreflightInput.shape.chapterId;
const snapshot = z.string().regex(/^[a-f0-9]{16}$/);
const pageRevision = z.string().regex(/^page-v1:[a-f0-9]{16}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const McpTypographyAnalysisTargetSchema =
  McpTypographyPreflightInput.omit({ pageIds: true })
    .extend({
      pages: z
        .array(z.object({ pageId: id, revision: pageRevision }).strict())
        .min(1)
        .max(50),
      snapshot,
      catalogSnapshot: snapshot,
      allowAssetDownloads: z.boolean().default(false),
      requestId: z.string().uuid(),
    })
    .strict();
export type McpTypographyAnalysisTarget = z.infer<
  typeof McpTypographyAnalysisTargetSchema
>;
export const McpTypographyFontChoiceSchema = z
  .object({
    fontId: id,
    fontWeight: z.union([z.literal(400), z.literal(700)]),
    italic: z.literal(false),
    runtimeVersion: z.literal("c23.0"),
    groupId: z.string().min(1).max(256),
  })
  .strict();
const item = z
  .object({
    blockId: id,
    font: McpTypographyFontChoiceSchema.nullable(),
    estimate: McpSourceSizeObservationSchema.shape.items.element.shape.estimate,
    fontExclusion: z.string().max(200).nullable(),
    sizeExclusion: z.string().max(200).nullable(),
  })
  .strict();
export const McpTypographyAnalysisPagesSchema = z
  .array(
    z
      .object({
        pageId: id,
        revision: pageRevision,
        sourceImageSha256: digest,
        items: z.array(item).max(1000),
      })
      .strict(),
  )
  .min(1)
  .max(50);
export const McpTypographyAnalysisObservationSchema = z
  .object({
    expiresAt: z.number().int().nonnegative(),
    workId: id,
    membership: snapshot,
    contextRevision: snapshot,
    inputSnapshot: snapshot,
    catalogSnapshot: snapshot,
    environmentSnapshot: snapshot,
    mode: McpTypographyPreflightInput.shape.mode,
    sourceLanguage: z.string().min(2).max(32),
    targetLanguage: z.string().min(2).max(32),
    preserveManualFontSize: z.boolean(),
    pages: McpTypographyAnalysisPagesSchema,
    notes: z.array(z.string().max(250)).max(16),
  })
  .strict();
export type McpTypographyAnalysisObservation = z.infer<
  typeof McpTypographyAnalysisObservationSchema
>;
export type McpTypographyPreparedPage = z.infer<
  typeof McpTypographyPreflightOutput
>["pages"][number];
