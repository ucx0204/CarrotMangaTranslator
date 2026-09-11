import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  createTempDir,
  requestTranslation,
} from "./helpers/runtimeModelContracts";

const { buildSoundEffectRequestBody } =
  require("../src/main/runtime/transport/sound-effect-request.cjs") as {
    buildSoundEffectRequestBody: (
      options: Record<string, unknown>,
      messages: unknown[],
    ) => Record<string, unknown>;
  };
const regions = [
  {
    regionId: "FX001",
    bbox: { x: 1, y: 2, w: 3, h: 4 },
    detectorConfidence: 0.9,
  },
];
const outputText = JSON.stringify({
  items: [
    {
      regionId: "FX001",
      verdict: "sound",
      confirmedSource: "ドン",
      translation: "쿵",
      confidence: 0.9,
    },
  ],
});
afterEach(() => vi.unstubAllGlobals());

function options(modelProvider = "gemma") {
  const outputDir = createTempDir("sfx-structured-");
  const imagePath = join(outputDir, "crop.png");
  const contextPath = join(outputDir, "context.png");
  for (const path of [imagePath, contextPath])
    writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return {
    label: "sfx",
    modelProvider,
    modelRepo: "test/model",
    modelFile: "model.gguf",
    apiModel: "test",
    apiKey: "test-key",
    apiKeyMaxAttempts: 1,
    sourceLanguage: "ja",
    targetLanguage: "ko",
    imagePath,
    outputDir,
    regionCropMode: true,
    regionContextImagePath: contextPath,
    regionContextImageWidth: 100,
    regionContextImageHeight: 100,
    imageWidth: 100,
    imageHeight: 100,
    ocrBboxHints: [],
    includeEnhancedVariant: false,
    maxTokens: 1024,
    disableUnused49LogitBias: true,
    soundEffectTranslationMode: true,
    soundEffectTranslationRegions: regions,
  };
}
function success() {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: outputText } }] }),
    { status: 200 },
  );
}
it("routes the actual local SFX request through the fixed-id JSON grammar without reasoning output", async () => {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      bodies.push(JSON.parse(String(init.body)));
      return success();
    }),
  );
  const result = await requestTranslation(
    { baseUrl: "http://model/v1" },
    options(),
  );
  expect(result.outputText).toBe(outputText);
  expect(bodies).toHaveLength(1);
  expect(bodies[0]).toMatchObject({
    enable_thinking: false,
    reasoning_budget: 0,
    chat_template_kwargs: { enable_thinking: false },
    response_format: {
      type: "json_object",
      schema: {
        properties: {
          items: {
            minItems: 1,
            maxItems: 1,
            items: {
              additionalProperties: false,
              properties: {
                regionId: { enum: ["FX001"] },
                verdict: { enum: ["sound", "reaction", "uncertain"] },
              },
            },
          },
        },
      },
    },
  });
  expect(result.requestBody).toMatchObject({
    soundEffectTranslationContractVersion: 3,
    responseMaxTokens: 1024,
  });
});
it("retains the existing bounded API fallback when a provider rejects strict schemas", async () => {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      bodies.push(JSON.parse(String(init.body)));
      return bodies.length === 1
        ? new Response("invalid response_format json_schema", { status: 400 })
        : success();
    }),
  );
  const result = await requestTranslation(
    { baseUrl: "http://model/v1" },
    options("openai-api"),
  );
  expect(bodies).toHaveLength(2);
  expect(bodies[0]).toMatchObject({ response_format: { type: "json_schema" } });
  expect(bodies[1]).toMatchObject({ response_format: { type: "json_object" } });
  expect(result.requestBody).toMatchObject({
    structuredOutputFallback: "json_object",
  });
  expect(result.outputText).toBe(outputText);
});
it("uses the existing Responses format for Codex and rejects a missing target", () => {
  const body = buildSoundEffectRequestBody(
    { modelProvider: "openai-codex", soundEffectTranslationRegions: regions },
    [],
  );
  expect(body).toMatchObject({ text: { format: { type: "json_schema" } } });
  expect(() => buildSoundEffectRequestBody({}, [])).toThrow("target");
});
