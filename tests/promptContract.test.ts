import { describe, expect, it } from "vitest";

const promptRuntime =
  require("../src/main/runtime/simple-page-prompts.cjs") as {
    buildSystemPrompt: (options?: Record<string, unknown>) => string;
    getOverlayPrompt: (
      options?: Record<string, unknown>,
      imageVariants?: ImageVariant[],
    ) => string;
  };
const requestBuilders =
  require("../src/main/runtime/simple-page-request-builders.cjs") as {
    buildMessages: (
      options: Record<string, unknown>,
      imageVariants: ImageVariant[],
    ) => ChatMessage[];
    buildResponsesRequestBodyWithModelResolver: (
      options: Record<string, unknown>,
      imageVariants: ImageVariant[],
      promptText: string,
      systemPrompt: string,
      resolveRequestModelName: (options: Record<string, unknown>) => string,
    ) => ResponsesRequestBody;
  };
const requestSummaryRuntime =
  require("../src/main/runtime/simple-page-request-summary.cjs") as {
    buildRequestSummary: (
      server: { baseUrl: string },
      options: Record<string, unknown>,
      imageVariants: ImageVariant[],
      promptText: string,
      systemPrompt: string,
    ) => {
      endpoint: string;
      bboxCoordinateSpace: string;
      bboxCoordinateFrame: { width: number; height: number };
      ocrBboxHintCount: number;
      ocrBboxHints: Array<{ id: number; ocrText: string | null }>;
      imageVariants?: ImageVariant[];
      options?: Record<string, unknown>;
    };
  };

type ImageVariant = {
  role: string;
  dataUrl?: string;
  path?: string;
  width?: number;
  height?: number;
  originalWidth?: number;
  originalHeight?: number;
};

type ChatMessage = {
  role: string;
  content: Array<{
    type: string;
    text?: string;
    image_url?: { url: string };
  }>;
};

type ResponsesRequestBody = {
  model: string;
  instructions: string;
  input: Array<{
    role: string;
    content: Array<{
      type: string;
      text?: string;
      image_url?: string;
      detail?: string;
    }>;
  }>;
  reasoning: { effort: string };
  stream: boolean;
  store: boolean;
};

const { buildSystemPrompt, getOverlayPrompt } = promptRuntime;
const { buildMessages, buildResponsesRequestBodyWithModelResolver } =
  requestBuilders;
const { buildRequestSummary } = requestSummaryRuntime;

