import { z } from "zod";
import { coerceOpenAiCompatibleBaseUrl } from "./apiSettings";
import {
  isValidPerspectiveTransform,
  MAX_BLOCK_LOCAL_COORDINATE,
  MAX_CURVE_OFFSET_EM,
  MIN_BLOCK_LOCAL_COORDINATE,
  MIN_CURVE_OFFSET_EM,
  validateQuadraticPath,
} from "./blockTransforms";
import { WarpTransformSchema } from "./warpTransformSchema";
import {
  MAX_MAX_TOKENS,
  MIN_CONTEXT_TOKENS,
  MIN_MAX_TOKENS,
} from "./modelPresets";
import { TEXT_WORD_BREAK_VALUES } from "./textWrapping";
import {
  MAX_BUBBLE_LAYOUT_INSET_RATIO,
  MAX_BUBBLE_LAYOUT_METADATA_LENGTH,
  MAX_BUBBLE_LAYOUT_REGIONS,
  MAX_BUBBLE_REGION_SPANS,
} from "./bubbleLayout";
import { FONT_MATCHING_SEMANTIC_ROLES } from "./fontMatchingProfileTypes";
import { normalizeVisualClusterId } from "./visualClusterId";
import { RenderBBoxSchema } from "./renderBboxSchema";
import * as blockFormatValueSchemas from "./blockFormatValueSchemas";
import {
  resolveAutomaticTextOutlineColor,
  resolveEffectiveTextOutlineWidthPx,
} from "./textOutline";
import type { BBox } from "./textTypes";
import { TextEffectSchema } from "./textEffect";

export { MAX_MAX_TOKENS, MIN_CONTEXT_TOKENS, MIN_MAX_TOKENS };
export { TextEffectSchema };

const MAX_TITLE_LENGTH = 240;
const MAX_TEXT_LENGTH = 20000;
const MAX_PATH_LENGTH = 4096;
export const MAX_ID_LIST_LENGTH = 2000;
export const MAX_PAGES_PER_REQUEST = 2000;
export const MAX_IMAGE_DIMENSION = 100_000;
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
export const visualClusterId = z.preprocess(
  normalizeVisualClusterId,
  z.string(),
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

const BlockLocalPointSchema = z
  .object({
    x: finiteNumber
      .min(MIN_BLOCK_LOCAL_COORDINATE)
      .max(MAX_BLOCK_LOCAL_COORDINATE),
    y: finiteNumber
      .min(MIN_BLOCK_LOCAL_COORDINATE)
      .max(MAX_BLOCK_LOCAL_COORDINATE),
  })
  .strict();

const PerspectiveTransformSchema = z
  .object({
    version: z.literal(1),
    corners: z.tuple([
      BlockLocalPointSchema,
      BlockLocalPointSchema,
      BlockLocalPointSchema,
      BlockLocalPointSchema,
    ]),
  })
  .strict()
  .refine((transform) => isValidPerspectiveTransform(transform), {
    message: "invalid or unsafe perspective transform",
  });

const QuadraticCurvePathSchema = z
  .object({
    type: z.literal("quadratic"),
    start: BlockLocalPointSchema,
    control: BlockLocalPointSchema,
    end: BlockLocalPointSchema,
  })
  .strict()
  .refine((path) => validateQuadraticPath(path).valid, {
    message: "invalid or unsafe curve path",
  });

const CurveLayoutSchema = z
  .object({
    version: z.literal(1),
    path: QuadraticCurvePathSchema,
    alignment: z.enum(["start", "center", "end"]),
    offsetEm: finiteNumber.min(MIN_CURVE_OFFSET_EM).max(MAX_CURVE_OFFSET_EM),
    orientation: z.enum(["tangent", "upright"]),
    reversed: z.boolean().optional(),
    fitSpacing: z.boolean().optional(),
  })
  .strict();

const BubbleShapeSpanSchema = z
  .object({
    blockStart: finiteNumber.min(0).max(1),
    blockEnd: finiteNumber.min(0).max(1),
    inlineStart: finiteNumber.min(0).max(1),
    inlineEnd: finiteNumber.min(0).max(1),
  })
  .strict()
  .superRefine((span, context) => {
    if (span.blockStart >= span.blockEnd) {
      context.addIssue({
        code: "custom",
        message: "blockStart must be less than blockEnd",
        path: ["blockEnd"],
      });
    }
    if (span.inlineStart >= span.inlineEnd) {
      context.addIssue({
        code: "custom",
        message: "inlineStart must be less than inlineEnd",
        path: ["inlineEnd"],
      });
    }
  });

const BubbleShapeRegionSchema = z
  .object({
    spans: z.array(BubbleShapeSpanSchema).min(1).max(MAX_BUBBLE_REGION_SPANS),
  })
  .strict()
  .superRefine((region, context) => {
    for (let index = 1; index < region.spans.length; index += 1) {
      const previous = region.spans[index - 1];
      const current = region.spans[index];
      if (current.blockStart < previous.blockEnd) {
        context.addIssue({
          code: "custom",
          message:
            "spans must be ordered and non-overlapping on the block axis",
          path: ["spans", index, "blockStart"],
        });
      }
    }
  });

export const BubbleLayoutSchema = z
  .object({
    version: z.literal(1),
    direction: z.enum(["horizontal", "vertical"]),
    confidence: finiteNumber.min(0).max(1),
    origin: z.enum(["detected", "manual"]).optional(),
    modelId: z
      .string()
      .min(1)
      .max(MAX_BUBBLE_LAYOUT_METADATA_LENGTH)
      .optional(),
    sourceImageRevision: z
      .string()
      .min(1)
      .max(MAX_BUBBLE_LAYOUT_METADATA_LENGTH)
      .optional(),
    insetRatio: finiteNumber.min(0).max(MAX_BUBBLE_LAYOUT_INSET_RATIO),
    regions: z
      .array(BubbleShapeRegionSchema)
      .min(1)
      .max(MAX_BUBBLE_LAYOUT_REGIONS),
  })
  .strict()
  .superRefine((layout, context) => {
    if (
      layout.origin === "detected" &&
      (!layout.modelId || !layout.sourceImageRevision)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "detected bubble layouts require modelId and sourceImageRevision",
        path: !layout.modelId ? ["modelId"] : ["sourceImageRevision"],
      });
    }
    if (
      layout.origin === "manual" &&
      layout.sourceImageRevision !== undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "manual bubble layouts cannot have sourceImageRevision",
        path: ["sourceImageRevision"],
      });
    }
  });

