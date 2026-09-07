import { describe, expect, it } from "vitest";
import { DEMOTED_BLOCK_FONTS } from "../src/shared/demotedBlockFonts";
import {
  codexFontPresetSchema,
  codexTypesettingOptionsSchema,
  codexTypesettingPreferencesSchema,
} from "../src/shared/codexTypesettingSchemas";
import {
  erasurePlansSchema,
  qualifyJapaneseReading,
  typesettingOutputSchema,
  validateFontGroups,
} from "../src/main/application/codexTypesettingValidation";
import { buildCodexTypesetPage } from "../src/main/application/codexTypesettingBlocks";
import type { MangaPage } from "../src/shared/libraryTypes";
import { extractCodexImageTurn } from "../src/main/codexAppServerImageResult";
import { StartAnalysisRequestSchema } from "../src/shared/ipcJobSchemas";
import {
  createCodexTypesettingPreferences,
  resolveCodexTypesettingOptions,
} from "../src/shared/codexTypesettingDefaults";

const bbox = { x: 100, y: 100, w: 100, h: 200 };
function region(id: string, sourceText: string) {
  return {
    id,
    sourceText,
    translatedText: "번역",
    action: "text",
    role: "ordinary",
    direction: "vertical",
    background: "white",
    sourceBbox: bbox,
    renderBbox: bbox,
    reason: "dialogue",
  };
}

