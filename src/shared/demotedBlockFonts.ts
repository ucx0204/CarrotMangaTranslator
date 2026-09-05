/** Stable aliases preserve saved blocks when an installed bundled font becomes optional. */
export const DEMOTED_BLOCK_FONTS = [
  {
    id: "black-and-white-picture",
    customId: "fa780a26-da5b-5073-9373-6359cb938976",
    label: "Black And White Picture",
  },
  {
    id: "kirang-haerang",
    customId: "558d1ff8-b30a-5b46-9927-682b486d8e11",
    label: "Kirang Haerang",
  },
  {
    id: "single-day",
    customId: "01cac741-b727-52eb-b618-a117fd29ef28",
    label: "Single Day",
  },
] as const;

export function resolveDemotedBlockFontId(id: string): string {
  return DEMOTED_BLOCK_FONTS.find((font) => font.id === id)?.customId ?? id;
}

export function isDemotedBlockFontId(id: string): boolean {
  return DEMOTED_BLOCK_FONTS.some((font) => font.id === id);
}