export const TranslationBlockObjectSchema = z
  .object({
    id: z.string().min(1).max(200),
    type: z.preprocess(() => "nonsolid", z.literal("nonsolid")),
    bbox: BBoxSchema,
    renderBbox: RenderBBoxSchema.optional(),
    bboxSpace: z.enum(["normalized_1000", "pixels"]).optional(),
    renderBboxSpace: z.enum(["normalized_1000", "pixels"]).optional(),
    bubbleLayout: BubbleLayoutSchema.optional(),
    sourceText: boundedText,
    translatedText: boundedText,
    textRole: z.enum(["ordinary", "sound"]).optional(),
    fontRole: z.enum(FONT_MATCHING_SEMANTIC_ROLES).optional(),
    fontRoleConfidence: finiteNumber.min(0).max(1).optional(),
    visualClusterId: visualClusterId.optional(),
    confidence: finiteNumber.min(0).max(1),
    sourceDirection: z.enum(["horizontal", "vertical"]),
    renderDirection: LegacyRenderDirectionSchema,
    rotationDeg: finiteNumber.min(-180).max(180).optional(),
    perspectiveTransform: PerspectiveTransformSchema.optional(),
    curveLayout: CurveLayoutSchema.optional(),
    warpTransform: WarpTransformSchema.optional(),
    fontFamily: z.string().max(120).optional(),
    /** Removed in v1.16; accepted only so older projects can be migrated. */
    automaticFontMatch: z.unknown().optional(),
    fontSizePx: blockFormatValueSchemas.FontSizePxSchema,
    lineHeight: blockFormatValueSchemas.LineHeightSchema,
    letterSpacing: blockFormatValueSchemas.LetterSpacingSchema.optional(),
    fontWidthScale: blockFormatValueSchemas.FontWidthScaleSchema.optional(),
    wordBreak: z.enum(TEXT_WORD_BREAK_VALUES).optional(),
    textAlign: z.enum(["left", "center", "right"]),
    textColor: hexColor,
    textOpacity: finiteNumber.min(0).max(1).optional(),
    outlineColor: hexColor.optional(),
    outlineWidthPx: finiteNumber.min(0).max(64).optional(),
    outlineWidthScale: finiteNumber.min(0).max(8).optional(),
    textEffect: TextEffectSchema.optional(),
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

export const TranslationBlockSchema = TranslationBlockObjectSchema.transform(
  ({ automaticFontMatch, ...block }) => {
    if (
      !isLegacyAutomaticFontMatch(automaticFontMatch) ||
      resolveEffectiveTextOutlineWidthPx(block, block.fontSizePx) <= 0
    ) {
      return block;
    }
    return {
      ...block,
      outlineColor: resolveAutomaticTextOutlineColor(block),
    };
  },
);

function isLegacyAutomaticFontMatch(value: unknown): boolean {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { schemaVersion?: unknown }).schemaVersion === 1,
  );
}

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

function clampNormalizedBbox(bbox: BBox): BBox {
  const x = Math.min(999, Math.max(0, bbox.x));
  const y = Math.min(999, Math.max(0, bbox.y));
  const w = Math.min(1000 - x, Math.max(1, bbox.w));
  const h = Math.min(1000 - y, Math.max(1, bbox.h));
  return { x, y, w, h };
}
