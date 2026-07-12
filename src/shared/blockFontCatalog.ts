import type { UiLocale } from "./uiLocales";

export const DEFAULT_BLOCK_FONT_ID = "default";

export const DEFAULT_BLOCK_FONT_STACK =
  '"Malgun Gothic", "Apple SD Gothic Neo", "Segoe UI", sans-serif';

type BuiltInBlockFontDefinition = {
  id: string;
  locale: UiLocale;
  label: string;
  cssFamily: string;
  sample: string;
};

const FONT_LOCALE_ORDER: readonly UiLocale[] = [
  "ko",
  "en",
  "ja",
  "zh-Hans",
  "zh-Hant",
];

const KOREAN_SANS_FALLBACK = '"Malgun Gothic", sans-serif';
const KOREAN_SERIF_FALLBACK = '"Malgun Gothic", serif';
const ENGLISH_FALLBACK = '"Segoe UI", Arial, sans-serif';
const JAPANESE_FALLBACK = '"Yu Gothic", Meiryo, sans-serif';
const SIMPLIFIED_CHINESE_FALLBACK =
  '"Microsoft YaHei", "PingFang SC", SimHei, sans-serif';
const TRADITIONAL_CHINESE_FALLBACK =
  '"Microsoft JhengHei", "PingFang TC", PMingLiU, sans-serif';

function fontFamily(family: string, fallback: string): string {
  return `"${family}", ${fallback}`;
}