describe("Astra typesetting contracts", () => {
  it("migrates preserved optional fonts without changing preset notes or erasing colliding rows", () => {
    const preferences = createCodexTypesettingPreferences("ko");
    preferences.presets[0].fonts = DEMOTED_BLOCK_FONTS.map((font) => ({
      fontId: font.id,
      purpose: `${font.label} 사용 의도`,
    }));
    const migrated = codexTypesettingPreferencesSchema.parse(preferences);
    expect(migrated.presets[0].fonts).toEqual(
      DEMOTED_BLOCK_FONTS.map((font) => ({
        fontId: font.customId,
        purpose: `${font.label} 사용 의도`,
      })),
    );
    expect(migrated.selectedPresetId).toBe(preferences.selectedPresetId);
    expect(migrated.presets[0].name).toBe(preferences.presets[0].name);
    expect(codexTypesettingPreferencesSchema.parse(migrated)).toEqual(migrated);
    expect(
      codexTypesettingOptionsSchema.parse({
        version: 1,
        preset: preferences.presets[0],
      }).preset,
    ).toEqual(migrated.presets[0]);
    const collision = {
      ...preferences.presets[0],
      fonts: [
        preferences.presets[0].fonts[0],
        {
          fontId: DEMOTED_BLOCK_FONTS[0].customId,
          purpose: "별도로 작성한 용도",
        },
      ],
    };
    expect(codexFontPresetSchema.parse(collision)).toEqual(collision);
    expect(preferences.presets[0].fonts[0].fontId).toBe(
      DEMOTED_BLOCK_FONTS[0].id,
    );
  });
  it("defaults old preferences and requests to generated SFX and validates the selected mode", () => {
    const defaults = createCodexTypesettingPreferences("ko");
    const { sfxRendering: omitted, ...legacy } = defaults;
    expect(omitted).toBe("image");
    expect(codexTypesettingPreferencesSchema.parse(legacy).sfxRendering).toBe(
      "image",
    );
    const request = { version: 1, preset: defaults.presets[0] };
    expect(codexTypesettingOptionsSchema.parse(request).sfxRendering).toBe(
      "image",
    );
    expect(
      codexTypesettingOptionsSchema.parse({ ...request, sfxRendering: "font" })
        .sfxRendering,
    ).toBe("font");
    expect(
      codexTypesettingOptionsSchema.safeParse({
        ...request,
        sfxRendering: "auto",
      }).success,
    ).toBe(false);
  });
  it.each(["pending", "all", "single-page", "page-set"])(
    "preserves shared translation options and strict validation for %s",
    (runMode) => {
      const pageId = "d5ba4d7a-2bdd-4669-ae8f-adf5948f54ad";
      const request = {
        chapterId: "b6ed540b-8d23-438e-82cf-9f12e18571f7",
        runMode,
        ...(runMode === "single-page" ? { pageId } : {}),
        ...(runMode === "page-set" ? { pageIds: [pageId] } : {}),
        blockMode: "auto",
        collectPageContext: true,
        cumulativeContextDetail: "balanced",
        naturalTextLayout: true,
        codexTypesetting: {
          version: 1,
          sfxRendering: "image",
          preset: createCodexTypesettingPreferences("ko").presets[0],
        },
        autoFontMatching: false,
        aiFontSizeMatching: false,
        fontSizeAutoFit: false,
        completionWorkflow: "erase-original",
      };
      expect(StartAnalysisRequestSchema.parse(request)).toEqual(request);
      expect(
        StartAnalysisRequestSchema.safeParse({ ...request, arbitrary: true })
          .success,
      ).toBe(false);
      expect(
        StartAnalysisRequestSchema.safeParse({
          ...request,
          naturalTextLayout: "yes",
        }).success,
      ).toBe(false);
    },
  );

  it("sends the crop-erasure contract to the server and rejects out-of-crop edits", () => {
    const contract = typesettingOutputSchema("erase-preview");
    expect(JSON.stringify(contract)).toContain('"erasePolygons"');
    expect(JSON.stringify(contract)).not.toContain('"translatedText"');
    const commit = JSON.stringify(typesettingOutputSchema("erase-page-1"));
    expect(commit).toContain('"unresolvedRegionIds"');
    expect(commit).toContain('"sha256"');
    expect(commit).not.toContain('"erasePolygons"');
    const plan = {
      regionId: "page:r1",
      erasePolygons: [
        [
          { x: 0, y: 0 },
          { x: 1000, y: 0 },
          { x: 0, y: 1000 },
        ],
      ],
      background: "artwork",
      reason: "preserve gaps between letters",
    };
    expect(erasurePlansSchema.safeParse({ regions: [plan] }).success).toBe(
      true,
    );
    plan.erasePolygons[0][1].x = 1001;
    expect(erasurePlansSchema.safeParse({ regions: [plan] }).success).toBe(
      false,
    );
    expect(
      erasurePlansSchema.safeParse({
        regions: [{ ...plan, erasePolygons: [] }],
      }).success,
    ).toBe(true);
  });

  it("keeps blind image readback separate from source reading and rejects unknown stages", () => {
    const contract = JSON.stringify(typesettingOutputSchema("readback-page-1"));
    expect(contract).toContain('"text"');
    expect(contract).not.toContain('"sourceText"');
    expect(() => typesettingOutputSchema("unregistered-stage")).toThrow(
      "Unknown typesetting stage",
    );
  });

  it("preserves standalone numbers and punctuation while allowing meaningful short Japanese", () => {
    const reading = qualifyJapaneseReading(
      {
        unreadableRegions: [],
        ownedReadability: "readable",
        contextReadability: "absent",
        readabilityReason: "",
        summary: "",
        regions: [
          region("a", "97"),
          region("b", "……"),
          region("c", "え？"),
          region("d", "10歳"),
          region("e", "한국어 漢字"),
        ],
      },
      "page",
    );
    expect(reading.regions.map((item) => item.action)).toEqual([
      "keep",
      "keep",
      "text",
      "text",
      "keep",
    ]);
  });

  it("requires a complete non-overlapping source-family partition", () => {
    const member = (regionId: string) => ({
      regionId,
      bold: false,
      italic: false,
    });
    const group = {
      id: "family",
      description: "same family",
      members: [member("a"), member("b")],
    };
    expect(() => validateFontGroups([group], ["a", "b"])).not.toThrow();
    expect(() => validateFontGroups([group], ["a", "b", "c"])).toThrow();
    expect(() =>
      validateFontGroups(
        [{ ...group, members: [member("a"), member("a")] }],
        ["a", "b"],
      ),
    ).toThrow();
  });

  it("limits each preset independently and rejects duplicate font slots", () => {
    const preset = {
      id: "a",
      name: "custom",
      fonts: Array.from({ length: 10 }, (_, i) => ({
        fontId: `custom-${i}`,
        purpose: "",
      })),
    };
    expect(codexFontPresetSchema.safeParse(preset).success).toBe(true);
    expect(
      codexFontPresetSchema.safeParse({
        ...preset,
        fonts: [...preset.fonts, { fontId: "extra", purpose: "" }],
      }).success,
    ).toBe(false);
    expect(
      codexFontPresetSchema.safeParse({
        ...preset,
        fonts: [preset.fonts[0], preset.fonts[0]],
      }).success,
    ).toBe(false);
  });

  it("keeps the family consistent while preserving bold and independent render geometry", () => {
    const reading = qualifyJapaneseReading(
      {
        unreadableRegions: [],
        ownedReadability: "readable",
        contextReadability: "absent",
        readabilityReason: "",
        summary: "",
        regions: [region("a", "あ"), region("b", "え")],
      },
      "page",
    );
    const page: MangaPage = {
      id: "page",
      blocks: [],
      width: 1000,
      height: 1500,
      name: "001.png",
      imagePath: "source.png",
      dataUrl: "",
      analysisStatus: "idle",
      createdAt: "",
      updatedAt: "",
    };
    const plan = {
      groups: [
        {
          id: "family",
          description: "",
          members: [
            { regionId: "page:a", bold: false, italic: false },
            { regionId: "page:b", bold: true, italic: false },
          ],
        },
      ],
      fonts: [{ groupId: "family", fontId: "custom-font" }],
    };
    const layouts = reading.regions.map((item) => ({
      regionId: item.id,
      translatedText: "안녕\n친구야",
      renderBbox: { ...bbox, w: 230 },
      fontSizePx: 37,
      lineHeight: 1.2,
      rotationDeg: 0,
      outlineWidthPx: 0,
      textColor: "#000000",
      outlineColor: "#ffffff",
      textAlign: "center" as const,
      direction: "horizontal" as const,
    }));
    const result = buildCodexTypesetPage(
      page,
      reading,
      plan,
      layouts,
      (id) => id,
    );
    expect(result.blocks.map((block) => block.fontFamily)).toEqual([
      "custom-font",
      "custom-font",
    ]);
    expect(result.blocks.map((block) => block.bold)).toEqual([false, true]);
    expect(result.blocks[0]).toMatchObject({
      bbox,
      renderBbox: { ...bbox, w: 230 },
      autoFitText: false,
      fontSizePx: 37,
      fontSizeIntent: "manual",
    });
  });

  it("requires an actual completed image item rather than a text success claim", () => {
    expect(() =>
      extractCodexImageTurn(
        {
          params: {
            turn: { items: [{ type: "agentMessage", text: "Image saved" }] },
          },
        },
        "thread",
        "turn",
      ),
    ).toThrow();
    const result = extractCodexImageTurn(
      {
        params: {
          item: {
            id: "image",
            type: "imageGeneration",
            status: "completed",
            result: "aGVsbG8=",
          },
        },
      },
      "thread",
      "turn",
    );
    expect(JSON.parse(result.text).result).toBe("aGVsbG8=");
  });
});

it("resolves delegated execution from saved preferences and preserves explicit erasure OFF", () => {
  const defaults = resolveCodexTypesettingOptions(undefined, "ko");
  expect(defaults).toMatchObject({
    version: 1,
    eraseOriginal: true,
    sfxRendering: "image",
  });
  const saved = createCodexTypesettingPreferences("ko");
  const custom = { ...saved.presets[0], id: "custom" };
  expect(
    resolveCodexTypesettingOptions(
      {
        ...saved,
        presets: [saved.presets[0], custom],
        selectedPresetId: "custom",
        eraseOriginal: false,
        sfxRendering: "font",
      },
      "ko",
    ),
  ).toMatchObject({
    preset: custom,
    eraseOriginal: false,
    sfxRendering: "font",
  });
  expect(
    resolveCodexTypesettingOptions(
      { ...saved, selectedPresetId: "missing" },
      "ko",
    ).preset,
  ).toEqual(saved.presets[0]);
});
