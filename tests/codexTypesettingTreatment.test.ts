import { describe, expect, it, vi } from "vitest";
import {
  applyCodexLayoutTreatment,
  serializeCodexLayoutText,
} from "../src/main/application/codexTypesettingTreatment";
import { buildCodexTypesetPage } from "../src/main/application/codexTypesettingBlocks";
import {
  layoutsSchema,
  typesettingOutputSchema,
} from "../src/main/application/codexTypesettingValidation";
import { inspectGeneratedLettering } from "../src/main/application/codexTypesettingReadback";
import { parseRichText } from "../src/shared/richTextMarkup";
import type {
  CodexChapterPlan,
  CodexTypesettingPorts,
  TypesettingLayout,
} from "../src/main/application/codexTypesettingContracts";
import { runCodexTypesetting } from "../src/main/application/codexTypesettingService";
import type { CodexPageReading } from "../src/shared/codexTypesettingTypes";
import type { MangaPage } from "../src/shared/libraryTypes";

const bounds = { x: 100, y: 100, w: 100, h: 100 };
const reading: CodexPageReading = {
  summary: "",
  regions: [
    {
      id: "r1",
      sourceText: "待って",
      translatedText: "잠깐! 아니…",
      action: "text",
      sourceBbox: bounds,
      renderBbox: bounds,
      role: "ordinary",
      direction: "vertical",
      background: "white",
      reason: "emphasis",
    },
    {
      id: "keep",
      sourceText: "97",
      translatedText: "97",
      action: "keep",
      sourceBbox: { ...bounds, x: 800 },
      renderBbox: { ...bounds, x: 800 },
      role: "ordinary",
      direction: "horizontal",
      background: "white",
      reason: "digits",
    },
  ],
};
const layout: TypesettingLayout = {
  regionId: "r1",
  translatedText: "잠깐! 아니…",
  renderBbox: { ...bounds, w: 200 },
  fontSizePx: 30,
  lineHeight: 1.2,
  rotationDeg: 0,
  outlineWidthPx: 0,
  textColor: "#000000",
  outlineColor: "#ffffff",
  textAlign: "center",
  direction: "horizontal",
};
const plan: CodexChapterPlan = {
  groups: [
    {
      id: "f1",
      description: "serif",
      members: [{ regionId: "r1", bold: true, italic: true }],
    },
  ],
  fonts: [{ groupId: "f1", fontId: "custom-font" }],
};
const page: MangaPage = {
  id: "p",
  name: "001.png",
  imagePath: "original.png",
  dataUrl: "",
  width: 1000,
  height: 1500,
  blocks: [],
  analysisStatus: "idle",
  createdAt: "",
  updatedAt: "",
};
const mixed: TypesettingLayout = {
  ...layout,
  runs: [
    { text: "잠깐!", bold: true, italic: false, sizePx: 52, color: "#aa0000" },
    { text: " 아니…", bold: false, italic: true, sizePx: 24 },
  ],
};

