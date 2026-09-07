import { codexPageMemorySchema } from "./codexTypesettingMemorySchema";
import { z } from "zod/v4";
import type { BBox } from "../../shared/textTypes";
import { WARP_PRESET_NAMES } from "../../shared/warpTransformMath";
import {
  MAX_FONT_SIZE_PX,
  FONT_SIZE_STEP_PX,
} from "../../shared/blockFormatValues";
import type {
  CodexPageReading,
  CodexSourceFontGroup,
} from "../../shared/codexTypesettingTypes";

const bbox = z
  .object({
    x: z.number().finite().min(0).max(1000),
    y: z.number().finite().min(0).max(1000),
    w: z.number().finite().positive().max(1000),
    h: z.number().finite().positive().max(1000),
  })
  .strict()
  .refine(
    (box) => box.x + box.w <= 1000.01 && box.y + box.h <= 1000.01,
    "Region leaves page.",
  );

const pageReadingSchema = z
  .object({
    ownedReadability: z.enum(["readable", "partial", "unreadable"]),
    contextReadability: z.enum(["readable", "clipped", "absent"]),
    readabilityReason: z.string().max(1200),
    unreadableRegions: z
      .array(
        z
          .object({
            id: z.string().min(1).max(150),
            sourceBbox: bbox,
            reason: z.string().min(1).max(1200),
          })
          .strict(),
      )
      .max(400),
    summary: z.string().max(12000),
    memory: codexPageMemorySchema,
    regions: z
      .array(
        z
          .object({
            id: z.string().min(1).max(150),
            action: z.enum(["keep", "text", "image"]),
            occlusionPolygons: z
              .array(
                z
                  .array(
                    z
                      .object({
                        x: z.number().finite().min(0).max(1000),
                        y: z.number().finite().min(0).max(1000),
                      })
                      .strict(),
                  )
                  .min(3)
                  .max(128),
              )
              .max(64)
              .optional(),
            sourceText: z.string().max(6000),
            translatedText: z.string().max(6000),
            sourceBbox: bbox,
            renderBbox: bbox,
            role: z.enum(["ordinary", "sound"]),
            direction: z.enum(["horizontal", "vertical"]),
            background: z.enum(["white", "black", "artwork"]),
            reason: z.string().max(1200),
          })
          .strict(),
      )
      .max(400),
  })
  .strict();

export const erasurePlansSchema = z
  .object({
    regions: z
      .array(
        z
          .object({
            regionId: z.string(),
            erasePolygons: z
              .array(
                z
                  .array(
                    z
                      .object({
                        x: z.number().finite().min(0).max(1000),
                        y: z.number().finite().min(0).max(1000),
                      })
                      .strict(),
                  )
                  .min(3)
                  .max(256)
                  .describe(
                    "A closed source contour with 3–256 vertices. Trace lettering and its outline, including complex brush strokes; do not replace disconnected glyphs with one bounding rectangle.",
                  ),
              )
              .max(64),
            background: z.enum(["white", "black", "artwork"]),
            reason: z.string().max(1200),
          })
          .strict(),
      )
      .max(400),
  })
  .strict();

export const erasureCommitSchema = z
  .object({
    revision: z.number().int().min(1).max(3),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    unresolvedRegionIds: z.array(z.string()).max(400),
  })
  .strict();

export const fontGroupsSchema = z
  .object({
    groups: z
      .array(
        z
          .object({
            id: z.string().min(1),
            description: z.string().max(2000),
            members: z
              .array(
                z
                  .object({
                    regionId: z.string(),
                    bold: z.boolean(),
                    italic: z.boolean(),
                  })
                  .strict(),
              )
              .min(1),
          })
          .strict(),
      )
      .max(1000),
  })
  .strict();

export const fontAssignmentsSchema = z
  .object({
    fonts: z.array(
      z
        .object({
          groupId: z.string(),
          fontId: z.string(),
        })
        .strict(),
    ),
  })
  .strict();

function inheritedStyle<T extends z.ZodType>(schema: T) {
  return schema.nullish().transform((value) => value ?? undefined);
}

