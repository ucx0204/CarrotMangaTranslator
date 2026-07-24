import type { CustomFont } from "../../../shared/libraryTypes";
import {
  DEFAULT_BLOCK_FONT_ID,
  DEFAULT_BLOCK_FONT_STACK,
  getPrioritizedBuiltInBlockFonts,
  isBuiltInBlockFontId,
} from "../../../shared/blockFontCatalog";
import { DEFAULT_UI_LOCALE, type UiLocale } from "../../../shared/uiLocales";
import type { TFunction } from "i18next";

export type BlockFontOption = Readonly<{
  id: string;
  label: string;
  cssFamily: string;
  sample: string;
  locale?: UiLocale;
}>;

type ReadonlyFontPreferences = Readonly<{
  favoriteIds: readonly string[];
  orderedIds: readonly string[];
  defaultFontId: string;
}>;

/**
 * An immutable, self-contained view of the fonts available to one renderer
 * tree. Keeping the custom fonts and preferences together prevents consumers
 * from observing a half-applied library update.
 */
export type BlockFontCatalog = Readonly<{
  customFonts: readonly Readonly<CustomFont>[];
  customOptions: readonly BlockFontOption[];
  preferences: ReadonlyFontPreferences;
}>;

const DEFAULT_BLOCK_FONT_OPTION: BlockFontOption = Object.freeze({
  id: DEFAULT_BLOCK_FONT_ID,
  label: "기본",
  cssFamily: DEFAULT_BLOCK_FONT_STACK,
  sample: "가나다 Aa",
});

const DEFAULT_FONT_PREFERENCES: ReadonlyFontPreferences = Object.freeze({
  favoriteIds: Object.freeze([]),
  orderedIds: Object.freeze([]),
  defaultFontId: DEFAULT_BLOCK_FONT_ID,
});

export const DEFAULT_BLOCK_FONT_CATALOG: BlockFontCatalog =
  createBlockFontCatalog([], DEFAULT_FONT_PREFERENCES);

export function createBlockFontCatalog(
  fonts: readonly CustomFont[],
  preferences: ReadonlyFontPreferences,
): BlockFontCatalog {
  const customFonts = Object.freeze(
    fonts.map((font) => Object.freeze({ ...font })),
  );
  const customOptions = Object.freeze(
    customFonts.map((font) => customFontToOption(font)),
  );
  const allOptions = [
    DEFAULT_BLOCK_FONT_OPTION,
    ...getPrioritizedBuiltInBlockFonts(DEFAULT_UI_LOCALE),
    ...customOptions,
  ];
  return Object.freeze({
    customFonts,
    customOptions,
    preferences: freezeFontPreferences(
      normalizeFontPreferencesForOptions(preferences, allOptions),
    ),
  });
}

function customFontToOption(font: Readonly<CustomFont>): BlockFontOption {
  return Object.freeze({
    id: font.id,
    label: font.label,
    cssFamily: `"${font.family}", "Malgun Gothic", sans-serif`,
    sample: font.label,
  });
}

function buildUnorderedBlockFontOptions(
  catalog: BlockFontCatalog,
  t?: TFunction<"renderer">,
  locale: UiLocale = DEFAULT_UI_LOCALE,
): readonly BlockFontOption[] {
  const defaultOption = t
    ? {
        ...DEFAULT_BLOCK_FONT_OPTION,
        label: t("fonts.default"),
        sample: t("fonts.defaultSample"),
      }
    : DEFAULT_BLOCK_FONT_OPTION;
  return freezeBlockFontOptions([
    defaultOption,
    ...getPrioritizedBuiltInBlockFonts(locale),
    ...catalog.customOptions,
  ]);
}

