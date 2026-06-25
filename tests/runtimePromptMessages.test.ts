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
    expect(prompt).toContain("Treat each candidate as a geometry anchor.");
    expect(prompt).toContain("Candidate ids to review: 1, 2.");
    expect(prompt).toContain("Same-container merge exception");
    expect(prompt).toContain(
      "Preserve numeric matchups, ratios, counts, and ordinals exactly in ko.",
    );
    expect(prompt).toContain(
      'candidate 1: label:text x1:67 y1:589 x2:267 y2:760 ocrText:"いえ…資金はこちらも"',
    );
    expect(prompt).toContain(
      'candidate 2: label:text x1:83 y1:767 x2:239 y2:1029 ocrText:"モリーダ村に支店を置く"',
    );
    expect(prompt).toContain(
      "Do not merge two separate speech bubbles into one record",
    );
    expect(prompt).toContain("add a new record with id greater than 2");
    expect(prompt).not.toContain("Find one anchor point");
  });

  it("adds soft semantic group hints for split OCR fragments", async () => {
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
      "For group containerType possible_continuing_text, use the group mainly for coherent reading.",
    );
    expect(prompt).toContain(
      'candidate 1: label:vertical_text x1:750 y1:25 x2:800 y2:169 group:G001 orderInGroup:1 rolePrior:ordinary_soft containerType:possible_continuing_text ocrText:"あ～れ～"',
    );
    expect(prompt).toContain(
      'candidate 2: label:vertical_text x1:100 y1:106 x2:208 y2:275 group:G001 orderInGroup:2 rolePrior:ordinary_soft containerType:possible_continuing_text ocrText:"ま～し～た～！！"',
    );
  });

  it("marks adjacent vertical OCR columns as one mergeable text container", async () => {
    const dir = createTempDir("ocr-same-container-");
    const hintPath = join(dir, "hints.json");
    writeFileSync(
      hintPath,
      JSON.stringify({
        source: "paddleocr-vl",
        coordinateSpace: "pixels",
        width: 844,
        height: 1200,
        items: [
          {
            label: "ocr_textline",
            bbox: [601, 542, 643, 807],
            content: "考えることが一緒だな！",
          },
          {
            label: "ocr_textline",
            bbox: [640, 543, 678, 806],
            content: "ゴミはどいつもこいつも",
          },
          {
            label: "ocr_textline",
            bbox: [727, 464, 781, 604],
            content: "いつから気づい クソ！",
          },
        ],
      }),
      "utf8",
    );

    const result = await collectOcrBboxHints({
      imageWidth: 844,
      imageHeight: 1200,
      ocrBboxHintsPath: hintPath,
    });

    expect(result.hints[0]).toMatchObject({
      groupId: "G001",
      rolePrior: "ordinary_mergeable",
      containerType: "same_text_container",
      orderInGroup: 2,
    });
    expect(result.hints[1]).toMatchObject({
      groupId: "G001",
      rolePrior: "ordinary_mergeable",
      containerType: "same_text_container",
      orderInGroup: 1,
    });
    expect(result.hints[2]?.groupId).toBeUndefined();

    const prompt = getOverlayPrompt(
      {
        modelProvider: "gemma",
        imageWidth: 844,
        imageHeight: 1200,
        ocrBboxHints: result.hints,
      },
      [
        {
          role: "original",
          dataUrl: "data:image/png;base64,abc123",
          width: 844,
          height: 1200,
          originalWidth: 844,
          originalHeight: 1200,
        },
      ],
    );

    expect(prompt).toContain(
      "For group containerType same_text_container, treat the grouped ordinary candidates as one visual text container",
    );
    expect(prompt).toContain(
      "group G001: rolePrior:ordinary_mergeable containerType:same_text_container candidateIds:[2,1] readingOrder:[2,1]",
    );
  });

  it("omits contaminated previous-pass text for strict same-container and glossary conflicts", () => {
    const prompt = getOverlayPrompt(
      {
        strictRefineMode: true,
        imageWidth: 1000,
        imageHeight: 1400,
        previousBlocksForPrompt: [
          {
            index: 1,
            candidateId: 5,
            bbox: { x: 100, y: 100, w: 50, h: 100 },
            textRole: "ordinary",
            sourceText: "考えることが一緒だな！",
            translatedText: "생각하는 게 똑같네!",
            confidence: 1,
          },
          {
            index: 2,
            candidateId: 2,
            bbox: { x: 200, y: 100, w: 50, h: 100 },
            textRole: "ordinary",
            sourceText: "「戦乙女」の エッソなー",
            translatedText: "'발키리'의 에소 아니냐?",
            confidence: 1,
          },
        ],
        ocrBboxHints: [
          {
            id: 5,
            x1: 100,
            y1: 100,
            x2: 150,
            y2: 200,
            groupId: "G001",
            orderInGroup: 2,
            containerType: "same_text_container",
            rolePrior: "ordinary_mergeable",
            ocrText: "考えることが一緒だな！",
          },
          {
            id: 2,
            x1: 200,
            y1: 100,
            x2: 250,
            y2: 200,
            rolePrior: "ordinary",
            ocrText:
              "リーダーともあろう者が 二対一かよ おいおい戦乙女の eSso グァルキリ あの",
          },
        ],
        workContext: {
          styleGuide: {
            glossary: [
              {
                source: "ヴァルキリー",
                target: "전처녀",
                aliases: ["戦乙女"],
                enabled: true,
              },
            ],
          },
        },
      },
      [],
    );

    expect(prompt).toContain(
      'previous 1: candidateId:5 bbox:[100,100,150,200] role:ordinary confidence:1 oldText:omitted reason:"same_container_split"',
    );
    expect(prompt).toContain(
      'previous 2: candidateId:2 bbox:[200,100,250,200] role:ordinary confidence:1 oldText:omitted reason:"glossary_conflict:전처녀"',
    );
    expect(prompt).not.toContain("생각하는 게 똑같네");
    expect(prompt).not.toContain("발키리");
    expect(prompt).not.toContain("eSso");
    expect(prompt).not.toContain("グァルキリ");
    expect(prompt).toContain(
      'candidate 2: label:text x1:200 y1:71 x2:250 y2:143 rolePrior:ordinary ocrText:"リーダーともあろう者が 二対一かよ おいおい戦乙女の"',
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
