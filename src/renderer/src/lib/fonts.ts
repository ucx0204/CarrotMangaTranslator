import type { CustomFont, FontPreferences } from "../../../shared/libraryTypes";
import {
  DEFAULT_BLOCK_FONT_ID,
  DEFAULT_BLOCK_FONT_STACK,
  getPrioritizedBuiltInBlockFonts,
  isBuiltInBlockFontId,
} from "../../../shared/blockFontCatalog";
import { DEFAULT_UI_LOCALE, type UiLocale } from "../../../shared/uiLocales";
import type { TFunction } from "i18next";

export type BlockFontOption = {
  id: string;
  label: string;
  cssFamily: string;
  sample: string;
  locale?: UiLocale;
};

const DEFAULT_BLOCK_FONT_OPTION: BlockFontOption = {
  id: DEFAULT_BLOCK_FONT_ID,
  label: "기본",
  cssFamily: DEFAULT_BLOCK_FONT_STACK,
  sample: "가나다 Aa",
};

export const DEFAULT_FONT_PREFERENCES: FontPreferences = {
  favoriteIds: [],
  orderedIds: [],
  defaultFontId: DEFAULT_BLOCK_FONT_ID,
};

let customFontOptions: BlockFontOption[] = [];
const customFontIds = new Set<string>();
let currentPreferences: FontPreferences = { ...DEFAULT_FONT_PREFERENCES };

function customFontToOption(font: CustomFont): BlockFontOption {
  return {
    id: font.id,
    label: font.label,
    cssFamily: `"${font.family}", "Malgun Gothic", sans-serif`,
    sample: font.label,
  };
}

/** Registers user-installed fonts so they resolve like built-ins (call when the list changes). */
export function setCustomFontOptions(fonts: CustomFont[]): void {
  customFontOptions = fonts.map(customFontToOption);
  customFontIds.clear();
  for (const font of fonts) {
    customFontIds.add(font.id);
  }
}

export function setFontPreferences(preferences: FontPreferences): void {
  currentPreferences = normalizeFontPreferencesForOptions(
    preferences,
    buildUnorderedBlockFontOptions(),
  );
}

function buildUnorderedBlockFontOptions(
  t?: TFunction<"renderer">,
  locale: UiLocale = DEFAULT_UI_LOCALE,
): BlockFontOption[] {
  const defaultOption = t
    ? {
        ...DEFAULT_BLOCK_FONT_OPTION,
        label: t("fonts.default"),
        sample: t("fonts.defaultSample"),
      }
    : DEFAULT_BLOCK_FONT_OPTION;
  return [
    defaultOption,
    ...getPrioritizedBuiltInBlockFonts(locale),
    ...customFontOptions,
  ];
}

export function getBaseBlockFontOptions(
  t?: TFunction<"renderer">,
  locale: UiLocale = DEFAULT_UI_LOCALE,
  preferences: FontPreferences = currentPreferences,
): BlockFontOption[] {
  const options = buildUnorderedBlockFontOptions(t, locale);
  const normalized = normalizeFontPreferencesForOptions(preferences, options);
  const designated =
    normalized.defaultFontId === DEFAULT_BLOCK_FONT_ID
      ? undefined
      : options.find((option) => option.id === normalized.defaultFontId);
  return options.map((option) =>
    option.id === DEFAULT_BLOCK_FONT_ID
      ? {
          ...option,
          cssFamily: designated?.cssFamily ?? DEFAULT_BLOCK_FONT_STACK,
        }
      : option,
  );
}

export function getBlockFontOptions(
  t?: TFunction<"renderer">,
  locale: UiLocale = DEFAULT_UI_LOCALE,
  preferences: FontPreferences = currentPreferences,
): BlockFontOption[] {
  return orderBlockFontOptions(
    getBaseBlockFontOptions(t, locale, preferences),
    preferences,
  );
}

function normalizeFontPreferencesForOptions(
  preferences: FontPreferences,
  options: readonly BlockFontOption[],
): FontPreferences {
  const knownIds = new Set(options.map((option) => option.id));
  return {
    favoriteIds: normalizeKnownIds(preferences.favoriteIds, knownIds),
    orderedIds: normalizeKnownIds(preferences.orderedIds, knownIds),
    defaultFontId: knownIds.has(preferences.defaultFontId)
      ? preferences.defaultFontId
      : DEFAULT_BLOCK_FONT_ID,
  };
}

function normalizeKnownIds(
  ids: readonly string[],
  knownIds: ReadonlySet<string>,
): string[] {
  const seen = new Set<string>();
  return ids.filter((id) => {
    if (!knownIds.has(id) || seen.has(id)) {
      return false;
    }
    seen.add(id);
    return true;
  });
}

export function orderBlockFontOptions(
  options: readonly BlockFontOption[],
  preferences: FontPreferences,
): BlockFontOption[] {
  const normalized = normalizeFontPreferencesForOptions(preferences, options);
  const favoriteIds = new Set(normalized.favoriteIds);
  const order = new Map(
    normalized.orderedIds.map((id, index) => [id, index] as const),
  );
  const baseOrder = new Map(
    options.map((option, index) => [option.id, index] as const),
  );
  const compare = (left: BlockFontOption, right: BlockFontOption): number => {
    const leftRank = order.get(left.id);
    const rightRank = order.get(right.id);
    if (leftRank !== undefined || rightRank !== undefined) {
      if (leftRank === undefined) return 1;
      if (rightRank === undefined) return -1;
      return leftRank - rightRank;
    }
    return (baseOrder.get(left.id) ?? 0) - (baseOrder.get(right.id) ?? 0);
  };
  return [
    ...options.filter((option) => favoriteIds.has(option.id)).sort(compare),
    ...options.filter((option) => !favoriteIds.has(option.id)).sort(compare),
  ];
}

export function normalizeBlockFontFamily(
  value: string | undefined,
): string | undefined {
  const id = String(value ?? "").trim();
  if (
    !id ||
    id === DEFAULT_BLOCK_FONT_ID ||
    (!isBuiltInBlockFontId(id) && !customFontIds.has(id))
  ) {
    return undefined;
  }
  return id;
}

export function resolveBlockFontOption(
  value: string | undefined,
  options: readonly BlockFontOption[] = getBlockFontOptions(),
): BlockFontOption {
  const id = normalizeBlockFontFamily(value) ?? DEFAULT_BLOCK_FONT_ID;
  return (
    options.find((option) => option.id === id) ??
    options.find((option) => option.id === DEFAULT_BLOCK_FONT_ID) ??
    DEFAULT_BLOCK_FONT_OPTION
  );
}

export function resolveBlockFontFamily(value: string | undefined): string {
  const id = String(value ?? "").trim();
  const explicitFamily =
    id && id !== DEFAULT_BLOCK_FONT_ID
      ? resolveConcreteFontFamily(id)
      : undefined;
  if (explicitFamily) {
    return explicitFamily;
  }
  return currentPreferences.defaultFontId === DEFAULT_BLOCK_FONT_ID
    ? DEFAULT_BLOCK_FONT_STACK
    : (resolveConcreteFontFamily(currentPreferences.defaultFontId) ??
        DEFAULT_BLOCK_FONT_STACK);
}

function resolveConcreteFontFamily(id: string): string | undefined {
  if (isBuiltInBlockFontId(id)) {
    return getPrioritizedBuiltInBlockFonts(DEFAULT_UI_LOCALE).find(
      (font) => font.id === id,
    )?.cssFamily;
  }
  return customFontOptions.find((font) => font.id === id)?.cssFamily;
}
