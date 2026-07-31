import { z } from "zod";
import type {
  FontMatchDecisionEvidenceV2,
  FontMatchingPaletteRole,
  FontMatchingSemanticRole,
  TypographyAnchorV2,
  WorkTypographyProfileV2,
  WorkTypographyUserLockV2,
} from "./fontMatchingProfileTypes";
import {
  FONT_MATCHING_PALETTE_ROLES,
  FONT_MATCHING_SEMANTIC_ROLES,
  FONT_MATCHING_SOURCE_STYLE_AXES,
} from "./fontMatchingProfileTypes";
import {
  FontMatchingPaletteRoleSchema,
  FontMatchingSemanticRoleSchema,
  WorkTypographyProfileV2Schema,
} from "./fontMatchingProfileSchemas";
import { FontMatchDecisionEvidenceV2Schema } from "./fontMatchingEvidenceSchemas";
import { finiteNumber, storeId } from "./ipcSchemaPrimitives";

const timestamp = z.string().datetime({ offset: true });
const fontId = z.string().trim().min(1).max(200);
const versionId = z.string().trim().min(1).max(200);
const probability = finiteNumber.min(0).max(1);

const WorkTypographyProfileV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    workId: storeId,
    dialogueAnchorFontId: fontId.nullable(),
    narrationAnchorFontId: fontId.nullable().optional(),
    thoughtAnchorFontId: fontId.nullable().optional(),
    rolePalettes: z
      .array(
        z
          .object({
            role: FontMatchingPaletteRoleSchema,
            fontIds: z.array(fontId).min(2).max(4),
          })
          .strict(),
      )
      .max(FONT_MATCHING_PALETTE_ROLES.length)
      .optional(),
    userRoleLocks: z
      .array(
        z.object({ role: FontMatchingSemanticRoleSchema, fontId }).strict(),
      )
      .max(FONT_MATCHING_SEMANTIC_ROLES.length)
      .optional(),
    evidenceCount: z.number().int().min(0).max(10_000_000),
    confidence: probability,
    catalogVersion: versionId,
    modelVersion: versionId,
    rendererHash: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();

export function validateWorkTypographyProfileV2(
  payload: unknown,
): WorkTypographyProfileV2 {
  return parseSchema(
    WorkTypographyProfileV2Schema,
    payload,
    "WorkTypographyProfileV2",
  );
}

export function migrateWorkTypographyProfile(
  payload: unknown,
): WorkTypographyProfileV2 {
  const version = readSchemaVersion(payload);
  if (version === 2) {
    return normalizeWorkTypographyProfileV2(
      validateWorkTypographyProfileV2(payload),
    );
  }
  if (version !== 1) {
    throw new Error(
      `지원하지 않는 작품 글꼴 프로필 버전입니다: ${String(version)}`,
    );
  }
  const legacy = parseSchema(
    WorkTypographyProfileV1Schema,
    payload,
    "WorkTypographyProfileV1",
  );
  return normalizeWorkTypographyProfileV2({
    schemaVersion: 2,
    workId: legacy.workId,
    dialogueAnchor: migrateAnchor(
      legacy.dialogueAnchorFontId,
      legacy.evidenceCount,
      legacy.confidence,
      legacy.updatedAt,
    ),
    narrationAnchor: migrateAnchor(
      legacy.narrationAnchorFontId ?? null,
      legacy.evidenceCount,
      legacy.confidence,
      legacy.updatedAt,
    ),
    thoughtAnchor: migrateAnchor(
      legacy.thoughtAnchorFontId ?? null,
      legacy.evidenceCount,
      legacy.confidence,
      legacy.updatedAt,
    ),
    rolePalettes: (legacy.rolePalettes ?? []).map((palette) => ({
      role: palette.role,
      allowedFontIds: palette.fontIds,
      maxDistinctFonts: palette.fontIds.length,
      reuseVisualClusterFont: true,
      evidenceCount: legacy.evidenceCount,
      confidence: legacy.confidence,
    })),
    intentionalOverrides: [],
    userLocks: (legacy.userRoleLocks ?? []).map((lock, index) => ({
      id: `migrated-role-${index + 1}-${lock.role}`,
      scope: { type: "role", role: lock.role },
      selection: { fontId: lock.fontId },
      createdAt: legacy.createdAt,
      updatedAt: legacy.updatedAt,
    })),
    orientationPolicy: {
      horizontalAllowedFontIds: null,
      verticalAllowedFontIds: null,
      verticalOnlyFontIds: ["seoul-namsan-vertical"],
    },
    consistencyPolicy: {
      reuseBodyAnchors: true,
      requireIntentionalOverrideForBodySwitch: true,
      reuseVisualClusterFont: true,
      maxAccentFontsPerRole: 4,
    },
    genrePrior: null,
    evidenceCount: legacy.evidenceCount,
    confidence: legacy.confidence,
    catalogVersion: legacy.catalogVersion,
    modelVersion: legacy.modelVersion,
    rendererHash: legacy.rendererHash,
    createdAt: legacy.createdAt,
    updatedAt: legacy.updatedAt,
  });
}

