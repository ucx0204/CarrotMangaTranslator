import type { CustomFont } from "../../../shared/libraryTypes";
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

let customFontOptions: BlockFontOption[] = [];
const customFontIds = new Set<string>();

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

export function getBlockFontOptions(
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
    options[0] ??
    DEFAULT_BLOCK_FONT_OPTION
  );
}

export function resolveBlockFontFamily(value: string | undefined): string {
  return resolveBlockFontOption(value).cssFamily;
}