describe("font-guided editable treatment", () => {
  it.each([
    "read-p",
    "erase-p",
    "source-families",
    "font-assignment",
    "layout-p",
    "review-p",
    "readback-p",
  ])(
    "supplies every object property as required to the strict server for %s",
    (stage) => {
      function inspect(value: unknown): void {
        if (!value || typeof value !== "object") return;
        const schema = value as Record<string, unknown>;
        if (schema.type === "object") {
          expect(schema.additionalProperties).toBe(false);
          expect(schema.required).toEqual(
            Object.keys(schema.properties as object),
          );
        }
        Object.values(value).forEach(inspect);
      }
      inspect(typesettingOutputSchema(stage));
    },
  );

  it("decodes explicit null inheritance without discarding mixed text or valid emphasis", () => {
    const parsed = layoutsSchema.parse({
      layouts: [
        {
          ...layout,
          action: null,
          bold: null,
          italic: null,
          runs: [
            {
              text: layout.translatedText,
              bold: true,
              italic: false,
              sizePx: null,
              color: null,
            },
          ],
        },
      ],
    }).layouts[0];
    expect(parsed.action).toBeUndefined();
    expect(parsed.bold).toBeUndefined();
    expect(parsed.runs?.[0]).toEqual({
      text: layout.translatedText,
      bold: true,
      italic: false,
      sizePx: undefined,
      color: undefined,
    });
    expect(
      layoutsSchema.parse({ layouts: [{ ...layout, runs: null }] }).layouts[0]
        .runs,
    ).toBeUndefined();
    expect(
      layoutsSchema.safeParse({ layouts: [{ ...layout, fontSizePx: null }] })
        .success,
    ).toBe(false);
  });
  it.each([
    { role: "ordinary" as const, mode: undefined, expected: ["image"] },
    { role: "sound" as const, mode: undefined, expected: ["image"] },
    {
      role: "sound" as const,
      mode: "image" as const,
      expected: ["image"],
    },
    {
      role: "sound" as const,
      mode: "font" as const,
      expected: ["text"],
    },
  ])(
    "honors $role mode $mode without regenerating a reviewed first result",
    async ({ role, mode, expected }) => {
      const regionId = "p:r";
      const stages: string[] = [];
      const treatments: string[] = [];
      let sampled = false;
      const whole = {
        bounds: { x: 0, y: 0, w: page.width, h: page.height },
        ownership: { x: 0, y: 0, w: page.width, h: page.height },
      };
      const cleanPage = vi.fn(async () => ({
        page: { ...page, inpaintedImagePath: "clean.png" },
        issues: [],
      }));
      const ports: CodexTypesettingPorts = {
        inspectBackground: async () => ({ issues: [], corrections: [] }),
        signal: new AbortController().signal,
        targetLanguage: "ko",
        blockId: (id) => id,
        readPage: async () => [
          { label: "source", dataUrl: "source-pixels", view: whole },
        ],
        cropRegions: async () => [
          { label: "source crop", dataUrl: "crop-pixels" },
        ],
        fontSamples: async () => {
          sampled = true;
          return [{ label: "actual font sample", dataUrl: "font-pixels" }];
        },
        cleanPage,
        restoreRegions: async (source) => source,
        illustrate: async (source, current) => {
          treatments.push(current.regions[0].action);
          const original = source.blocks[0];
          return {
            page:
              current.regions[0].action === "image"
                ? {
                    ...source,
                    blocks: [
                      {
                        ...original,
                        generatedLettering: {
                          version: 1,
                          dataUrl: "generated-pixels",
                          sourceText: original.sourceText,
                          translatedText: original.translatedText,
                        },
                      },
                    ],
                  }
                : source,
            issues: [],
          };
        },
        render: async () => [
          { label: "rendered", dataUrl: "rendered-pixels", view: whole },
        ],
        saveEvidence: async () => {},
        commit: async () => true,
        progress: () => {},
        ask: async (stage, prompt) => {
          stages.push(stage);
          if (stage.startsWith("read-"))
            return {
              unreadableRegions: [],
              ownedReadability: "readable",
              contextReadability: "absent",
              readabilityReason: "",
              summary: "scene",
              regions: [{ ...reading.regions[0], id: "r", role }],
            };
          if (stage.startsWith("erase-"))
            return {
              regions: [
                {
                  regionId,
                  background: "white",
                  reason: "plain",
                  erasePolygons: [
                    [
                      { x: 0, y: 0 },
                      { x: 1000, y: 0 },
                      { x: 1000, y: 1000 },
                      { x: 0, y: 1000 },
                    ],
                  ],
                },
              ],
            };
          if (stage === "source-families")
            return {
              groups: [
                {
                  ...plan.groups[0],
                  members: [{ regionId, bold: true, italic: true }],
                },
              ],
            };
          if (stage === "font-assignment") return { fonts: plan.fonts };
          if (stage.startsWith("layout-")) {
            expect(sampled).toBe(true);
            expect(prompt).toContain(
              `The user selected SFX mode "${mode ?? "image"}"`,
            );
            return {
              layouts: [
                {
                  ...mixed,
                  regionId,
                  action: stage.endsWith("-0") ? "image" : "text",
                },
              ],
            };
          }
          if (stage.startsWith("readback-"))
            return { regions: [{ regionId, text: mixed.translatedText }] };
          if (stage.startsWith("review-"))
            return {
              issues: stage.endsWith("-0")
                ? [
                    {
                      regionId,
                      kind: "image",
                      reason: "Use the actual editable sample for this style",
                    },
                  ]
                : [],
            };
          throw new Error("Unexpected stage: " + stage);
        },
      };
      const result = await runCodexTypesetting(
        [page],
        {
          version: 1,
          ...(mode ? { sfxRendering: mode } : {}),
          preset: {
            id: "p",
            name: "custom",
            fonts: [{ fontId: "custom-font", purpose: "dialogue" }],
          },
        },
        ports,
      );
      expect(treatments).toEqual(expected);
      expect(cleanPage).toHaveBeenCalledTimes(1);
      expect(stages.filter((stage) => stage.startsWith("readback-"))).toEqual(
        expected.flatMap((action, index) =>
          action === "image" ? [`readback-p-${index}`] : [],
        ),
      );
      const block = result.pages[0].blocks[0];
      expect(Boolean(block.generatedLettering)).toBe(expected[0] === "image");
      expect(block.fontFamily).toBe("custom-font");
      expect(
        parseRichText(block.translatedText, block.bold, block.italic).runs,
      ).toEqual(mixed.runs);
      expect(block.reviewStatus).toBe("needs_review");
      expect(result.warnings.length).toBeGreaterThan(0);
    },
  );
  it("changes text/image presentation without changing source geometry or protected content", () => {
    const image = applyCodexLayoutTreatment(reading, [
      { ...layout, action: "image" },
    ]);
    expect(image.regions[0].action).toBe("image");
    expect(reading.regions[0].action).toBe("text");
    expect(image.regions[0].sourceBbox).toBe(reading.regions[0].sourceBbox);
    expect(image.regions[1]).toEqual(reading.regions[1]);
    expect(applyCodexLayoutTreatment(image, [layout]).regions[0].action).toBe(
      "image",
    );
    expect(
      applyCodexLayoutTreatment(image, [{ ...layout, action: "text" }])
        .regions[0].action,
    ).toBe("text");
    expect(() =>
      applyCodexLayoutTreatment(reading, [
        layout,
        { ...layout, regionId: "keep", action: "image" },
      ]),
    ).toThrow("exactly once");
    expect(() => applyCodexLayoutTreatment(reading, [layout, layout])).toThrow(
      "exactly once",
    );
  });

  it("uses the existing rich text contract for mixed emphasis while keeping one group font", () => {
    const result = buildCodexTypesetPage(
      page,
      reading,
      plan,
      [mixed],
      (id) => id,
    ).blocks[0];
    expect(result.fontFamily).toBe("custom-font");
    expect(result.bold).toBe(false);
    expect(result.italic).toBe(false);
    const parsed = parseRichText(
      result.translatedText,
      result.bold,
      result.italic,
    );
    expect(parsed.plainText).toBe(mixed.translatedText);
    expect(parsed.runs).toEqual(mixed.runs);
    expect(result.bbox).toEqual(bounds);
    expect(result.renderBbox).toEqual(layout.renderBbox);
  });

  it("allows target weight to differ from source-family weight after actual sample inspection", () => {
    const result = buildCodexTypesetPage(
      page,
      reading,
      plan,
      [{ ...layout, bold: false, italic: false }],
      (id) => id,
    ).blocks[0];
    expect(result.bold).toBe(false);
    expect(result.italic).toBe(false);
    expect(result.fontFamily).toBe("custom-font");
    expect(parseRichText(result.translatedText).plainText).toBe(
      layout.translatedText,
    );
  });

  it("rejects run text loss, duplication, unsupported font changes and unrepresentable sizes", () => {
    expect(() =>
      serializeCodexLayoutText({ ...mixed, translatedText: "다른 문구" }),
    ).toThrow("다릅니다");
    const firstRun = mixed.runs?.[0];
    if (!firstRun) throw new Error("Missing mixed-style fixture");
    for (const invalid of [
      { ...firstRun, fontFamily: "unregistered" },
      { ...firstRun, sizePx: 513 },
      { ...firstRun, sizePx: 20.1 },
      { ...firstRun, color: "red" },
    ])
      expect(
        layoutsSchema.safeParse({ layouts: [{ ...layout, runs: [invalid] }] })
          .success,
      ).toBe(false);
    expect(layoutsSchema.safeParse({ layouts: [mixed] }).success).toBe(true);
    expect(
      layoutsSchema.safeParse({ layouts: [{ ...layout, action: "keep" }] })
        .success,
    ).toBe(false);
  });

  it("preserves literal formatting punctuation as text", () => {
    const text = "** [size=40] <b>안녕</b>";
    expect(
      parseRichText(
        serializeCodexLayoutText({ ...layout, translatedText: text }),
      ).plainText,
    ).toBe(text);
    expect(serializeCodexLayoutText({ ...layout, runs: [] })).toBe(
      layout.translatedText,
    );
  });

  it("checks generated pixels against plain text, not serialized formatting", async () => {
    const block = buildCodexTypesetPage(
      page,
      reading,
      plan,
      [mixed],
      (id) => id,
    ).blocks[0];
    block.generatedLettering = {
      version: 1,
      sourceText: block.sourceText,
      translatedText: block.translatedText,
      dataUrl: "pixels",
    };
    const ask = vi.fn(async () => ({
      regions: [{ regionId: "r1", text: mixed.translatedText }],
    }));
    const ports = { ask, blockId: (id: string) => id, targetLanguage: "ko" };
    expect(
      await inspectGeneratedLettering(
        { ...page, blocks: [block] },
        reading,
        0,
        ports,
      ),
    ).toEqual([]);
    expect(ask.mock.calls[0]).toBeDefined();
    ask.mockResolvedValue({
      regions: [{ regionId: "r1", text: "잠깐! 아냐…" }],
    });
    expect(
      await inspectGeneratedLettering(
        { ...page, blocks: [block] },
        reading,
        1,
        ports,
      ),
    ).toHaveLength(1);
  });
});
