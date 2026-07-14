import { z } from "zod";
import { coerceOpenAiCompatibleBaseUrl } from "./apiSettings";
import {
  MAX_MAX_TOKENS,
  MIN_CONTEXT_TOKENS,
  MIN_MAX_TOKENS,
} from "./modelPresets";

export { MAX_MAX_TOKENS, MIN_CONTEXT_TOKENS, MIN_MAX_TOKENS };

const MAX_TITLE_LENGTH = 240;
const MAX_TEXT_LENGTH = 20000;
const MAX_PATH_LENGTH = 4096;
export const MAX_ID_LIST_LENGTH = 2000;
export const MAX_PAGES_PER_REQUEST = 2000;
export const MAX_BLOCKS_PER_PAGE = 500;
export const MAX_MASK_STROKES = 200;
export const MAX_STROKE_POINTS = 1200;
export const MAX_RETAINED_INPAINTING_ARTIFACTS = 200;
export const MAX_GATHERED_TEXT_LENGTH = 5_000_000;
export const MAX_GLOSSARY_ENTRIES = 1000;
export const MAX_CHARACTER_PROFILES = 300;
export const MAX_STORY_MEMORY_PAGES = 2000;

export const finiteNumber = z.number().finite();
export const uuid = z.string().uuid();
export const storeId = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (value) =>
      value !== "." &&
      value !== ".." &&
      !value.includes("/") &&
      !value.includes("\\"),
    "invalid store id",
  );
export const title = z.string().max(MAX_TITLE_LENGTH);
export const filePath = z.string().min(1).max(MAX_PATH_LENGTH);
const boundedText = z.string().max(MAX_TEXT_LENGTH);
export const hexColor = z.string().regex(/^#[0-9a-f]{6}$/i);

const ReviewStatusSchema = z.enum(["draft", "needs_review", "reviewed"]);

const LegacyRenderDirectionSchema = z.preprocess(
  (value) => {
    const normalized = String(value ?? "")
      .trim()
      .toLowerCase();
    if (normalized === "vertical") {
      return "vertical";
    }
    if (
      normalized === "horizontal" ||
      normalized === "rotated" ||
      normalized === "hidden"
    ) {
      return "horizontal";
    }
    return value;
  },
  z.enum(["horizontal", "vertical"]),
);

export {
  GemmaVramModeSchema,
  LlamaRuntimeProfileSchema,
  AmdRocmTargetSchema,
  FluxBackendSchema,
  InpaintingModelSchema,
  KoharuInpaintingBackendSchema,
  OcrGpuBackendSchema,
  OcrQualityModeSchema,
} from "./ipcEnumSchemas";

export const OpenAiCompatibleBaseUrlSchema = z.preprocess(
  (value) => coerceOpenAiCompatibleBaseUrl(value) ?? value,
  z
    .string()
    .min(1)
    .max(1000)
    .refine(
      (value) => coerceOpenAiCompatibleBaseUrl(value) !== null,
      "invalid API base URL",
    ),
);

export const ApiReasoningEffortSchema = z.enum([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

export const JsonObjectStringSchema = z
  .string()
  .max(MAX_TEXT_LENGTH)
  .refine((value) => !value.trim() || isJsonObjectString(value), {
    message: "must be a JSON object string",
  });

export const CustomHeadersJsonObjectStringSchema = z
  .string()
  .max(MAX_TEXT_LENGTH)
  .refine((value) => !value.trim() || isValidCustomHeadersJson(value), {
    message:
      "must be a JSON object with string, number, or boolean header values",
  });

export const BBoxSchema = z
  .object({
    x: finiteNumber.min(0).max(1000),
    y: finiteNumber.min(0).max(1000),
    w: finiteNumber.min(0).max(1000),
    h: finiteNumber.min(0).max(1000),
  })
  .strict()
  .transform((bbox) => clampNormalizedBbox(bbox));

export const TranslationBlockSchema = z
  .object({
    id: z.string().min(1).max(200),
    type: z.preprocess(() => "nonsolid", z.literal("nonsolid")),
    bbox: BBoxSchema,
    renderBbox: BBoxSchema.optional(),
    bboxSpace: z.enum(["normalized_1000", "pixels"]).optional(),
    renderBboxSpace: z.enum(["normalized_1000", "pixels"]).optional(),
    sourceText: boundedText,
    translatedText: boundedText,
    confidence: finiteNumber.min(0).max(1),
    sourceDirection: z.enum(["horizontal", "vertical"]),
    renderDirection: LegacyRenderDirectionSchema,
    rotationDeg: finiteNumber.min(-30).max(30).optional(),
    fontFamily: z.string().max(120).optional(),
    fontSizePx: finiteNumber.min(1).max(512),
    lineHeight: finiteNumber.min(0.5).max(4),
    letterSpacing: finiteNumber.min(-0.5).max(2).optional(),
    fontWidthScale: finiteNumber.min(0.5).max(1.5).optional(),
    textAlign: z.enum(["left", "center", "right"]),
    textColor: hexColor,
    textOpacity: finiteNumber.min(0).max(1).optional(),
    outlineColor: hexColor.optional(),
    outlineWidthScale: finiteNumber.min(0).max(8).optional(),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    backgroundColor: hexColor,
    opacity: finiteNumber.min(0).max(1),
    autoFitText: z.boolean().optional(),
    inpaintExcluded: z.boolean().optional(),
    reviewStatus: ReviewStatusSchema.optional(),
    reviewNote: z.string().max(4000).optional(),
    speakerId: z.string().max(200).optional(),
    glossaryEntryIds: z.array(z.string().max(200)).max(50).optional(),
  })
  .strict();

function isJsonObjectString(value: string): boolean {
  try {
    const parsed = JSON.parse(value);
    return Boolean(
      parsed && typeof parsed === "object" && !Array.isArray(parsed),
    );
  } catch (_error) {
    return false;
  }
}

function isValidCustomHeadersJson(value: string): boolean {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return false;
    }
    return Object.entries(parsed).every(([key, headerValue]) => {
      if (isForbiddenCustomHeader(key)) {
        return false;
      }
      return (
        typeof headerValue === "string" ||
        typeof headerValue === "number" ||
        typeof headerValue === "boolean"
      );
    });
  } catch (_error) {
    return false;
  }
}

function isForbiddenCustomHeader(name: string): boolean {
  return [
    "authorization",
    "content-type",
    "host",
    "content-length",
    "cookie",
    "set-cookie",
  ].includes(name.trim().toLowerCase());
}

function clampNormalizedBbox(bbox: {
  x: number;
  y: number;
  w: number;
  h: number;
}): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
  const x = Math.min(999, Math.max(0, bbox.x));
  const y = Math.min(999, Math.max(0, bbox.y));
  const w = Math.min(1000 - x, Math.max(1, bbox.w));
  const h = Math.min(1000 - y, Math.max(1, bbox.h));
  return { x, y, w, h };
}