function createPromptContractOptions(): Record<string, unknown> {
  return {
    modelProvider: "openai-codex",
    codexModel: "gpt-5.5",
    codexReasoningEffort: "medium",
    imageWidth: 7680,
    imageHeight: 4320,
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
}

function createPromptContractVariants(): ImageVariant[] {
  return [
    {
      role: "openai-vision",
      dataUrl: "data:image/png;base64,abc123",
      path: "page.png",
      width: 4256,
      height: 2400,
      originalWidth: 7680,
      originalHeight: 4320,
    },
  ];
}

function expectTightJapaneseGlyphRules(text: string): void {
  expect(text).toContain(
    "x1, y1, x2, y2 describe the tight rectangle corners of the visible Japanese glyph ink and its outline.",
  );
  expect(text).toContain("Return x1, y1, x2, y2 as integer pixel coordinates");
  expect(text).toContain(
    "fontSize is the apparent Japanese glyph size in Image 1 pixels.",
  );
  expect(text).toContain("Each speech bubble is one dialogue item.");
  expect(text).toContain(
    "If two white balloon lobes touch, overlap, stack vertically, or connect through a narrow neck",
  );
  expect(text).toContain("For SFX, box only the sound-effect glyph strokes");
  expect(text).toContain("type must always be nonsolid.");
}

function expectRenderingRoleRules(text: string): void {
  expect(text).toContain(
    "The app uses one inpainting path for every text block",
  );
  expect(text).toContain(
    "textRole must be ordinary for speech bubbles, captions, narration, labels, signs, and notes.",
  );
  expect(text).toContain(
    "A word or phrase inside a speech bubble, caption, note, sign, or label remains ordinary",
  );
  expect(text).toContain(
    "Never replace an ordinary word, noun, label, or dialogue fragment with a Korean sound effect.",
  );
  expect(text).toContain(
    "Korean rendering should be horizontal by default even when the Japanese source direction is vertical.",
  );
  expect(text).toContain(
    "For sound-effect or reaction lettering, ko must be bare Korean effect lettering only",
  );
  expect(text).toContain("no parentheses, brackets, quotes");
  expect(text).toContain(
    "Do not mechanically transliterate Japanese kana when that would sound awkward in Korean.",
  );
  expect(text).toContain(
    "It may be 1.00 only for a complete, clearly read SFX with a clearly correct Korean sound.",
  );
  expect(text).toContain("Do not force every SFX into semantic Korean");
  expect(text).toContain(
    "For repeated or lengthened SFX, preserve the visible rhythm and duration",
  );
  expect(text).toContain("Do not translate ambient SFX as spoken dialogue");
  expect(text).toContain(
    "Do not output isolated fragments as separate records",
  );
  expect(text).toContain("Skip records whose jp is only punctuation");
}

describe("prompt contracts", () => {
  it("builds the canonical overlay prompt with tight Japanese glyph bbox rules", () => {
    const options = createPromptContractOptions();
    const imageVariants = createPromptContractVariants();
    const prompt = getOverlayPrompt(options, imageVariants);

    expect(prompt).toContain("# Task");
    expect(prompt).toContain("# Output");
    expect(prompt).toContain("# Geometry");
    expectTightJapaneseGlyphRules(prompt);
    expectRenderingRoleRules(prompt);
    expect(prompt).toContain("Coordinate calibration");
    expect(prompt).toContain(
      "Use the full visible Image 1 frame as the coordinate frame",
    );
    expect(prompt).toContain(
      "Use exactly these keys, one per line: id, type, textRole, x1, y1, x2, y2, direction, angle, fontSize, confidence, jp, ko.",
    );
    expect(prompt).toContain("confidence is your confidence from 0.00 to 1.00");
    expect(prompt).toContain("OCR bbox candidates");
    expect(prompt).toContain("low-trust OCR text hints for slot matching only");
    expect(prompt).toContain("Use Image 1 as the authority");
    expect(prompt).toContain("Treat each candidate as a geometry anchor.");
    expect(prompt).toContain("Same-container merge exception");
    expect(prompt).toContain("OCR hints may include Latin garbage");
    expect(prompt).toContain(
      "For every accepted candidate, output type nonsolid and set textRole to ordinary or sound.",
    );
    expect(prompt).not.toContain("ざわざわ/ザワザワ");
    expect(prompt).not.toContain("ギュル/ギュルル");
    expect(prompt).not.toContain("ダァ/ダー");
    expect(prompt).not.toContain("재능");
    expect(prompt).not.toContain("buildPointDetectionPrompt");
    expect(prompt).not.toContain("buildPointExpansionPrompt");
    expect(prompt).not.toContain("Return x, y, w, h as normalized 0..1000");
  });

  it("puts the canonical prompt into chat and Responses request bodies", () => {
    const options = createPromptContractOptions();
    const imageVariants = createPromptContractVariants();
    const prompt = getOverlayPrompt(options, imageVariants);
    const systemPrompt = buildSystemPrompt(options);
    const messages = buildMessages(options, imageVariants);
    const responsesRequest = buildResponsesRequestBodyWithModelResolver(
      options,
      imageVariants,
      prompt,
      systemPrompt,
      () => "gpt-5.5",
    );

    expect(messages[0]?.content[0]?.text).toContain(
      "Geometry accuracy comes before Korean text fit",
    );
    expect(messages[1]?.content[0]).toMatchObject({
      type: "image_url",
      image_url: { url: "data:image/png;base64,abc123" },
    });
    expect(messages[1]?.content.at(-1)?.text).toBe(prompt);
    expect(responsesRequest).toMatchObject({
      model: "gpt-5.5",
      instructions: systemPrompt,
      reasoning: { effort: "medium" },
      stream: true,
      store: false,
    });
    expect(responsesRequest.input[0]?.content[0]).toMatchObject({
      type: "input_image",
      image_url: "data:image/png;base64,abc123",
      detail: "original",
    });
    expect(responsesRequest.input[0]?.content.at(-1)).toMatchObject({
      type: "input_text",
      text: prompt,
    });
  });

  it("summarizes bbox coordinate space from the same prompt contract inputs", () => {
    const options = createPromptContractOptions();
    const imageVariants = createPromptContractVariants();
    const prompt = getOverlayPrompt(options, imageVariants);
    const systemPrompt = buildSystemPrompt(options);
    const summary = buildRequestSummary(
      { baseUrl: "https://codex.example.test" },
      options,
      imageVariants,
      prompt,
      systemPrompt,
    );

    expect(summary.endpoint).toBe("https://codex.example.test/responses");
    expect(summary.bboxCoordinateSpace).toBe("pixels");
    expect(summary.bboxCoordinateFrame).toEqual({ width: 4256, height: 2400 });
    expect(summary.ocrBboxHintCount).toBe(2);
    expect(summary.ocrBboxHints.map((hint) => hint.id)).toEqual([1, 2]);
    expect(summary.ocrBboxHints[0]?.ocrText).toBe("いえ…資金はこちらも");
  });

  it("keeps selected-region context images out of the coordinate frame", () => {
    const options = {
      modelProvider: "openai-codex",
      codexModel: "gpt-5.5",
      codexReasoningEffort: "medium",
      regionCropMode: true,
      imageWidth: 420,
      imageHeight: 320,
      regionContextImagePath: "page.png",
      regionContextImageWidth: 1200,
      regionContextImageHeight: 1800,
      regionContextCropRect: { x: 320, y: 480, w: 420, h: 320 },
    };
    const imageVariants: ImageVariant[] = [
      {
        role: "openai-vision",
        dataUrl: "data:image/png;base64,crop",
        path: "crop.png",
        width: 420,
        height: 320,
        originalWidth: 420,
        originalHeight: 320,
      },
      {
        role: "full-page-context",
        dataUrl: "data:image/png;base64,page",
        path: "page.png",
        width: 1200,
        height: 1800,
        originalWidth: 1200,
        originalHeight: 1800,
      },
    ];
    const prompt = getOverlayPrompt(options, imageVariants);
    const systemPrompt = buildSystemPrompt(options);
    const summary = buildRequestSummary(
      { baseUrl: "https://codex.example.test" },
      options,
      imageVariants,
      prompt,
      systemPrompt,
    );

    expect(prompt).toContain(
      "Image 1 is the coordinate-authority selected crop",
    );
    expect(summary.bboxCoordinateSpace).toBe("pixels");
    expect(summary.bboxCoordinateFrame).toEqual({ width: 420, height: 320 });
    expect(summary.imageVariants?.map((variant) => variant.role)).toEqual([
      "openai-vision",
      "full-page-context",
    ]);
  });

  it("keeps the default Japanese -> Korean prompt when a ja/ko pair is passed explicitly", () => {
    const options = createPromptContractOptions();
    const imageVariants = createPromptContractVariants();
    const basePrompt = getOverlayPrompt(options, imageVariants);
    const explicitPrompt = getOverlayPrompt(
      { ...options, sourceLanguage: "ja", targetLanguage: "ko" },
      imageVariants,
    );

    expect(explicitPrompt).toBe(basePrompt);
    expect(
      buildSystemPrompt({
        ...options,
        sourceLanguage: "ja",
        targetLanguage: "ko",
      }),
    ).toBe(buildSystemPrompt(options));
  });

  it("localizes the overlay prompt for generic language pairs", () => {
    const options = {
      ...createPromptContractOptions(),
      sourceLanguage: "en",
      targetLanguage: "fr",
    };
    const imageVariants = createPromptContractVariants();
    const prompt = getOverlayPrompt(options, imageVariants);
    const systemPrompt = buildSystemPrompt(options);

    expect(prompt).toContain(
      "Detect every visible English text group and translate it into concise French.",
    );
    expect(prompt).toContain(
      "Use exactly these keys, one per line: id, type, textRole, x1, y1, x2, y2, direction, angle, fontSize, confidence, source, target.",
    );
    expect(prompt).toContain("source: <visible English source text>");
    expect(prompt).toContain("target: <concise French translation>");
    expect(prompt).not.toContain("Japanese");
    expect(prompt).not.toContain("Korean");
    expect(prompt).not.toMatch(/kana|furigana/i);
    expect(prompt).not.toMatch(/[가-힣]/);
    expect(prompt).toContain("top to bottom and left to right");
    expect(prompt).toContain(
      "Meaningful single letters, digits, and compact labels are valid source text.",
    );
    expect(prompt).not.toContain("a lone Latin letter");
    expect(systemPrompt).toContain(
      "Geometry accuracy comes before French text fit",
    );
    expect(systemPrompt).not.toContain("Japanese");
    expect(systemPrompt).not.toContain("Korean");
  });

  it("uses right-to-left page order for RTL source languages", () => {
    const prompt = getOverlayPrompt(
      {
        ...createPromptContractOptions(),
        sourceLanguage: "ar-SA",
        targetLanguage: "en-US",
      },
      createPromptContractVariants(),
    );

    expect(prompt).toContain(
      "Detect every visible Arabic text group and translate it into concise English.",
    );
    expect(prompt).toContain("top to bottom and right to left");
  });

  it("preserves dynamic multilingual context while localizing prompt instructions", () => {
    const options = {
      ...createPromptContractOptions(),
      sourceLanguage: "ko",
      targetLanguage: "en",
      strictRefineMode: true,
      ocrBboxHints: [
        {
          id: 1,
          label: "text",
          x1: 67,
          y1: 589,
          x2: 267,
          y2: 760,
          ocrText: "안녕하세요",
        },
      ],
      previousBlocksForPrompt: [
        {
          index: 1,
          bbox: { x: 67, y: 589, w: 200, h: 171 },
          sourceText: "안녕하세요",
          translatedText: "Hello",
        },
      ],
      workContext: {
        styleGuide: {
          glossary: [
            {
              enabled: true,
              category: "term",
              source: "마왕",
              target: "Demon King",
              aliases: ["마왕님"],
              note: "한국어 원문 용어",
            },
          ],
          characters: [],
          rules: {},
        },
        storyMemory: {
          pages: [
            {
              pageIndex: 0,
              pageName: "첫 장",
              summary: "용사가 출발하는 한국어 요약",
            },
          ],
        },
      },
    };
    const imageVariants = createPromptContractVariants();
    const prompt = getOverlayPrompt(options, imageVariants);
    const systemPrompt = buildSystemPrompt(options);
    const regionPrompt = getOverlayPrompt(
      { ...options, regionCropMode: true },
      imageVariants,
    );

    expect(prompt).toContain(
      "Detect every visible Korean text group and translate it into concise English.",
    );
    expect(systemPrompt).toContain(
      "preserve the original Korean glyph position and apparent size",
    );
    expect(prompt).toContain('ocrText:"안녕하세요"');
    expect(prompt).toContain("마왕 => Demon King");
    expect(prompt).toContain("용사가 출발하는 한국어 요약");
    expect(prompt).toContain(
      "Stored target values may come from an earlier target language",
    );
    expect(prompt).not.toContain("prefer the target English exactly");
    expect(prompt).toContain("defaultTone=natural_target");
    expect(prompt).not.toContain("defaultTone=natural_korean");
    expect(prompt).toContain('source:"안녕하세요"');
    expect(prompt).toContain('target:"Hello"');
    expect(regionPrompt).toContain('text:"안녕하세요"');
    expect(regionPrompt).toContain('"source": "visible Korean text"');
    expect(regionPrompt).toContain('"target": "natural English translation"');
  });

  it("does not rewrite or drop non-Japanese OCR source text", () => {
    const imageVariants = createPromptContractVariants();
    const englishPrompt = getOverlayPrompt(
      {
        ...createPromptContractOptions(),
        sourceLanguage: "en",
        targetLanguage: "fr",
        ocrBboxHints: [
          {
            id: 1,
            label: "text",
            x1: 67,
            y1: 589,
            x2: 267,
            y2: 760,
            ocrText: "Japanese Breakfast",
          },
        ],
      },
      imageVariants,
    );
    const chinesePrompt = getOverlayPrompt(
      {
        ...createPromptContractOptions(),
        sourceLanguage: "zh-Hans",
        targetLanguage: "en",
        strictRefineMode: true,
        ocrBboxHints: [
          {
            id: 1,
            label: "text",
            x1: 67,
            y1: 589,
            x2: 267,
            y2: 760,
            ocrText: "AI 技术",
          },
        ],
        previousBlocksForPrompt: [
          {
            index: 1,
            bbox: { x: 67, y: 589, w: 200, h: 171 },
            sourceText: "AI 技术",
            translatedText: "AI technology",
          },
        ],
      },
      imageVariants,
    );

    expect(englishPrompt).toContain('ocrText:"Japanese Breakfast"');
    expect(englishPrompt).not.toContain('ocrText:"English Breakfast"');
    expect(chinesePrompt).toContain('ocrText:"AI 技术"');
    expect(chinesePrompt).toContain('source:"AI 技术"');
    expect(chinesePrompt).toContain('target:"AI technology"');
  });

  it("keeps Japanese source guidance when only the target language changes", () => {
    const options = {
      ...createPromptContractOptions(),
      sourceLanguage: "ja",
      targetLanguage: "en",
    };
    const prompt = getOverlayPrompt(options, createPromptContractVariants());

    expect(prompt).toContain(
      "Detect every visible Japanese text group and translate it into concise English.",
    );
    // 원문이 일본어이므로 가나/후리가나 규칙은 유지된다.
    expect(prompt).toMatch(/kana/i);
    // 한국어 전용 SFX 예시는 도착어가 영어이므로 제거된다.
    expect(prompt).not.toMatch(/[가-힣]/);
  });

  it("adds V2 visual-role output only when automatic font matching is enabled", () => {
    const base = createPromptContractOptions();
    const enabled = getOverlayPrompt(
      { ...base, autoFontMatching: true },
      createPromptContractVariants(),
    );
    const disabled = getOverlayPrompt(base, createPromptContractVariants());

    expect(enabled).toContain("fontRole: <fine-grained role>");
    expect(enabled).toContain("fontRoleConfidence: <0.00-1.00>");
    expect(enabled).toContain("visualClusterId is optional");
    expect(enabled).toContain("Omit visualClusterId for dialogue");
    expect(enabled).toContain("aside_balloon_edge");
    expect(enabled).toContain(
      "not the work title, genre stereotype, translated wording, or string length",
    );
    expect(disabled).not.toContain("fontRoleConfidence");
    expect(disabled).not.toContain("visualClusterId");
  });

  it("summarizes API chat endpoints without leaking API keys", () => {
    const options = {
      modelProvider: "openai-api",
      apiBaseUrl: "http://127.0.0.1:1234/v1",
      apiModel: "local-vision-model",
      apiKey: "sk-secret-value",
      imageWidth: 1200,
      imageHeight: 1600,
    };
    const imageVariants = [
      {
        role: "original",
        dataUrl: "data:image/png;base64,abc123",
        path: "page.png",
        width: 1200,
        height: 1600,
      },
    ];
    const prompt = getOverlayPrompt(options, imageVariants);
    const systemPrompt = buildSystemPrompt(options);
    const summary = buildRequestSummary(
      { baseUrl: "http://127.0.0.1:1234/v1" },
      options,
      imageVariants,
      prompt,
      systemPrompt,
    );

    expect(summary.endpoint).toBe("http://127.0.0.1:1234/v1/chat/completions");
    expect(summary.options?.apiKeyConfigured).toBe(true);
    expect(JSON.stringify(summary)).not.toContain("sk-secret-value");
  });
});
