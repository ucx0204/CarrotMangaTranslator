export function successTranslationResult(): {
  outputText: string;
  rawResponse: unknown;
  requestBody: unknown;
} {
  return {
    outputText: JSON.stringify({
      items: [
        {
          id: 1,
          type: "speech",
          x1: 100,
          y1: 100,
          x2: 300,
          y2: 200,
          jp: "こんにちは",
          ko: "안녕",
          direction: "horizontal",
          confidence: 0.95,
        },
      ],
    }),
    rawResponse: {},
    requestBody: {},
  };
}

export function translationWithPageContext(
  source: string,
  target: string,
  pageContext: Record<string, unknown>,
): { outputText: string; rawResponse: unknown; requestBody: unknown } {
  return {
    outputText: `${JSON.stringify({
      items: [
        {
          id: 1,
          type: "speech",
          x1: 100,
          y1: 100,
          x2: 300,
          y2: 200,
          jp: source,
          ko: target,
          direction: "horizontal",
          confidence: 0.95,
        },
      ],
    })}\n<page-context>${JSON.stringify(pageContext)}</page-context>`,
    rawResponse: {},
    requestBody: {},
  };
}

export function regionSuccessTranslationResult(): {
  outputText: string;
  rawResponse: unknown;
  requestBody: unknown;
} {
  return {
    outputText: JSON.stringify({
      item: {
        type: "nonsolid",
        textRole: "ordinary",
        x1: 20,
        y1: 40,
        x2: 120,
        y2: 160,
        jp: "こんにちは",
        ko: "안녕",
        direction: "horizontal",
        confidence: 0.95,
      },
    }),
    rawResponse: {},
    requestBody: {},
  };
}

export function regionNullTranslationResult(): {
  outputText: string;
  rawResponse: unknown;
  requestBody: unknown;
} {
  return {
    outputText: JSON.stringify({ item: null }),
    rawResponse: {},
    requestBody: {},
  };
}

export function regionSoundTranslationResult(): {
  outputText: string;
  rawResponse: unknown;
  requestBody: unknown;
} {
  return {
    outputText: JSON.stringify({
      item: {
        type: "nonsolid",
        textRole: "sound",
        x1: 20,
        y1: 40,
        x2: 220,
        y2: 160,
        jp: "スタコラサッサ",
        ko: "후다닥",
        direction: "vertical",
        confidence: 0.95,
      },
    }),
    rawResponse: {},
    requestBody: {},
  };
}
