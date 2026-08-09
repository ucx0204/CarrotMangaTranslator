import {
  ALL_BLOCK_FORMAT_GROUP_IDS,
  type BlockFormatDefaults,
  type BlockFormatGroupId,
} from "./blockFormat";
import {
  buildBlockStylePresetFormat,
  buildDefaultsPresetFormat,
  normalizePresetFormat,
  resolveBlockStylePresetPatchFields,
  type BlockStylePresetFormat as StoredBlockStylePresetFormat,
} from "./blockStylePresetFormat";
import type { TranslationBlock } from "./textTypes";

export const BLOCK_STYLE_PRESET_VERSION = 1 as const;
export const MAX_BLOCK_STYLE_PRESETS = 100;
export const MAX_BLOCK_STYLE_PRESET_NAME_LENGTH = 80;
export const MAX_BLOCK_STYLE_PRESET_ID_LENGTH = 100;

type BlockStylePresetFormat = StoredBlockStylePresetFormat;

export type BlockStylePreset = {
  version: typeof BLOCK_STYLE_PRESET_VERSION;
  id: string;
  name: string;
  pinned: boolean;
  groupIds: BlockFormatGroupId[];
  format: BlockStylePresetFormat;
};

export type BlockStylePresetSummary = Pick<
  BlockStylePreset,
  "id" | "name" | "pinned"
> & {
  missingFont: boolean;
};

export type CreateBlockStylePresetInput = {
  name: string;
  pinned: boolean;
  groupIds: BlockFormatGroupId[];
};

const FORMAT_GROUP_ID_SET: ReadonlySet<string> = new Set(
  ALL_BLOCK_FORMAT_GROUP_IDS,
);
const PRESET_ID_PATTERN = /^[a-zA-Z0-9._:-]+$/;

export function createBlockStylePreset(input: {
  block: TranslationBlock;
  groupIds: readonly BlockFormatGroupId[];
  id?: string;
  name: string;
  pinned?: boolean;
}): BlockStylePreset {
  const groupIds = normalizeBlockStylePresetGroupIds(input.groupIds);
  return {
    version: BLOCK_STYLE_PRESET_VERSION,
    id: input.id ?? createBlockStylePresetId(),
    name: normalizePresetName(input.name) || "Preset",
    pinned: input.pinned ?? false,
    groupIds,
    format: buildBlockStylePresetFormat(input.block, groupIds),
  };
}

export function createBlockStylePresetFromDefaults(input: {
  defaults: BlockFormatDefaults;
  groupIds?: readonly BlockFormatGroupId[];
  id?: string;
  name: string;
  pinned?: boolean;
}): BlockStylePreset {
  const requestedGroups = normalizeBlockStylePresetGroupIds(
    input.groupIds ?? ALL_BLOCK_FORMAT_GROUP_IDS,
  );
  const groupIds =
    input.defaults.renderDirection === "auto"
      ? requestedGroups.filter((groupId) => groupId !== "direction")
      : requestedGroups;
  return {
    version: BLOCK_STYLE_PRESET_VERSION,
    id: input.id ?? createBlockStylePresetId(),
    name: normalizePresetName(input.name) || "Preset",
    pinned: input.pinned ?? false,
    groupIds,
    format: buildDefaultsPresetFormat(input.defaults, groupIds),
  };
}

export function createBlockStylePresetId(): string {
  const randomId = globalThis.crypto?.randomUUID?.();
  if (randomId) {
    return `style-preset:${randomId}`;
  }
  return `style-preset:${Date.now().toString(36)}:${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

export function normalizeBlockStylePresets(value: unknown): BlockStylePreset[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const presets: BlockStylePreset[] = [];
  const ids = new Set<string>();
  for (const candidate of value.slice(0, MAX_BLOCK_STYLE_PRESETS)) {
    const preset = normalizeBlockStylePreset(candidate);
    if (!preset || ids.has(preset.id)) {
      continue;
    }
    ids.add(preset.id);
    presets.push(preset);
  }
  return presets;
}

function normalizeBlockStylePresetGroupIds(
  value: unknown,
): BlockFormatGroupId[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<BlockFormatGroupId>();
  for (const candidate of value) {
    if (
      typeof candidate === "string" &&
      FORMAT_GROUP_ID_SET.has(candidate) &&
      !seen.has(candidate as BlockFormatGroupId)
    ) {
      seen.add(candidate as BlockFormatGroupId);
    }
  }
  return ALL_BLOCK_FORMAT_GROUP_IDS.filter((groupId) => seen.has(groupId));
}

export function resolveBlockStylePresetPatch(
  preset: BlockStylePreset,
  options: { omitFont?: boolean } = {},
): Partial<TranslationBlock> {
  return resolveBlockStylePresetPatchFields(preset, options);
}

export function summarizeBlockStylePresets(
  presets: readonly BlockStylePreset[],
  availableFontIds: ReadonlySet<string>,
): BlockStylePresetSummary[] {
  return presets.map((preset) => ({
    id: preset.id,
    name: preset.name,
    pinned: preset.pinned,
    missingFont: Boolean(
      preset.groupIds.includes("font") &&
      preset.format.fontFamily &&
      !availableFontIds.has(preset.format.fontFamily),
    ),
  }));
}

export function cloneBlockStylePresets(
  presets: readonly BlockStylePreset[],
): BlockStylePreset[] {
  return presets.map((preset) => ({
    ...preset,
    groupIds: [...preset.groupIds],
    format: { ...preset.format },
  }));
}

function normalizeBlockStylePreset(value: unknown): BlockStylePreset | null {
  const record = asRecord(value);
  if (!record || record.version !== BLOCK_STYLE_PRESET_VERSION) {
    return null;
  }
  const id = typeof record.id === "string" ? record.id.trim() : "";
  const name = normalizePresetName(record.name);
  const groupIds = normalizeBlockStylePresetGroupIds(record.groupIds);
  if (
    !id ||
    id.length > MAX_BLOCK_STYLE_PRESET_ID_LENGTH ||
    !PRESET_ID_PATTERN.test(id) ||
    !name ||
    groupIds.length === 0 ||
    typeof record.pinned !== "boolean"
  ) {
    return null;
  }
  return {
    version: BLOCK_STYLE_PRESET_VERSION,
    id,
    name,
    pinned: record.pinned,
    groupIds,
    format: normalizePresetFormat(record.format, groupIds),
  };
}

function normalizePresetName(value: unknown): string {
  return typeof value === "string"
    ? value.trim().slice(0, MAX_BLOCK_STYLE_PRESET_NAME_LENGTH)
    : "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
