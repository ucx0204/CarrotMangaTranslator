import { describe, expect, it } from "vitest";
import type { TranslationOptions } from "../src/main/appSettings";
import {
  FONT_MATCHING_V2_MODEL_VERSION,
  FONT_MATCHING_V2_RENDERER_HASH,
  resolveFontMatchingV2CatalogVersion,
} from "../src/main/pipeline/automaticFontMatchingV2";
import { overlayItemToBlock } from "../src/main/pipeline/overlayItems";
import { buildTranslatedPageResult } from "../src/main/pipeline/translatedPageResult";
import type { OverlayItem } from "../src/main/pipeline/types";
import type { AutomaticFontCandidate } from "../src/shared/fontMatchingTypes";
import type { WorkTypographyProfileV2 } from "../src/shared/fontMatchingProfileTypes";
import type { MangaPage } from "../src/shared/libraryTypes";
import { makeAutomaticFontCandidate } from "./helpers/automaticFontCandidate";

const { normalizeItems } =
  require("../src/main/runtime/overlay-parser.cjs") as {
    normalizeItems: (parsed: unknown) => OverlayItem[];
  };

describe("translated page Font Matching V2 coordination", () => {
  it("does not reuse profile fonts without verified pixel inference", () => {
    const page = makePage();
    const candidates = makeCandidates();
    const profile = makeProfile(candidates);
    const items = [
      makeSfxItem(1, "ドン!", "힣"),
      makeSfxItem(2, " ドン ", "가"),
    ];
    const automaticFont = {
      enabled: true,
      targetLanguage: "ko",
      workId: "work-1",
      chapterId: "chapter-1",
      profile,
      candidates,
    } as const;

    const independentSecond = overlayItemToBlock(
      items[1],
      page,
      1,
      "run-1",
      undefined,
      undefined,
      automaticFont,
    );
    expect(independentSecond.fontFamily).toBeUndefined();

    const result = buildTranslatedPageResult({
      jobId: "run-1",
      page,
      pageOptions: makeTranslationOptions({
        targetLanguage: "ko",
        autoFontMatching: true,
        fontMatchingWorkId: "work-1",
        fontMatchingChapterId: "chapter-1",
        fontMatchingProfile: profile,
        fontMatchingCandidates: candidates,
      }),
      items,
      soundDroppedCount: 0,
      validationDroppedCount: 0,
      validationReasons: {},
      contextWarnings: [],
    });

    expect(result.page.blocks).toHaveLength(2);
    expect(result.page.blocks.map((block) => block.id)).toEqual([
      "page-1-run-1-block-1",
      "page-1-run-1-block-2",
    ]);
    expect(result.page.blocks.map((block) => block.fontFamily)).toEqual([
      undefined,
      undefined,
    ]);
  });

  it("keeps the page when block-local font matching evidence is invalid", () => {
    const duplicate = builtIn("dohyeon", [[0, 0x10ffff]]);
    const result = buildTranslatedPageResult({
      jobId: "run-1",
      page: makePage(),
      pageOptions: makeTranslationOptions({
        targetLanguage: "ko",
        autoFontMatching: true,
        fontMatchingCandidates: [duplicate, { ...duplicate }],
      }),
      items: [makeSfxItem(1, "ドン", "쾅")],
      soundDroppedCount: 0,
      validationDroppedCount: 0,
      validationReasons: {},
      contextWarnings: [],
    });

    expect(result.kind).toBe("completed");
    expect(result.page.blocks).toHaveLength(1);
    expect(result.page.blocks[0].fontFamily).toBeUndefined();
  });

  it("does not enforce profile palette state without verified pixel inference", () => {
    const page = makePage();
    const candidates = [
      builtIn("dohyeon", [[0xac00, 0xac00]]),
      builtIn("start-over", [[0xac00, 0xac01]]),
      builtIn("jua", [[0xac00, 0xd7a3]], { defaultFont: true }),
    ];
    const profile = makeProfile(candidates, 2);
    const items = [
      makeSfxItem(1, "ドン", "힣"),
      makeSfxItem(2, "シュッ", "각"),
      makeSfxItem(3, "バン", "가"),
    ];

    const independentThird = overlayItemToBlock(
      items[2],
      page,
      2,
      "run-1",
      undefined,
      undefined,
      {
        enabled: true,
        targetLanguage: "ko",
        workId: "work-1",
        chapterId: "chapter-1",
        profile,
        candidates,
      },
    );
    expect(independentThird.fontFamily).toBeUndefined();

    const result = buildTranslatedPageResult({
      jobId: "run-1",
      page,
      pageOptions: makeTranslationOptions({
        targetLanguage: "ko",
        autoFontMatching: true,
        fontMatchingWorkId: "work-1",
        fontMatchingChapterId: "chapter-1",
        fontMatchingProfile: profile,
        fontMatchingCandidates: candidates,
      }),
      items,
      soundDroppedCount: 0,
      validationDroppedCount: 0,
      validationReasons: {},
      contextWarnings: [],
    });

    expect(result.page.blocks.map((block) => block.fontFamily)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("carries a parsed explicit accent cluster into page coordination", () => {
    const candidates = makeCandidates();
    const profile = makeProfile(
      candidates,
      candidates.length,
      "aside_balloon_edge",
    );
    const items = normalizeItems({
      items: [
        {
          id: 1,
          type: "nonsolid",
          textRole: "ordinary",
          fontRole: "aside_balloon_edge",
          fontRoleConfidence: 0.98,
          visual_cluster_id: " aside-note-1 ",
          x1: 100,
          y1: 100,
          x2: 300,
          y2: 180,
          jp: "こそ",
          ko: "힣",
        },
        {
          id: 2,
          type: "nonsolid",
          textRole: "ordinary",
          fontRole: "aside_balloon_edge",
          fontRoleConfidence: 0.98,
          visualClusterId: "aside-note-1",
          x1: 100,
          y1: 220,
          x2: 300,
          y2: 300,
          jp: "こそ",
          ko: "가",
        },
      ],
    });

    const result = buildTranslatedPageResult({
      jobId: "run-1",
      page: makePage(),
      pageOptions: makeTranslationOptions({
        targetLanguage: "ko",
        autoFontMatching: true,
        fontMatchingWorkId: "work-1",
        fontMatchingChapterId: "chapter-1",
        fontMatchingProfile: profile,
        fontMatchingCandidates: candidates,
      }),
      items,
      soundDroppedCount: 0,
      validationDroppedCount: 0,
      validationReasons: {},
      contextWarnings: [],
    });

    expect(result.page.blocks.map((block) => block.fontFamily)).toEqual([
      undefined,
      undefined,
    ]);
    expect(result.page.blocks.map((block) => block.visualClusterId)).toEqual([
      "aside-note-1",
      "aside-note-1",
    ]);
  });
});

function makeCandidates(): AutomaticFontCandidate[] {
  return [
    builtIn("dohyeon", [[0xac00, 0xac00]]),
    builtIn("jua", [[0xac00, 0xd7a3]], { defaultFont: true }),
  ];
}

function builtIn(
  fontId: string,
  unicodeRanges: AutomaticFontCandidate["unicodeRanges"],
  overrides: Partial<AutomaticFontCandidate> = {},
): AutomaticFontCandidate {
  return makeAutomaticFontCandidate({
    source: "built-in",
    fontId,
    defaultFont: false,
    unicodeRanges,
    ...overrides,
  });
}

function makeProfile(
  candidates: readonly AutomaticFontCandidate[],
  maxDistinctFonts = candidates.length,
  role: WorkTypographyProfileV2["rolePalettes"][number]["role"] = "sfx_impact",
): WorkTypographyProfileV2 {
  const timestamp = "2026-08-01T00:00:00.000Z";
  return {
    schemaVersion: 2,
    workId: "work-1",
    dialogueAnchor: null,
    narrationAnchor: null,
    thoughtAnchor: null,
    rolePalettes: [
      {
        role,
        allowedFontIds: candidates.map((candidate) => candidate.fontId),
        maxDistinctFonts,
        reuseVisualClusterFont: true,
        evidenceCount: 20,
        confidence: 1,
      },
    ],
    intentionalOverrides: [],
    userLocks: [],
    orientationPolicy: {
      horizontalAllowedFontIds: null,
      verticalAllowedFontIds: null,
      verticalOnlyFontIds: [],
    },
    consistencyPolicy: {
      reuseBodyAnchors: true,
      requireIntentionalOverrideForBodySwitch: true,
      reuseVisualClusterFont: true,
      maxAccentFontsPerRole: 4,
    },
    genrePrior: null,
    evidenceCount: 20,
    confidence: 1,
    catalogVersion: resolveFontMatchingV2CatalogVersion(candidates),
    modelVersion: FONT_MATCHING_V2_MODEL_VERSION,
    rendererHash: FONT_MATCHING_V2_RENDERER_HASH,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function makeSfxItem(
  id: number,
  sourceText: string,
  translatedText: string,
): OverlayItem {
  return {
    id,
    type: "nonsolid",
    textRole: "sound",
    fontRole: "sfx_impact",
    fontRoleConfidence: 0.98,
    bbox: { x: 100, y: 100 + id * 100, w: 200, h: 80 },
    jp: sourceText,
    ko: translatedText,
    sourceText,
    translatedText,
    direction: "horizontal",
    confidence: 1,
  };
}

function makePage(): MangaPage {
  return {
    id: "page-1",
    name: "001.png",
    imagePath: "001.png",
    dataUrl: "",
    width: 1000,
    height: 1400,
    blocks: [],
    analysisStatus: "idle",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}

function makeTranslationOptions(
  overrides: Partial<TranslationOptions>,
): TranslationOptions {
  return overrides as TranslationOptions;
}