export const BUILT_IN_BLOCK_FONTS = [
  // Korean
  {
    id: "mongtori",
    locale: "ko",
    label: "그리운 몽토리체",
    cssFamily: fontFamily("MGT Mongtori", KOREAN_SANS_FALLBACK),
    sample: "그리운 몽토리",
  },
  {
    id: "chosun-gungseo",
    locale: "ko",
    label: "조선궁서체",
    cssFamily: fontFamily("MGT Chosun Gungseo", KOREAN_SERIF_FALLBACK),
    sample: "조선궁서체",
  },
  {
    id: "griun-pol-sensibility",
    locale: "ko",
    label: "그리운 경찰감성체",
    cssFamily: fontFamily("MGT Griun Pol Sensibility", KOREAN_SANS_FALLBACK),
    sample: "경찰감성체",
  },
  {
    id: "nanum-gothic",
    locale: "ko",
    label: "나눔고딕",
    cssFamily: fontFamily("MGT Nanum Gothic", KOREAN_SANS_FALLBACK),
    sample: "나눔고딕 Aa",
  },
  {
    id: "nanum-myeongjo",
    locale: "ko",
    label: "나눔명조",
    cssFamily: fontFamily("MGT Nanum Myeongjo", KOREAN_SERIF_FALLBACK),
    sample: "나눔명조 Aa",
  },
  {
    id: "nanum-barun-gothic",
    locale: "ko",
    label: "나눔바른고딕",
    cssFamily: fontFamily("MGT Nanum Barun Gothic", KOREAN_SANS_FALLBACK),
    sample: "나눔바른고딕",
  },
  {
    id: "seoul-namsan",
    locale: "ko",
    label: "서울남산",
    cssFamily: fontFamily("MGT Seoul Namsan", KOREAN_SANS_FALLBACK),
    sample: "서울남산 Aa",
  },
  {
    id: "seoul-namsan-vertical",
    locale: "ko",
    label: "서울남산 세로",
    cssFamily: fontFamily("MGT Seoul Namsan Vertical", KOREAN_SANS_FALLBACK),
    sample: "서울남산 세로",
  },
  {
    id: "seoul-hangang",
    locale: "ko",
    label: "서울한강",
    cssFamily: fontFamily("MGT Seoul Hangang", KOREAN_SERIF_FALLBACK),
    sample: "서울한강 Aa",
  },

  // English
  {
    id: "comic-neue",
    locale: "en",
    label: "Comic Neue",
    cssFamily: fontFamily("MGT Comic Neue", ENGLISH_FALLBACK),
    sample: "WHAM! Boom!",
  },
  {
    id: "kalam",
    locale: "en",
    label: "Kalam",
    cssFamily: fontFamily("MGT Kalam", ENGLISH_FALLBACK),
    sample: "Handwritten note",
  },
  {
    id: "bangers",
    locale: "en",
    label: "Bangers",
    cssFamily: fontFamily("MGT Bangers", ENGLISH_FALLBACK),
    sample: "BANG! POW!",
  },
  {
    id: "luckiest-guy",
    locale: "en",
    label: "Luckiest Guy",
    cssFamily: fontFamily("MGT Luckiest Guy", ENGLISH_FALLBACK),
    sample: "LUCKY HERO!",
  },
  {
    id: "permanent-marker",
    locale: "en",
    label: "Permanent Marker",
    cssFamily: fontFamily("MGT Permanent Marker", ENGLISH_FALLBACK),
    sample: "Marker note",
  },
  {
    id: "freckle-face",
    locale: "en",
    label: "Freckle Face",
    cssFamily: fontFamily("MGT Freckle Face", ENGLISH_FALLBACK),
    sample: "Comic fun!",
  },

  // Japanese
  {
    id: "yusei-magic",
    locale: "ja",
    label: "Yusei Magic",
    cssFamily: fontFamily("MGT Yusei Magic", JAPANESE_FALLBACK),
    sample: "ドキドキ！漫画",
  },
  {
    id: "mochiy-pop-one",
    locale: "ja",
    label: "Mochiy Pop One",
    cssFamily: fontFamily("MGT Mochiy Pop One", JAPANESE_FALLBACK),
    sample: "わくわく！漫画",
  },
  {
    id: "hachi-maru-pop",
    locale: "ja",
    label: "Hachi Maru Pop",
    cssFamily: fontFamily("MGT Hachi Maru Pop", JAPANESE_FALLBACK),
    sample: "ふんわり漫画",
  },
  {
    id: "dela-gothic-one",
    locale: "ja",
    label: "Dela Gothic One",
    cssFamily: fontFamily("MGT Dela Gothic One", JAPANESE_FALLBACK),
    sample: "必殺技だ！",
  },
  {
    id: "reggae-one",
    locale: "ja",
    label: "Reggae One",
    cssFamily: fontFamily("MGT Reggae One", JAPANESE_FALLBACK),
    sample: "衝撃の展開！",
  },
  {
    id: "dot-gothic-16",
    locale: "ja",
    label: "DotGothic16",
    cssFamily: fontFamily("MGT DotGothic16", JAPANESE_FALLBACK),
    sample: "ドット漫画",
  },

  // Simplified Chinese
  {
    id: "zcool-kuaile",
    locale: "zh-Hans",
    label: "ZCOOL KuaiLe",
    cssFamily: fontFamily("MGT ZCOOL KuaiLe", SIMPLIFIED_CHINESE_FALLBACK),
    sample: "漫画对白！",
  },
  {
    id: "zcool-qingke-huangyou",
    locale: "zh-Hans",
    label: "ZCOOL QingKe HuangYou",
    cssFamily: fontFamily(
      "MGT ZCOOL QingKe HuangYou",
      SIMPLIFIED_CHINESE_FALLBACK,
    ),
    sample: "精彩故事！",
  },
  {
    id: "zcool-xiaowei",
    locale: "zh-Hans",
    label: "ZCOOL XiaoWei",
    cssFamily: fontFamily("MGT ZCOOL XiaoWei", SIMPLIFIED_CHINESE_FALLBACK),
    sample: "漫画对白",
  },
  {
    id: "ma-shan-zheng",
    locale: "zh-Hans",
    label: "Ma Shan Zheng",
    cssFamily: fontFamily("MGT Ma Shan Zheng", SIMPLIFIED_CHINESE_FALLBACK),
    sample: "江湖再见",
  },
  {
    id: "long-cang",
    locale: "zh-Hans",
    label: "Long Cang",
    cssFamily: fontFamily("MGT Long Cang", SIMPLIFIED_CHINESE_FALLBACK),
    sample: "风云再起",
  },
  {
    id: "liu-jian-mao-cao",
    locale: "zh-Hans",
    label: "Liu Jian Mao Cao",
    cssFamily: fontFamily("MGT Liu Jian Mao Cao", SIMPLIFIED_CHINESE_FALLBACK),
    sample: "快意江湖",
  },

  // Traditional Chinese
  {
    id: "huninn",
    locale: "zh-Hant",
    label: "Huninn",
    cssFamily: fontFamily("MGT Huninn", TRADITIONAL_CHINESE_FALLBACK),
    sample: "漫畫對白！",
  },
  {
    id: "iansui",
    locale: "zh-Hant",
    label: "Iansui",
    cssFamily: fontFamily("MGT Iansui", TRADITIONAL_CHINESE_FALLBACK),
    sample: "手寫旁白",
  },
  {
    id: "lxgw-wenkai-tc",
    locale: "zh-Hant",
    label: "LXGW WenKai TC",
    cssFamily: fontFamily("MGT LXGW WenKai TC", TRADITIONAL_CHINESE_FALLBACK),
    sample: "漫畫對白",
  },
  {
    id: "lxgw-marker-gothic",
    locale: "zh-Hant",
    label: "LXGW Marker Gothic",
    cssFamily: fontFamily(
      "MGT LXGW Marker Gothic",
      TRADITIONAL_CHINESE_FALLBACK,
    ),
    sample: "精彩故事！",
  },
  {
    id: "chenyu-luoyan",
    locale: "zh-Hant",
    label: "ChenYuluoyan",
    cssFamily: fontFamily("MGT ChenYuluoyan", TRADITIONAL_CHINESE_FALLBACK),
    sample: "雋永手寫",
  },
  {
    id: "cubic-11",
    locale: "zh-Hant",
    label: "Cubic 11",
    cssFamily: fontFamily("MGT Cubic 11", TRADITIONAL_CHINESE_FALLBACK),
    sample: "像素漫畫",
  },
] as const satisfies readonly BuiltInBlockFontDefinition[];

const BUILT_IN_BLOCK_FONT_BY_ID = new Map<string, BuiltInBlockFontDefinition>(
  BUILT_IN_BLOCK_FONTS.map((font) => [font.id, font] as const),
);

export function isBuiltInBlockFontId(value: string): boolean {
  return BUILT_IN_BLOCK_FONT_BY_ID.has(value);
}

export function resolveBuiltInBlockFontFamily(
  value: string | undefined,
): string | undefined {
  return value ? BUILT_IN_BLOCK_FONT_BY_ID.get(value)?.cssFamily : undefined;
}

export function getPrioritizedBuiltInBlockFonts(
  locale: UiLocale,
): BuiltInBlockFontDefinition[] {
  const localeOrder = [
    locale,
    ...FONT_LOCALE_ORDER.filter((candidate) => candidate !== locale),
  ];
  return localeOrder.flatMap((candidate) =>
    BUILT_IN_BLOCK_FONTS.filter((font) => font.locale === candidate),
  );
}
