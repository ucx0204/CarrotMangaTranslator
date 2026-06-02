import type { CustomFont } from "../../../shared/types";

export const DEFAULT_BLOCK_FONT_ID = "default";

export const DEFAULT_BLOCK_FONT_STACK = '"Malgun Gothic", "Apple SD Gothic Neo", "Segoe UI", sans-serif';

export type BlockFontOption = {
  id: string;
  label: string;
  cssFamily: string;
  sample: string;
};

export const BLOCK_FONT_OPTIONS: BlockFontOption[] = [
  {
    id: DEFAULT_BLOCK_FONT_ID,
    label: "기본",
    cssFamily: DEFAULT_BLOCK_FONT_STACK,
    sample: "가나다 Aa"
  },
  {
    id: "mongtori",
    label: "그리운 몽토리체",
    cssFamily: '"MGT Mongtori", "Malgun Gothic", sans-serif',
    sample: "그리운 몽토리"
  },
  {
    id: "chosun-gungseo",
    label: "조선궁서체",
    cssFamily: '"MGT Chosun Gungseo", "Malgun Gothic", serif',
    sample: "조선궁서체"
  },
  {
    id: "griun-pol-sensibility",
    label: "그리운 경찰감성체",
    cssFamily: '"MGT Griun Pol Sensibility", "Malgun Gothic", sans-serif',
    sample: "경찰감성체"
  },
  {
    id: "nanum-gothic",
    label: "나눔고딕",
    cssFamily: '"MGT Nanum Gothic", "Malgun Gothic", sans-serif',
    sample: "나눔고딕 Aa"
  },
  {
    id: "nanum-myeongjo",
    label: "나눔명조",
    cssFamily: '"MGT Nanum Myeongjo", "Malgun Gothic", serif',
    sample: "나눔명조 Aa"
  },
  {
    id: "nanum-barun-gothic",
    label: "나눔바른고딕",
    cssFamily: '"MGT Nanum Barun Gothic", "Malgun Gothic", sans-serif',
    sample: "나눔바른고딕"
  },
  {
    id: "seoul-namsan",
    label: "서울남산",
    cssFamily: '"MGT Seoul Namsan", "Malgun Gothic", sans-serif',
    sample: "서울남산 Aa"
  },
  {
    id: "seoul-namsan-vertical",
    label: "서울남산 세로",
    cssFamily: '"MGT Seoul Namsan Vertical", "Malgun Gothic", sans-serif',
    sample: "서울남산 세로"
  },
  {
    id: "seoul-hangang",
    label: "서울한강",
    cssFamily: '"MGT Seoul Hangang", "Malgun Gothic", serif',
    sample: "서울한강 Aa"
  }
];

const BLOCK_FONT_IDS = new Set(BLOCK_FONT_OPTIONS.map((option) => option.id));

let customFontOptions: BlockFontOption[] = [];
const customFontIds = new Set<string>();

export function customFontToOption(font: CustomFont): BlockFontOption {
  return {
    id: font.id,
    label: font.label,
    cssFamily: `"${font.family}", "Malgun Gothic", sans-serif`,
    sample: font.label
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

export function getBlockFontOptions(): BlockFontOption[] {
  return [...BLOCK_FONT_OPTIONS, ...customFontOptions];
}

export function normalizeBlockFontFamily(value: string | undefined): string | undefined {
  const id = String(value ?? "").trim();
  if (!id || id === DEFAULT_BLOCK_FONT_ID || (!BLOCK_FONT_IDS.has(id) && !customFontIds.has(id))) {
    return undefined;
  }
  return id;
}

export function resolveBlockFontOption(value: string | undefined): BlockFontOption {
  const id = normalizeBlockFontFamily(value) ?? DEFAULT_BLOCK_FONT_ID;
  return getBlockFontOptions().find((option) => option.id === id) ?? BLOCK_FONT_OPTIONS[0];
}

export function resolveBlockFontFamily(value: string | undefined): string {
  return resolveBlockFontOption(value).cssFamily;
}