export function serializeWorkTypographyProfileV2(
  profile: WorkTypographyProfileV2,
): string {
  return `${JSON.stringify(normalizeWorkTypographyProfileV2(profile), null, 2)}\n`;
}

export function validateFontMatchDecisionEvidenceV2(
  payload: unknown,
): FontMatchDecisionEvidenceV2 {
  return parseSchema(
    FontMatchDecisionEvidenceV2Schema,
    payload,
    "FontMatchDecisionEvidenceV2",
  );
}

export function serializeFontMatchDecisionEvidenceV2(
  evidence: FontMatchDecisionEvidenceV2,
): string {
  const checked = validateFontMatchDecisionEvidenceV2(evidence);
  const canonical = {
    ...checked,
    role: {
      ...checked.role,
      alternatives: [...checked.role.alternatives].sort(compareRolePredictions),
    },
    sourceStyle: {
      ...checked.sourceStyle,
      unknownFields: FONT_MATCHING_SOURCE_STYLE_AXES.filter((axis) =>
        checked.sourceStyle.unknownFields.includes(axis),
      ),
    },
    rankedCandidates: [...checked.rankedCandidates]
      .sort((left, right) => left.rank - right.rank)
      .map((candidate) => ({
        ...candidate,
        reasonCodes: [...candidate.reasonCodes].sort(compareStrings),
      })),
  };
  return `${JSON.stringify(canonical, null, 2)}\n`;
}

export function resolveWorkTypographyLock(
  profile: Pick<WorkTypographyProfileV2, "userLocks">,
  context: {
    role: FontMatchingSemanticRole;
    chapterId: string;
    pageId: string;
    blockId: string;
  },
): WorkTypographyUserLockV2 | null {
  const blockLock = profile.userLocks.find(
    (lock) =>
      lock.scope.type === "block" &&
      lock.scope.chapterId === context.chapterId &&
      lock.scope.pageId === context.pageId &&
      lock.scope.blockId === context.blockId,
  );
  if (blockLock) {
    return blockLock;
  }
  return (
    profile.userLocks.find(
      (lock) => lock.scope.type === "role" && lock.scope.role === context.role,
    ) ?? null
  );
}

