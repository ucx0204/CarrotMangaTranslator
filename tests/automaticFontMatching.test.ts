import { describe, expect, it } from "vitest";
import { resolveAutomaticFontDecision } from "../src/main/pipeline/automaticFontMatching";
import type { OverlayItem } from "../src/main/pipeline/types";
import type { AutomaticFontCandidate } from "../src/shared/fontMatchingTypes";
import type { MangaPage } from "../src/shared/libraryTypes";

describe("portable automatic font matching", () => {
  it("keeps ordinary dialogue on one stable work-level Korean body font", () => {
    const first = decide({
      item: makeItem({ ko: "안녕하세요.", textRole: "ordinary" }),
      workTitle: "공작 영애의 계약 결혼",
    });
    const second = decide({
      item: makeItem({ id: 2, ko: "정말이야?", textRole: "ordinary" }),
      workTitle: "공작 영애의 계약 결혼",
    });

    expect(first).toEqual({ fontId: "ridi-batang", slot: "body" });
    expect(second).toEqual(first);
  });

  it("keeps action dialogue on the broadly supported Korean body face", () => {
    const decision = decide({
      item: makeItem({ ko: "전투를 시작한다.", textRole: "ordinary" }),
      workTitle: "던전 헌터 전쟁",
    });

    expect(decision).toEqual({
      fontId: "nanum-barun-gothic",
      slot: "body",
    });
  });

  it("uses one stable cozy body face for the current VRMMO work", () => {
    const decision = decide({
      item: makeItem({
        ko: "오늘도 모험을 시작해 볼까?",
        textRole: "ordinary",
      }),
      workTitle: "슬라임 마스터짱의 VRMMO",
    });

    expect(decision).toEqual({
      fontId: "seoul-namsan",
      slot: "body",
    });
  });

  it.each([
    ["쾅!", "dohyeon", "strong-impact"],
    ["휙", "start-over", "sharp-motion"],
    ["두근두근", "cafe24-gowoonbam", "soft-emotion"],
    ["띠용", "jua", "comic-reaction"],
    ["스산…", "chosun-gungseo", "ambient-eerie"],
  ] as const)(
    "maps the detected Korean SFX %s to one deterministic semantic slot",
    (translatedText, fontId, slot) => {
      const decision = decide({
        item: makeItem({ ko: translatedText, textRole: "sound" }),
        workTitle: "평범한 이야기",
      });

      expect(decision).toEqual({ fontId, slot });
    },
  );

  it("uses geometry only as a stable fallback when SFX text has no known cue", () => {
    const item = makeItem({
      ko: "크르릉",
      textRole: "sound",
      angle: -16,
      bbox: { x: 100, y: 100, w: 120, h: 260 },
    });

    const first = decide({ item, workTitle: "평범한 이야기" });
    const second = decide({ item, workTitle: "평범한 이야기" });

    expect(first).toEqual({ fontId: "start-over", slot: "sharp-motion" });
    expect(second).toEqual(first);
  });

  it.each([
    ["ビリリ！", "찌릿!", "gaegu", "sharp-motion"],
    ["こほん", "큼큼", "jua", "comic-reaction"],
    ["モシャ", "냠냠", "jua", "comic-reaction"],
  ] as const)(
    "maps source-image effect wording %s to an appropriate Korean slot",
    (sourceText, translatedText, fontId, slot) => {
      const decision = decide({
        item: makeItem({
          jp: sourceText,
          sourceText,
          ko: translatedText,
          translatedText,
          textRole: "sound",
        }),
        workTitle: "슬라임 마스터짱의 VRMMO",
      });

      expect(decision).toEqual({ fontId, slot });
    },
  );

  it("uses a weak title prior without changing a strong SFX meaning", () => {
    const romance = decide({
      item: makeItem({ ko: "두근", textRole: "sound" }),
      workTitle: "황녀님의 로맨스",
    });
    const action = decide({
      item: makeItem({ ko: "두근", textRole: "sound" }),
      workTitle: "던전 헌터 전쟁",
    });

    expect(romance).toEqual({
      fontId: "cafe24-gowoonbam",
      slot: "soft-emotion",
    });
    expect(action).toEqual(romance);
  });

  it.each([
    ["ko-KR", "nanum-barun-gothic"],
    ["en-US", "comic-neue"],
    ["ja-JP", "yusei-magic"],
    ["zh-CN", "zcool-xiaowei"],
    ["zh-TW", "lxgw-wenkai-tc"],
  ] as const)(
    "chooses the %s built-in body catalog",
    (targetLanguage, fontId) => {
      const decision = decide({
        item: makeItem({
          ko: "ordinary dialogue",
          translatedText: "ordinary dialogue",
        }),
        targetLanguage,
      });

      expect(decision).toEqual({ fontId, slot: "body" });
    },
  );

  it.each([
    ["ko", "dohyeon"],
    ["en", "bangers"],
    ["ja", "dela-gothic-one"],
    ["zh-Hans", "zcool-qingke-huangyou"],
    ["zh-Hant", "lxgw-marker-gothic"],
  ] as const)(
    "chooses the %s built-in SFX catalog while reading the Japanese source cue",
    (targetLanguage, fontId) => {
      const decision = decide({
        item: makeItem({
          jp: "ドン！",
          sourceText: "ドン！",
          ko: "translated impact",
          translatedText: "translated impact",
          textRole: "sound",
        }),
        targetLanguage,
      });

      expect(decision).toEqual({ fontId, slot: "strong-impact" });
    },
  );

  it("returns no override for an unsupported output language", () => {
    expect(
      decide({
        item: makeItem({ translatedText: "Bonjour" }),
        targetLanguage: "fr-FR",
      }),
    ).toBeUndefined();
  });

  it("uses a conservative user default for body text when locale and glyphs match", () => {
    const decision = decide({
      item: makeItem({ translatedText: "Hello there", ko: "Hello there" }),
      targetLanguage: "en",
      candidates: [
        makeCandidate({
          fontId: "custom-default",
          label: "My Regular",
          supportedLocales: ["en"],
          defaultFont: true,
        }),
      ],
    });

    expect(decision).toEqual({ fontId: "custom-default", slot: "body" });
  });

  it("keeps the work body font stable instead of switching on one block's punctuation", () => {
    const bodyWithoutSmartPunctuation = makeCandidate({
      fontId: "incomplete-body",
      label: "Incomplete Body",
      supportedLocales: ["en"],
      unicodeRanges: [[0x20, 0x7e]],
      defaultFont: true,
    });

    const plain = decide({
      item: makeItem({ translatedText: "Hello there", ko: "Hello there" }),
      targetLanguage: "en",
      candidates: [bodyWithoutSmartPunctuation],
    });
    const punctuated = decide({
      item: makeItem({
        id: 2,
        translatedText: "Wait… really?",
        ko: "Wait… really?",
      }),
      targetLanguage: "en",
      candidates: [bodyWithoutSmartPunctuation],
    });

    expect(plain).toEqual({ fontId: "comic-neue", slot: "body" });
    expect(punctuated).toEqual(plain);
  });

  it("checks one page-wide body corpus before choosing a user font", () => {
    const incompleteUserBody = makeCandidate({
      fontId: "custom-body",
      label: "My Regular",
      supportedLocales: ["en"],
      unicodeRanges: [
        [0, 0xe8],
        [0xea, 0x10ffff],
      ],
      defaultFont: true,
    });
    const bundledFallback = makeCandidate({
      source: "built-in",
      fontId: "comic-neue",
      label: "Comic Neue",
      supportedLocales: ["en"],
    });
    const candidates = [incompleteUserBody, bundledFallback];
    const bodyTextCorpus = "Hello there\nMeet Café";

    const first = decide({
      item: makeItem({ translatedText: "Hello there", ko: "Hello there" }),
      targetLanguage: "en",
      bodyTextCorpus,
      candidates,
    });
    const second = decide({
      item: makeItem({ translatedText: "Meet Café", ko: "Meet Café" }),
      targetLanguage: "en",
      bodyTextCorpus,
      candidates,
    });

    expect(first).toEqual({ fontId: "comic-neue", slot: "body" });
    expect(second).toEqual(first);
  });

  it("does not use a user font from a different locale", () => {
    const decision = decide({
      item: makeItem({ translatedText: "Hello there", ko: "Hello there" }),
      targetLanguage: "en",
      candidates: [
        makeCandidate({
          fontId: "korean-default",
          supportedLocales: ["ko"],
          defaultFont: true,
        }),
      ],
    });

    expect(decision).toEqual({ fontId: "comic-neue", slot: "body" });
  });

  it("falls back when even one translated glyph is missing", () => {
    const decision = decide({
      item: makeItem({
        sourceText: "ドン",
        translatedText: "BOOM🙂",
        textRole: "sound",
      }),
      targetLanguage: "en",
      candidates: [
        makeCandidate({
          fontId: "custom-heavy",
          label: "Impact Heavy",
          supportedLocales: ["en"],
          unicodeRanges: [[0x20, 0x7e]],
          weight: 900,
        }),
      ],
    });

    expect(decision).toEqual({
      fontId: "bangers",
      slot: "strong-impact",
    });
  });

  it("admits a user SFX font only with clear expressive evidence", () => {
    const expressive = decide({
      item: makeItem({
        sourceText: "ドン",
        translatedText: "BOOM!",
        textRole: "sound",
      }),
      targetLanguage: "en",
      candidates: [
        makeCandidate({
          fontId: "custom-heavy",
          label: "Plain",
          supportedLocales: ["en"],
          weight: 900,
        }),
      ],
    });
    const uncertain = decide({
      item: makeItem({
        sourceText: "ドン",
        translatedText: "BOOM!",
        textRole: "sound",
      }),
      targetLanguage: "en",
      candidates: [
        makeCandidate({
          fontId: "custom-regular",
          label: "Plain Regular",
          supportedLocales: ["en"],
          favorite: true,
        }),
      ],
    });

    expect(expressive).toEqual({
      fontId: "custom-heavy",
      slot: "strong-impact",
    });
    expect(uncertain).toEqual({
      fontId: "bangers",
      slot: "strong-impact",
    });
  });

  it("admits an uppercase-only user SFX font from exact glyph coverage", () => {
    const decision = decide({
      item: makeItem({
        sourceText: "ドン",
        translatedText: "BOOM!",
        textRole: "sound",
      }),
      targetLanguage: "en",
      candidates: [
        makeCandidate({
          fontId: "uppercase-impact",
          label: "Impact Heavy",
          supportedLocales: [],
          unicodeRanges: [
            [0x21, 0x21],
            [0x41, 0x5a],
          ],
          weight: 900,
        }),
      ],
    });

    expect(decision).toEqual({
      fontId: "uppercase-impact",
      slot: "strong-impact",
    });
  });

  it("falls back to another bundled SFX font when the preferred face misses punctuation", () => {
    const decision = decide({
      item: makeItem({
        sourceText: "スッ",
        translatedText: "슥…",
        textRole: "sound",
      }),
      targetLanguage: "ko",
      candidates: [
        makeCandidate({
          source: "built-in",
          fontId: "start-over",
          label: "다시 시작해",
          supportedLocales: ["ko"],
          unicodeRanges: [
            [0x21, 0x7e],
            [0xac00, 0xd7a3],
          ],
        }),
        makeCandidate({
          source: "built-in",
          fontId: "dohyeon",
          label: "도현체",
          supportedLocales: ["ko"],
          unicodeRanges: [[0, 0x10ffff]],
        }),
      ],
    });

    expect(decision).toEqual({
      fontId: "dohyeon",
      slot: "sharp-motion",
    });
  });

  it("carries a condensed font metric into line-layout measurement only", () => {
    const decision = decide({
      item: makeItem({
        sourceText: "ドン",
        translatedText: "BOOM!",
        textRole: "sound",
      }),
      targetLanguage: "en",
      candidates: [
        makeCandidate({
          fontId: "condensed-impact",
          label: "Impact Heavy",
          supportedLocales: [],
          width: 3,
          weight: 900,
        }),
      ],
    });

    expect(decision).toEqual({
      fontId: "condensed-impact",
      slot: "strong-impact",
      fontMetricWidthScale: 0.75,
    });
  });

  it("is independent of candidate input order and uses preference rank as a tie-break", () => {
    const preferred = makeCandidate({
      fontId: "custom-preferred",
      label: "Comic Pop",
      supportedLocales: ["en"],
      preferenceRank: 2,
    });
    const later = makeCandidate({
      fontId: "custom-later",
      label: "Comic Pop",
      supportedLocales: ["en"],
      preferenceRank: 8,
    });
    const item = makeItem({
      sourceText: "えっ",
      translatedText: "Oops!",
      textRole: "sound",
    });

    const forward = decide({
      item,
      targetLanguage: "en",
      candidates: [later, preferred],
    });
    const reversed = decide({
      item,
      targetLanguage: "en",
      candidates: [preferred, later],
    });

    expect(forward).toEqual({
      fontId: "custom-preferred",
      slot: "comic-reaction",
    });
    expect(reversed).toEqual(forward);
  });

  it("uses favorite only as a weak bonus between already-qualified candidates", () => {
    const item = makeItem({
      sourceText: "えっ",
      translatedText: "Oops!",
      textRole: "sound",
    });
    const decision = decide({
      item,
      targetLanguage: "en",
      candidates: [
        makeCandidate({
          fontId: "not-favorite",
          label: "Comic Pop",
          supportedLocales: ["en"],
          preferenceRank: 0,
        }),
        makeCandidate({
          fontId: "favorite",
          label: "Comic Pop",
          supportedLocales: ["en"],
          favorite: true,
          preferenceRank: 10,
        }),
      ],
    });

    expect(decision?.fontId).toBe("favorite");
  });
});

