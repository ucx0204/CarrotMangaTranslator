import { afterEach, describe, expect, it } from "vitest";
import {
  BUILT_IN_BLOCK_FONTS,
  DEFAULT_BLOCK_FONT_ID,
  DEFAULT_BLOCK_FONT_STACK,
} from "../src/shared/blockFontCatalog";
import type { UiLocale } from "../src/shared/uiLocales";
import {
  getBlockFontOptions,
  normalizeBlockFontFamily,
  resolveBlockFontFamily,
  setCustomFontOptions,
  setFontPreferences,
} from "../src/renderer/src/lib/fonts";

const EXPECTED_IDS_BY_LOCALE = {
  ko: [
    "mongtori",
    "chosun-gungseo",
    "griun-pol-sensibility",
    "nanum-gothic",
    "nanum-myeongjo",
    "nanum-barun-gothic",
    "seoul-namsan",
    "seoul-namsan-vertical",
    "seoul-hangang",
  ],
  en: [
    "comic-neue",
    "kalam",
    "bangers",
    "luckiest-guy",
    "permanent-marker",
    "freckle-face",
  ],
  ja: [
    "yusei-magic",
    "mochiy-pop-one",
    "hachi-maru-pop",
    "dela-gothic-one",
    "reggae-one",
    "dot-gothic-16",
  ],
  "zh-Hans": [
    "zcool-kuaile",
    "zcool-qingke-huangyou",
    "zcool-xiaowei",
    "ma-shan-zheng",
    "long-cang",
    "liu-jian-mao-cao",
  ],
  "zh-Hant": [
    "huninn",
    "iansui",
    "lxgw-wenkai-tc",
    "lxgw-marker-gothic",
    "chenyu-luoyan",
    "cubic-11",
  ],
} as const satisfies Record<UiLocale, readonly string[]>;

const BASE_LOCALE_ORDER: readonly UiLocale[] = [
  "ko",
  "en",
  "ja",
  "zh-Hans",
  "zh-Hant",
];

afterEach(() => {
  setCustomFontOptions([]);
  setFontPreferences({
    favoriteIds: [],
    orderedIds: [],
    defaultFontId: DEFAULT_BLOCK_FONT_ID,
  });
});

describe("built-in block font catalog", () => {
  it("contains the expected stable kebab-case IDs for every locale", () => {
    expect(BUILT_IN_BLOCK_FONTS).toHaveLength(33);
    const ids = BUILT_IN_BLOCK_FONTS.map((font) => font.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id))).toBe(true);

    for (const locale of BASE_LOCALE_ORDER) {
      expect(
        BUILT_IN_BLOCK_FONTS.filter((font) => font.locale === locale).map(
          (font) => font.id,
        ),
      ).toEqual(EXPECTED_IDS_BY_LOCALE[locale]);
    }
  });

  it.each(BASE_LOCALE_ORDER)(
    "keeps Default first and prioritizes the %s group",
    (locale) => {
      const options = getBlockFontOptions(undefined, locale);
      expect(options[0]?.id).toBe(DEFAULT_BLOCK_FONT_ID);

      const expectedLocaleOrder = [
        locale,
        ...BASE_LOCALE_ORDER.filter((candidate) => candidate !== locale),
      ];
      const actualLocaleOrder = Array.from(
        new Set(
          options.flatMap((option) => (option.locale ? [option.locale] : [])),
        ),
      );
      expect(actualLocaleOrder).toEqual(expectedLocaleOrder);

      const firstGroupIds = options
        .slice(1, 1 + EXPECTED_IDS_BY_LOCALE[locale].length)
        .map((option) => option.id);
      expect(firstGroupIds).toEqual(EXPECTED_IDS_BY_LOCALE[locale]);
    },
  );

  it("keeps user-installed fonts after every built-in group", () => {
    const customId = "7432f752-8615-4708-a3d6-57bbcb05bdda";
    setCustomFontOptions([
      {
        id: customId,
        label: "My Font",
        family: `MGTUser-${customId}`,
        fileName: `${customId}.ttf`,
      },
    ]);

    const options = getBlockFontOptions(undefined, "ja");
    expect(options.at(-1)?.id).toBe(customId);
    expect(options).toHaveLength(BUILT_IN_BLOCK_FONTS.length + 2);
  });

  it("normalizes every built-in and registered custom font ID", () => {
    for (const font of BUILT_IN_BLOCK_FONTS) {
      expect(normalizeBlockFontFamily(font.id)).toBe(font.id);
    }

    const customId = "7432f752-8615-4708-a3d6-57bbcb05bdda";
    setCustomFontOptions([
      {
        id: customId,
        label: "My Font",
        family: `MGTUser-${customId}`,
        fileName: `${customId}.otf`,
      },
    ]);
    expect(normalizeBlockFontFamily(customId)).toBe(customId);
    expect(normalizeBlockFontFamily(DEFAULT_BLOCK_FONT_ID)).toBeUndefined();
    expect(normalizeBlockFontFamily("unknown-font")).toBeUndefined();
  });

  it("uses script-appropriate fallback stacks", () => {
    const byId = new Map(
      BUILT_IN_BLOCK_FONTS.map((font) => [font.id, font.cssFamily]),
    );
    expect(byId.get("comic-neue")).toContain("Segoe UI");
    expect(byId.get("yusei-magic")).toContain("Yu Gothic");
    expect(byId.get("zcool-kuaile")).toContain("Microsoft YaHei");
    expect(byId.get("huninn")).toContain("Microsoft JhengHei");
  });

  it("lets the system default option move and favorite like every other font", () => {
    const favoritesFirst = getBlockFontOptions(undefined, "ko", {
      favoriteIds: ["kalam", DEFAULT_BLOCK_FONT_ID],
      orderedIds: ["kalam", DEFAULT_BLOCK_FONT_ID],
      defaultFontId: DEFAULT_BLOCK_FONT_ID,
    });
    expect(favoritesFirst.slice(0, 2).map((option) => option.id)).toEqual([
      "kalam",
      DEFAULT_BLOCK_FONT_ID,
    ]);

    const freelyOrdered = getBlockFontOptions(undefined, "ko", {
      favoriteIds: [],
      orderedIds: ["kalam", DEFAULT_BLOCK_FONT_ID],
      defaultFontId: DEFAULT_BLOCK_FONT_ID,
    });
    expect(freelyOrdered.slice(0, 2).map((option) => option.id)).toEqual([
      "kalam",
      DEFAULT_BLOCK_FONT_ID,
    ]);
  });

  it("resolves inherited blocks and the default option through the designated font without recursion", () => {
    const kalam = BUILT_IN_BLOCK_FONTS.find((font) => font.id === "kalam");
    expect(kalam).toBeDefined();
    setFontPreferences({
      favoriteIds: [],
      orderedIds: [],
      defaultFontId: "kalam",
    });

    expect(resolveBlockFontFamily(undefined)).toBe(kalam?.cssFamily);
    expect(resolveBlockFontFamily(DEFAULT_BLOCK_FONT_ID)).toBe(
      kalam?.cssFamily,
    );
    expect(getBlockFontOptions()[0]?.cssFamily).toBe(kalam?.cssFamily);

    setFontPreferences({
      favoriteIds: [],
      orderedIds: [],
      defaultFontId: DEFAULT_BLOCK_FONT_ID,
    });
    expect(resolveBlockFontFamily(undefined)).toBe(DEFAULT_BLOCK_FONT_STACK);
  });
});