export function getBaseBlockFontOptions(
  catalog: BlockFontCatalog,
  t?: TFunction<"renderer">,
  locale: UiLocale = DEFAULT_UI_LOCALE,
): readonly BlockFontOption[] {
  const options = buildUnorderedBlockFontOptions(catalog, t, locale);
  const designated =
    catalog.preferences.defaultFontId === DEFAULT_BLOCK_FONT_ID
      ? undefined
      : options.find(
          (option) => option.id === catalog.preferences.defaultFontId,
        );
  return freezeBlockFontOptions(
    options.map((option) =>
      option.id === DEFAULT_BLOCK_FONT_ID
        ? {
            ...option,
            cssFamily: designated?.cssFamily ?? DEFAULT_BLOCK_FONT_STACK,
          }
        : option,
    ),
  );
}

export function getBlockFontOptions(
  catalog: BlockFontCatalog,
  t?: TFunction<"renderer">,
  locale: UiLocale = DEFAULT_UI_LOCALE,
): readonly BlockFontOption[] {
  return orderBlockFontOptions(
    getBaseBlockFontOptions(catalog, t, locale),
    catalog.preferences,
  );
}

function normalizeFontPreferencesForOptions(
  preferences: ReadonlyFontPreferences,
  options: readonly BlockFontOption[],
): ReadonlyFontPreferences {
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
  preferences: ReadonlyFontPreferences,
): readonly BlockFontOption[] {
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
  return freezeBlockFontOptions([
    ...options.filter((option) => favoriteIds.has(option.id)).sort(compare),
    ...options.filter((option) => !favoriteIds.has(option.id)).sort(compare),
  ]);
}

export function normalizeBlockFontFamily(
  value: string | undefined,
  catalog: BlockFontCatalog,
): string | undefined {
  const id = String(value ?? "").trim();
  if (
    !id ||
    id === DEFAULT_BLOCK_FONT_ID ||
    (!isBuiltInBlockFontId(id) &&
      !catalog.customOptions.some((font) => font.id === id))
  ) {
    return undefined;
  }
  return id;
}

export function resolveBlockFontOption(
  value: string | undefined,
  options: readonly BlockFontOption[],
): BlockFontOption {
  const id = String(value ?? "").trim();
  return (
    options.find((option) => option.id === id) ??
    options.find((option) => option.id === DEFAULT_BLOCK_FONT_ID) ??
    DEFAULT_BLOCK_FONT_OPTION
  );
}

export function resolveBlockFontFamily(
  value: string | undefined,
  catalog: BlockFontCatalog,
): string {
  const id = String(value ?? "").trim();
  const explicitFamily =
    id && id !== DEFAULT_BLOCK_FONT_ID
      ? resolveConcreteFontFamily(id, catalog)
      : undefined;
  if (explicitFamily) {
    return explicitFamily;
  }
  return catalog.preferences.defaultFontId === DEFAULT_BLOCK_FONT_ID
    ? DEFAULT_BLOCK_FONT_STACK
    : (resolveConcreteFontFamily(catalog.preferences.defaultFontId, catalog) ??
        DEFAULT_BLOCK_FONT_STACK);
}

function resolveConcreteFontFamily(
  id: string,
  catalog: BlockFontCatalog,
): string | undefined {
  if (isBuiltInBlockFontId(id)) {
    return getPrioritizedBuiltInBlockFonts(DEFAULT_UI_LOCALE).find(
      (font) => font.id === id,
    )?.cssFamily;
  }
  return catalog.customOptions.find((font) => font.id === id)?.cssFamily;
}

function freezeFontPreferences(
  preferences: ReadonlyFontPreferences,
): ReadonlyFontPreferences {
  return Object.freeze({
    favoriteIds: Object.freeze([...preferences.favoriteIds]),
    orderedIds: Object.freeze([...preferences.orderedIds]),
    defaultFontId: preferences.defaultFontId,
  });
}

function freezeBlockFontOptions(
  options: readonly BlockFontOption[],
): readonly BlockFontOption[] {
  return Object.freeze(
    options.map((option) =>
      Object.isFrozen(option) ? option : Object.freeze({ ...option }),
    ),
  );
}
