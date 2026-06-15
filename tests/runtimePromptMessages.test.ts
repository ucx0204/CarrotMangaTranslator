import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildMessages,
  collectOcrBboxHints,
  createTempDir,
  getOverlayPrompt,
} from "./helpers/runtimeModelContracts";

describe("runtime prompt message contracts", () => {
  it("uses OCR bbox candidates as single-pass geometry hints", () => {
    const options = {
      modelProvider: "openai-codex",
      imageWidth: 836,
      imageHeight: 1188,
      ocrBboxHints: [
        {
          id: 1,
          label: "text",
          x1: 67,
          y1: 589,
          x2: 267,
          y2: 760,
          ocrText: "いえ…資金はこちらも",
        },
        {
          id: 2,
          label: "text",
          x1: 83,
          y1: 767,
          x2: 239,
          y2: 1029,
          ocrText: "モリーダ村に支店を置く",
        },
      ],
    };
    const variants = [
      {
        role: "openai-vision",
        dataUrl: "data:image/png;base64,abc123",
        width: 836,
        height: 1188,
        originalWidth: 836,
        originalHeight: 1188,
      },
    ];
    const prompt = getOverlayPrompt(options, variants);

    expect(prompt).toContain("# OCR bbox candidates");
    expect(prompt).toContain("low-trust OCR text hints for slot matching only");
    expect(prompt).toContain("Use Image 1 as the authority");
    expect(prompt).toContain("Treat each candidate as a locked geometry slot.");
    expect(prompt).toContain("Required candidate ids: 1, 2.");
    expect(prompt).toContain(
      'candidate 1: label:text x1:67 y1:589 x2:267 y2:760 ocrText:"いえ…資金はこちらも"',
    );
    expect(prompt).toContain(
      'candidate 2: label:text x1:83 y1:767 x2:239 y2:1029 ocrText:"モリーダ村に支店を置く"',
    );
    expect(prompt).toContain("Do not merge two candidates into one record");
    expect(prompt).toContain("add a new record with id greater than 2");
    expect(prompt).not.toContain("Find one anchor point");
  });

  it("adds soft semantic group hints for split OCR fragments without merging geometry slots", async () => {
    const dir = createTempDir("ocr-group-hints-");
    const hintPath = join(dir, "hints.json");
    writeFileSync(
      hintPath,
      JSON.stringify({
        source: "paddleocr-vl",
        coordinateSpace: "pixels",
        width: 1200,
        height: 1600,
        items: [
          {
            label: "vertical_text",
            bbox: [900, 40, 960, 270],
            content: "あ～れ～",
          },
          {
            label: "vertical_text",
            bbox: [120, 170, 250, 440],
            content: "ま～し～た～！！",
          },
          {
            label: "vertical_text",
            bbox: [760, 700, 850, 900],
            content: "漢字を含む通常文",
          },
        ],
      }),
      "utf8",
    );

    const result = await collectOcrBboxHints({
      imageWidth: 1200,
      imageHeight: 1600,
      ocrBboxHintsPath: hintPath,
    });
    expect(result.hints[0]).toMatchObject({
      groupId: "G001",
      rolePrior: "ordinary_soft",
      orderInGroup: 1,
    });
    expect(result.hints[1]).toMatchObject({
      groupId: "G001",
      rolePrior: "ordinary_soft",
      orderInGroup: 2,
    });
    expect(result.hints[2]?.groupId).toBeUndefined();

    const prompt = getOverlayPrompt(
      {
        modelProvider: "gemma",
        imageWidth: 1200,
        imageHeight: 1600,
        ocrBboxHints: result.hints,
      },
      [
        {
          role: "original",
          dataUrl: "data:image/png;base64,abc123",
          width: 1200,
          height: 1600,
          originalWidth: 1200,
          originalHeight: 1600,
        },
      ],
    );

    expect(prompt).toContain("Group context hints:");
    expect(prompt).toContain(
      "group G001: rolePrior:ordinary_soft containerType:possible_continuing_text candidateIds:[1,2] readingOrder:[1,2]",
    );
    expect(prompt).toContain(
      "Even inside a group, keep one output record per candidate id",
    );
    expect(prompt).toContain(
      'candidate 1: label:vertical_text x1:750 y1:25 x2:800 y2:169 group:G001 orderInGroup:1 rolePrior:ordinary_soft ocrText:"あ～れ～"',
    );
    expect(prompt).toContain(
      'candidate 2: label:vertical_text x1:100 y1:106 x2:208 y2:275 group:G001 orderInGroup:2 rolePrior:ordinary_soft ocrText:"ま～し～た～！！"',
    );
  });

  it("uses container-level grouping for selected-region crop translation", () => {
    const prompt = getOverlayPrompt(
      {
        regionCropMode: true,
        skipOcrBboxHints: true,
        imageWidth: 420,
        imageHeight: 320,
      },
      [
        {
          role: "original",
          dataUrl: "data:image/png;base64,abc123",
          width: 420,
          height: 320,
          originalWidth: 420,
          originalHeight: 320,
        },
      ],
    );

    expect(prompt).toContain(
      "You are given one user-selected crop from a Japanese manga page.",
    );
    expect(prompt).toContain("# Selected region grouping");
    expect(prompt).toContain("Do not treat the whole crop as one text item.");
    expect(prompt).toContain(
      "If the crop contains one speech bubble or one caption plate, output exactly one record",
    );
    expect(prompt).toContain(
      "Inside one speech bubble, never split by Japanese vertical column, text line, word, sentence fragment, punctuation gap, or line break.",
    );
    expect(prompt).toContain(
      "jp must include all columns in natural Japanese reading order",
    );
  });

  it("normalizes bbox hint JSON with low-trust OCR text", async () => {
    const dir = createTempDir("ocr-hints-");
    const hintPath = join(dir, "hints.json");
    writeFileSync(
      hintPath,
      JSON.stringify({
        source: "paddleocr-vl",
        coordinateSpace: "pixels",
        width: 836,
        height: 1188,
        items: [
          { label: "text", bbox: [67, 589, 267, 760], content: "いえ…" },
          { label: "image", bbox: [0, 0, 100, 100], content: "ignored" },
        ],
      }),
      "utf8",
    );

    const result = await collectOcrBboxHints({
      imageWidth: 836,
      imageHeight: 1188,
      ocrBboxHintsPath: hintPath,
    });

    expect(result.hints).toHaveLength(1);
    expect(result.hints[0]).toMatchObject({
      x1: 67,
      y1: 589,
      x2: 267,
      y2: 760,
      ocrText: "いえ…",
    });
  });

  it("uses the same tight Japanese glyph bbox prompt for Gemma chat requests", () => {
    const messages = buildMessages(
      {
        modelProvider: "gemma",
        imageWidth: 836,
        imageHeight: 1188,
      },
      [{ role: "original", dataUrl: "data:image/png;base64,abc123" }],
    );
    const systemText =
      messages[0]?.content.find((part) => part.type === "text")?.text ?? "";
    const userPrompt =
      messages[1]?.content.find(
        (part) => part.type === "text" && part.text?.includes("# Task"),
      )?.text ?? "";

    expect(systemText).toContain(
      "Geometry accuracy comes before Korean text fit",
    );
    expect(messages[1]?.content[0]).toMatchObject({ type: "image_url" });
    expect(messages[1]?.content[1]).toMatchObject({ type: "text" });
    expect(userPrompt).toContain("Detect every visible Japanese text group");
    expect(userPrompt).toContain("Return x1, y1, x2, y2 as normalized 0..1000");
    expect(userPrompt).toContain("direction, angle, fontSize");
    expect(userPrompt).toContain(
      "For SFX, box only the sound-effect glyph strokes",
    );
    expect(userPrompt).not.toContain(
      "speech bubble, narration box, name call, or sound-effect block",
    );
  });
});