function decide({
  item,
  workTitle,
  targetLanguage = "ko",
  bodyTextCorpus,
  candidates,
}: {
  item: OverlayItem;
  workTitle?: string;
  targetLanguage?: string;
  bodyTextCorpus?: string;
  candidates?: readonly AutomaticFontCandidate[];
}) {
  return resolveAutomaticFontDecision({
    item,
    page: makePage(),
    workTitle,
    targetLanguage,
    bodyTextCorpus,
    candidates,
  });
}

function makeCandidate(
  patch: Partial<AutomaticFontCandidate>,
): AutomaticFontCandidate {
  return {
    source: "custom",
    fontId: "custom-font",
    label: "Regular",
    supportedLocales: ["ko"],
    unicodeRanges: [[0, 0x10ffff]],
    weight: 400,
    width: 5,
    italic: false,
    serif: false,
    favorite: false,
    defaultFont: false,
    preferenceRank: 0,
    ...patch,
  };
}

function makeItem(patch: Partial<OverlayItem>): OverlayItem {
  return {
    id: 1,
    type: "nonsolid",
    textRole: "ordinary",
    bbox: { x: 100, y: 100, w: 200, h: 100 },
    jp: "原文",
    ko: "번역",
    confidence: 1,
    ...patch,
  };
}

function makePage(): MangaPage {
  return {
    id: "page-1",
    name: "001.jpg",
    imagePath: "001.jpg",
    dataUrl: "",
    width: 1000,
    height: 1500,
    blocks: [],
    analysisStatus: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}