export const layoutsSchema = z
  .object({
    layouts: z.array(
      z
        .object({
          regionId: z.string(),
          translatedText: z.string().max(6000),
          action: inheritedStyle(z.enum(["text", "image"])),
          bold: inheritedStyle(z.boolean()),
          italic: inheritedStyle(z.boolean()),
          runs: inheritedStyle(
            z
              .array(
                z
                  .object({
                    text: z.string().max(6000),
                    bold: z.boolean(),
                    italic: z.boolean(),
                    sizePx: inheritedStyle(
                      z
                        .number()
                        .finite()
                        .min(1)
                        .max(MAX_FONT_SIZE_PX)
                        .multipleOf(FONT_SIZE_STEP_PX),
                    ),
                    color: inheritedStyle(z.string().regex(/^#[\da-f]{6}$/i)),
                  })
                  .strict(),
              )
              .max(64),
          ),
          renderBbox: bbox,
          fontSizePx: z.number().finite().min(1).max(1000),
          lineHeight: z.number().min(0.5).max(3),
          rotationDeg: z.number().min(-180).max(180),
          outlineWidthPx: z.number().min(0).max(100),
          textColor: z.string().regex(/^#[\da-f]{6}$/i),
          outlineColor: z.string().regex(/^#[\da-f]{6}$/i),
          textAlign: z.enum(["left", "center", "right"]),
          direction: z.enum(["horizontal", "vertical"]),
          warpPreset: z.enum(["none", ...WARP_PRESET_NAMES]).default("none"),
          curvePreset: z.enum(["none", "archUp", "archDown"]).default("none"),
        })
        .strict(),
    ),
  })
  .strict();

export const reviewSchema = z
  .object({
    issues: z.array(
      z
        .object({
          regionId: z.string(),
          reason: z.string().min(1).max(2000),
          kind: z.enum(["text", "background", "image"]),
        })
        .strict(),
    ),
  })
  .strict();

export const letteringReadbackSchema = z
  .object({
    regions: z
      .array(
        z.object({ regionId: z.string(), text: z.string().max(6000) }).strict(),
      )
      .max(400),
  })
  .strict();

export const backgroundReviewSchema = z
  .object({
    revision: erasureCommitSchema.shape.revision,
    sha256: erasureCommitSchema.shape.sha256,
    issues: z
      .array(
        z
          .object({
            regionId: z.string(),
            kind: z.literal("background"),
            reason: z.string().min(1).max(2000),
          })
          .strict(),
      )
      .max(400),
    corrections: erasurePlansSchema.shape.regions,
  })
  .strict();

export function typesettingOutputSchema(
  stage: string,
): Record<string, unknown> {
  const schema = stage.startsWith("background-")
    ? backgroundReviewSchema
    : stage.startsWith("erase-")
      ? stage === "erase-preview"
        ? erasurePlansSchema
        : erasureCommitSchema
      : stage.startsWith("readback-")
        ? letteringReadbackSchema
        : stage.startsWith("read-")
          ? pageReadingSchema
          : stage === "source-families"
            ? fontGroupsSchema
            : stage === "font-assignment"
              ? fontAssignmentsSchema
              : stage.startsWith("layout-")
                ? layoutsSchema
                : stage.startsWith("review-")
                  ? reviewSchema
                  : undefined;
  if (!schema) throw new Error(`Unknown typesetting stage: ${stage}`);
  const result = z.toJSONSchema(schema, { target: "draft-7", io: "input" });
  requireOutputProperties(result);
  return result;
}

/** The wire requires every property; explicit null represents inherited style. */
function requireOutputProperties(value: unknown): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach(requireOutputProperties);
    return;
  }
  const schema = value as Record<string, unknown>;
  if (
    schema.type === "object" &&
    schema.properties &&
    typeof schema.properties === "object"
  )
    schema.required = Object.keys(schema.properties);
  Object.values(schema).forEach(requireOutputProperties);
}

export function qualifyJapaneseReading(
  value: unknown,
  pageId: string,
  ownedBox: BBox = { x: 0, y: 0, w: 1000, h: 1000 },
): CodexPageReading {
  const reading = pageReadingSchema.parse(value);
  if (reading.ownedReadability === "unreadable")
    throw new Error(
      `원문 판독 불가: ${reading.readabilityReason || reading.summary}`,
    );
  if (
    (reading.ownedReadability === "partial") !==
    reading.unreadableRegions.length > 0
  )
    throw new Error("부분 판독 상태와 보존할 영역이 일치하지 않습니다.");
  for (const { sourceBbox: box } of reading.unreadableRegions) {
    const x = box.x + box.w / 2,
      y = box.y + box.h / 2;
    if (
      x < ownedBox.x ||
      y < ownedBox.y ||
      x >= ownedBox.x + ownedBox.w ||
      y >= ownedBox.y + ownedBox.h
    )
      throw new Error("판독 불가 영역의 중심이 담당 범위 밖입니다.");
  }
  const ids = [...reading.regions, ...reading.unreadableRegions].map(
    (region) => region.id,
  );
  if (new Set(ids).size !== ids.length) throw new Error("重複 region IDs");
  return {
    ...(reading.memory ? { memory: reading.memory } : {}),
    ...reading,
    regions: [
      ...reading.regions.map((region) => ({
        ...region,
        id: `${pageId}:${region.id}`,
        action:
          /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(
            region.sourceText,
          ) && !/\p{Script=Hangul}/u.test(region.sourceText)
            ? region.action
            : ("keep" as const),
      })),
      ...reading.unreadableRegions.map((region) => ({
        id: `${pageId}:${region.id}`,
        action: "keep" as const,
        sourceText: "",
        translatedText: "",
        sourceBbox: region.sourceBbox,
        renderBbox: region.sourceBbox,
        role: "ordinary" as const,
        direction: "horizontal" as const,
        background: "artwork" as const,
        reason: region.reason,
        preserveReason: region.reason,
      })),
    ],
  };
}

export function assertExactMembership(
  expected: readonly string[],
  actual: readonly string[],
  label: string,
): void {
  const target = new Set(expected);
  if (
    target.size !== expected.length ||
    actual.length !== target.size ||
    new Set(actual).size !== actual.length ||
    actual.some((id) => !target.has(id))
  ) {
    throw new Error(
      `${label}: IDs must cover each requested region exactly once.`,
    );
  }
}

export function validateFontGroups(
  groups: CodexSourceFontGroup[],
  regionIds: string[],
): void {
  assertExactMembership(
    regionIds,
    groups.flatMap((group) => group.members.map((member) => member.regionId)),
    "Source families",
  );
  if (new Set(groups.map((group) => group.id)).size !== groups.length)
    throw new Error("Duplicate font groups.");
}