export function normalizeWorkTypographyProfileV2(
  profile: WorkTypographyProfileV2,
): WorkTypographyProfileV2 {
  const checked = validateWorkTypographyProfileV2(profile);
  const canonical = {
    ...checked,
    dialogueAnchor: canonicalizeAnchor(checked.dialogueAnchor),
    narrationAnchor: canonicalizeAnchor(checked.narrationAnchor),
    thoughtAnchor: canonicalizeAnchor(checked.thoughtAnchor),
    rolePalettes: [...checked.rolePalettes]
      .sort((left, right) => comparePaletteRoles(left.role, right.role))
      .map((palette) => ({
        ...palette,
        allowedFontIds: [...palette.allowedFontIds].sort(compareStrings),
      })),
    intentionalOverrides: [...checked.intentionalOverrides].sort(
      (left, right) => compareStrings(left.id, right.id),
    ),
    userLocks: [...checked.userLocks].sort(compareUserLocks),
    orientationPolicy: {
      horizontalAllowedFontIds: sortNullableIds(
        checked.orientationPolicy.horizontalAllowedFontIds,
      ),
      verticalAllowedFontIds: sortNullableIds(
        checked.orientationPolicy.verticalAllowedFontIds,
      ),
      verticalOnlyFontIds: [
        ...checked.orientationPolicy.verticalOnlyFontIds,
      ].sort(compareStrings),
    },
    genrePrior: checked.genrePrior
      ? {
          ...checked.genrePrior,
          labels: [...checked.genrePrior.labels].sort((left, right) =>
            compareStrings(left.label, right.label),
          ),
          styleBias: Object.fromEntries(
            FONT_MATCHING_SOURCE_STYLE_AXES.flatMap((axis) => {
              const value = checked.genrePrior?.styleBias[axis];
              return value === undefined ? [] : [[axis, value]];
            }),
          ),
        }
      : null,
  };
  return validateWorkTypographyProfileV2(canonical);
}

function migrateAnchor(
  font: string | null,
  evidenceCount: number,
  confidence: number,
  updatedAt: string,
): TypographyAnchorV2 | null {
  if (!font) {
    return null;
  }
  return {
    primaryFontId: font,
    allowedFontIds: [font],
    origin: "migrated",
    evidenceCount,
    confidence,
    replacementPolicy: {
      minimumEvidenceCount: 20,
      minimumScoreMargin: 0.1,
    },
    updatedAt,
  };
}

function canonicalizeAnchor(
  anchor: TypographyAnchorV2 | null,
): TypographyAnchorV2 | null {
  if (!anchor) {
    return null;
  }
  return {
    ...anchor,
    allowedFontIds: [
      anchor.primaryFontId,
      ...anchor.allowedFontIds
        .filter((font) => font !== anchor.primaryFontId)
        .sort(compareStrings),
    ],
  };
}

function compareRolePredictions(
  left: { role: FontMatchingSemanticRole; confidence: number },
  right: { role: FontMatchingSemanticRole; confidence: number },
): number {
  return (
    right.confidence - left.confidence ||
    FONT_MATCHING_SEMANTIC_ROLES.indexOf(left.role) -
      FONT_MATCHING_SEMANTIC_ROLES.indexOf(right.role)
  );
}

function comparePaletteRoles(
  left: FontMatchingPaletteRole,
  right: FontMatchingPaletteRole,
): number {
  return (
    FONT_MATCHING_PALETTE_ROLES.indexOf(left) -
    FONT_MATCHING_PALETTE_ROLES.indexOf(right)
  );
}

function compareUserLocks(
  left: WorkTypographyUserLockV2,
  right: WorkTypographyUserLockV2,
): number {
  const leftPriority = left.scope.type === "block" ? 0 : 1;
  const rightPriority = right.scope.type === "block" ? 0 : 1;
  return leftPriority - rightPriority || compareStrings(left.id, right.id);
}

function sortNullableIds(values: string[] | null): string[] | null {
  return values ? [...values].sort(compareStrings) : null;
}

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right, "en");
}

function readSchemaVersion(payload: unknown): unknown {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("schemaVersion" in payload)
  ) {
    return "missing";
  }
  return payload.schemaVersion;
}

function parseSchema<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  payload: unknown,
  label: string,
): z.output<TSchema> {
  const result = schema.safeParse(payload);
  if (result.success) {
    return result.data;
  }
  const issue = result.error.issues[0];
  const path = issue?.path.length ? issue.path.join(".") : "payload";
  const detail = issue ? issue.message : "unknown validation error";
  throw new Error(`${label} 형식이 올바르지 않습니다. ${path}: ${detail}`, {
    cause: result.error,
  });
}
