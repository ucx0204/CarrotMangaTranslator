import { describe, expect, it } from "vitest";
import {
  BUILT_IN_BLOCK_FONTS,
  DEFAULT_BLOCK_FONT_ID,
  DEFAULT_BLOCK_FONT_STACK,
  getPrioritizedBuiltInBlockFonts,
  isBuiltInBlockFontId,
  isRetiredBuiltInBlockFontId,
} from "../src/shared/blockFontCatalog";
import type { UiLocale } from "../src/shared/uiLocales";
import {
  createBlockFontCatalog,
  DEFAULT_BLOCK_FONT_CATALOG,
  getBlockFontOptions,
  normalizeBlockFontFamily,
  resolveBlockFontFamily,
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
    "dohyeon",
    "ridi-batang",
    "cafe24-gowoonbam",
    "start-over",
    "jua",
    "gaegu",
    "black-and-white-picture",
    "black-han-sans",
    "gasoek-one",
    "kirang-haerang",
    "nanum-brush-script",
    "single-day",
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
const FIRST_KOREAN_FONT_ADDITION_IDS = [
  "dohyeon",
  "ridi-batang",
  "cafe24-gowoonbam",
  "start-over",
  "jua",
  "gaegu",
] as const;
const SFX_KOREAN_FONT_ADDITION_IDS = [
  "black-and-white-picture",
  "black-han-sans",
  "gasoek-one",
  "kirang-haerang",
  "nanum-brush-script",
  "single-day",
] as const;
const ADDED_KOREAN_FONT_IDS = [
  ...FIRST_KOREAN_FONT_ADDITION_IDS,
  ...SFX_KOREAN_FONT_ADDITION_IDS,
] as const;

describe("built-in block font catalog", () => {
  it("contains the expected stable kebab-case IDs for every locale", () => {
    expect(BUILT_IN_BLOCK_FONTS).toHaveLength(45);
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

  it("keeps retired Gugi migration support outside the production catalog", () => {
    expect(BUILT_IN_BLOCK_FONTS.map((font) => font.id)).not.toContain("gugi");
    expect(isRetiredBuiltInBlockFontId("gugi")).toBe(true);
    expect(isBuiltInBlockFontId("gugi")).toBe(false);
    expect(
      getPrioritizedBuiltInBlockFonts("ko").some((font) => font.id === "gugi"),
    ).toBe(false);
  });

  it.each(BASE_LOCALE_ORDER)(
    "keeps Default first and prioritizes the %s group",
    (locale) => {
      const options = getBlockFontOptions(
        DEFAULT_BLOCK_FONT_CATALOG,
        undefined,
        locale,
      );
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

      const expectedIds = EXPECTED_IDS_BY_LOCALE[locale];
      const firstGroupIds = options
        .slice(1, 1 + expectedIds.length)
        .map((option) => option.id);
      expect(firstGroupIds).toEqual(expectedIds);
      expect(options.some((option) => option.id === "gugi")).toBe(false);
    },
  );

  it("keeps user-installed fonts after every built-in group", () => {
    const customId = "7432f752-8615-4708-a3d6-57bbcb05bdda";
    const catalog = createBlockFontCatalog(
      [
        {
          id: customId,
          label: "My Font",
          family: `MGTUser-${customId}`,
          fileName: `${customId}.ttf`,
        },
      ],
      DEFAULT_BLOCK_FONT_CATALOG.preferences,
    );

    const options = getBlockFontOptions(catalog, undefined, "ja");
    expect(options.at(-1)?.id).toBe(customId);
    expect(options).toHaveLength(BUILT_IN_BLOCK_FONTS.length + 2);
  });

  it("inserts newly bundled Korean fonts into a saved pre-addition full order", () => {
    const customId = "7432f752-8615-4708-a3d6-57bbcb05bdda";
    const catalog = createBlockFontCatalog(
      [
        {
          id: customId,
          label: "My Font",
          family: `MGTUser-${customId}`,
          fileName: `${customId}.ttf`,
        },
      ],
      {
        favoriteIds: [],
        orderedIds: [
          DEFAULT_BLOCK_FONT_ID,
          ...BUILT_IN_BLOCK_FONTS.filter(
            (font) => !ADDED_KOREAN_FONT_IDS.some((newId) => newId === font.id),
          ).map((font) => font.id),
          customId,
        ],
        defaultFontId: DEFAULT_BLOCK_FONT_ID,
      },
    );

    const optionIds = getBlockFontOptions(catalog, undefined, "ko").map(
      (option) => option.id,
    );
    expect(
      optionIds.slice(
        optionIds.indexOf("seoul-hangang") + 1,
        optionIds.indexOf("comic-neue"),
      ),
    ).toEqual(ADDED_KOREAN_FONT_IDS);
    expect(optionIds.at(-1)).toBe(customId);
  });

  it("inserts the SFX expansion into a saved post-first-addition full order", () => {
    const customId = "7432f752-8615-4708-a3d6-57bbcb05bdda";
    const catalog = createBlockFontCatalog(
      [
        {
          id: customId,
          label: "My Font",
          family: `MGTUser-${customId}`,
          fileName: `${customId}.ttf`,
        },
      ],
      {
        favoriteIds: [],
        orderedIds: [
          DEFAULT_BLOCK_FONT_ID,
          ...BUILT_IN_BLOCK_FONTS.filter(
            (font) =>
              !SFX_KOREAN_FONT_ADDITION_IDS.some((newId) => newId === font.id),
          ).map((font) => font.id),
          customId,
        ],
        defaultFontId: DEFAULT_BLOCK_FONT_ID,
      },
    );

    const optionIds = getBlockFontOptions(catalog, undefined, "ko").map(
      (option) => option.id,
    );
    expect(
      optionIds.slice(
        optionIds.indexOf("gaegu") + 1,
        optionIds.indexOf("comic-neue"),
      ),
    ).toEqual(SFX_KOREAN_FONT_ADDITION_IDS);
    expect(optionIds.at(-1)).toBe(customId);
  });

  it("normalizes every built-in and registered custom font ID", () => {
    for (const font of BUILT_IN_BLOCK_FONTS) {
      expect(
        normalizeBlockFontFamily(font.id, DEFAULT_BLOCK_FONT_CATALOG),
      ).toBe(font.id);
    }
    expect(
      normalizeBlockFontFamily("gugi", DEFAULT_BLOCK_FONT_CATALOG),
    ).toBeUndefined();

    const customId = "7432f752-8615-4708-a3d6-57bbcb05bdda";
    const catalog = createBlockFontCatalog(
      [
        {
          id: customId,
          label: "My Font",
          family: `MGTUser-${customId}`,
          fileName: `${customId}.otf`,
        },
      ],
      DEFAULT_BLOCK_FONT_CATALOG.preferences,
    );
    expect(normalizeBlockFontFamily(customId, catalog)).toBe(customId);
    expect(
      normalizeBlockFontFamily(DEFAULT_BLOCK_FONT_ID, catalog),
    ).toBeUndefined();
    expect(normalizeBlockFontFamily("unknown-font", catalog)).toBeUndefined();
  });

  it("removes retired Gugi preferences and resolves legacy blocks through the default", () => {
    const catalog = createBlockFontCatalog([], {
      favoriteIds: ["gugi", "kalam"],
      orderedIds: ["gugi", "kalam"],
      defaultFontId: "gugi",
    });

    expect(catalog.preferences).toEqual({
      favoriteIds: ["kalam"],
      orderedIds: ["kalam"],
      defaultFontId: DEFAULT_BLOCK_FONT_ID,
    });
    expect(
      getBlockFontOptions(catalog).some((font) => font.id === "gugi"),
    ).toBe(false);
    expect(resolveBlockFontFamily("gugi", catalog)).toBe(
      DEFAULT_BLOCK_FONT_STACK,
    );
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
    const favoritesFirst = getBlockFontOptions(
      createBlockFontCatalog([], {
        favoriteIds: ["kalam", DEFAULT_BLOCK_FONT_ID],
        orderedIds: ["kalam", DEFAULT_BLOCK_FONT_ID],
        defaultFontId: DEFAULT_BLOCK_FONT_ID,
      }),
      undefined,
      "ko",
    );
    expect(favoritesFirst.slice(0, 2).map((option) => option.id)).toEqual([
      "kalam",
      DEFAULT_BLOCK_FONT_ID,
    ]);

    const freelyOrdered = getBlockFontOptions(
      createBlockFontCatalog([], {
        favoriteIds: [],
        orderedIds: ["kalam", DEFAULT_BLOCK_FONT_ID],
        defaultFontId: DEFAULT_BLOCK_FONT_ID,
      }),
      undefined,
      "ko",
    );
    expect(freelyOrdered.slice(0, 2).map((option) => option.id)).toEqual([
      "kalam",
      DEFAULT_BLOCK_FONT_ID,
    ]);
  });

  it("resolves inherited blocks and the default option through the designated font without recursion", () => {
    const kalam = BUILT_IN_BLOCK_FONTS.find((font) => font.id === "kalam");
    expect(kalam).toBeDefined();
    const catalog = createBlockFontCatalog([], {
      favoriteIds: [],
      orderedIds: [],
      defaultFontId: "kalam",
    });

    expect(resolveBlockFontFamily(undefined, catalog)).toBe(kalam?.cssFamily);
    expect(resolveBlockFontFamily(DEFAULT_BLOCK_FONT_ID, catalog)).toBe(
      kalam?.cssFamily,
    );
    expect(getBlockFontOptions(catalog)[0]?.cssFamily).toBe(kalam?.cssFamily);

    expect(resolveBlockFontFamily(undefined, DEFAULT_BLOCK_FONT_CATALOG)).toBe(
      DEFAULT_BLOCK_FONT_STACK,
    );
  });

  it("keeps independent immutable catalogs from leaking custom fonts or defaults", () => {
    const customId = "7432f752-8615-4708-a3d6-57bbcb05bdda";
    const customCatalog = createBlockFontCatalog(
      [
        {
          id: customId,
          label: "Isolated Font",
          family: "MGTUser-Isolated",
          fileName: `${customId}.otf`,
        },
      ],
      {
        favoriteIds: [customId],
        orderedIds: [customId],
        defaultFontId: customId,
      },
    );
    const otherCatalog = createBlockFontCatalog([], {
      favoriteIds: [],
      orderedIds: [],
      defaultFontId: "kalam",
    });

    expect(resolveBlockFontFamily(undefined, customCatalog)).toContain(
      "MGTUser-Isolated",
    );
    expect(normalizeBlockFontFamily(customId, otherCatalog)).toBeUndefined();
    expect(resolveBlockFontFamily(undefined, otherCatalog)).toContain("Kalam");
    expect(Object.isFrozen(customCatalog)).toBe(true);
    expect(Object.isFrozen(customCatalog.customFonts)).toBe(true);
    expect(Object.isFrozen(customCatalog.preferences.favoriteIds)).toBe(true);
  });
});
