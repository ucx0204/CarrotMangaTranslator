import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const runtimeHelpers = require("../src/main/runtime/simple-page-translate.cjs") as {
  buildLaunchArgs: (options: { [key: string]: unknown }) => string[];
  buildMessages: (
    options: { [key: string]: unknown },
    imageVariants: Array<{ role: string; dataUrl: string; width?: number; height?: number; originalWidth?: number; originalHeight?: number }>
  ) => Array<{
    role: string;
    content: Array<{ type: string; text?: string; image_url?: { url: string } }>;
  }>;
  buildResponsesRequestBody: (
    options: { [key: string]: unknown },
    imageVariants: Array<{ role: string; dataUrl: string; width?: number; height?: number; originalWidth?: number; originalHeight?: number }>
  ) => {
    model: string;
    instructions: string;
    input: Array<{ role: string; content: Array<{ type: string; text?: string; image_url?: string; detail?: string }> }>;
    reasoning: { effort: string };
    stream: boolean;
    store: boolean;
  };
  getOverlayPrompt: (
    options: { [key: string]: unknown },
    imageVariants: Array<{ role: string; dataUrl?: string; width?: number; height?: number; originalWidth?: number; originalHeight?: number }>
  ) => string;
  collectOcrBboxHints: (options: { [key: string]: unknown }) => Promise<{ hints: Array<{ x1: number; y1: number; x2: number; y2: number }>; diagnostics: unknown[] }>;
  extractModelOutputText: (parsed: unknown) => string;
  inspectModelLaunch: (options: { [key: string]: unknown }) => { launchMode: string; model?: string; reasoningEffort?: string };
  isModelCached: (options: { [key: string]: unknown }) => boolean;
  parseResponsesSseText: (rawText: string) => { outputText: string; eventCount: number; rawResponse: unknown };
};
const {
  buildLaunchArgs,
  buildMessages,
  buildResponsesRequestBody,
  collectOcrBboxHints,
  getOverlayPrompt,
  extractModelOutputText,
  inspectModelLaunch,
  isModelCached,
  parseResponsesSseText
} = runtimeHelpers;

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeCachedAssets({
  hubCacheDir,
  repoId,
  snapshot,
  modelFile,
  includeMmproj = true
}: {
  hubCacheDir: string;
  repoId: string;
  snapshot: string;
  modelFile: string;
  includeMmproj?: boolean;
}): string {
  const snapshotDir = join(hubCacheDir, `models--${repoId.replace(/\//g, "--")}`, "snapshots", snapshot);
  mkdirSync(snapshotDir, { recursive: true });
  writeFileSync(join(snapshotDir, modelFile), "model");
  if (includeMmproj) {
    writeFileSync(join(snapshotDir, "mmproj-BF16.gguf"), "mmproj");
  }
  return snapshotDir;
}

describe("runtime model launch helpers", () => {
  it("treats OpenAI Codex as a remote OAuth-backed endpoint", () => {
    const launch = inspectModelLaunch({
      modelProvider: "openai-codex",
      codexModel: "gpt-5.5",
      codexReasoningEffort: "high"
    });

    expect(launch).toEqual({
      launchMode: "openai-codex",
      model: "gpt-5.5",
      reasoningEffort: "high",
      requiresDownload: false
    });
    expect(isModelCached({ modelProvider: "openai-codex" })).toBe(true);
  });

  it("builds Codex Responses requests with input_image data URLs", () => {
    const requestBody = buildResponsesRequestBody(
      {
        modelProvider: "openai-codex",
        codexModel: "gpt-5.5",
        codexReasoningEffort: "xhigh",
        imageWidth: 836,
        imageHeight: 1188
      },
      [{ role: "openai-vision", dataUrl: "data:image/png;base64,abc123", width: 836, height: 1188, originalWidth: 836, originalHeight: 1188 }]
    );

    expect(requestBody.model).toBe("gpt-5.5");
    expect(requestBody.reasoning.effort).toBe("xhigh");
    expect(requestBody.stream).toBe(true);
    expect(requestBody.store).toBe(false);
    expect(requestBody.input[0]?.content.some((part) => part.type === "input_image" && part.image_url === "data:image/png;base64,abc123" && part.detail === "original")).toBe(true);
    expect(requestBody.input[0]?.content[0]).toMatchObject({ type: "input_image", image_url: "data:image/png;base64,abc123" });
    expect(requestBody.input[0]?.content[1]).toMatchObject({ type: "input_text" });
    expect(requestBody).not.toHaveProperty("max_tokens");
  });

  it("uses tight Japanese glyph bbox instructions for Codex Responses requests", () => {
    const requestBody = buildResponsesRequestBody(
      {
        modelProvider: "openai-codex",
        codexModel: "gpt-5.5",
        codexReasoningEffort: "medium",
        imageWidth: 7680,
        imageHeight: 4320
      },
      [{ role: "openai-vision", dataUrl: "data:image/png;base64,abc123", width: 4256, height: 2400, originalWidth: 7680, originalHeight: 4320 }]
    );
    const promptText = requestBody.input[0]?.content.find((part) => part.type === "input_text" && part.text?.includes("# Task"))?.text ?? "";
    const imageDescription = requestBody.input[0]?.content.find((part) => part.type === "input_text" && part.text?.includes("Image 1:"))?.text ?? "";

    expect(requestBody.instructions).toContain("Geometry accuracy comes before Korean text fit");
    expect(requestBody.instructions).toContain("Never merge separate speech bubbles, including touching or stacked balloon lobes.");
    expect(promptText).toContain("Detect every visible Japanese text group");
    expect(promptText).toContain("You are given one full-page Japanese manga image.");
    expect(promptText).toContain("fontSize is the apparent Japanese glyph size in Image 1 pixels");
    expect(promptText).toContain("x1, y1, x2, y2 describe the tight rectangle corners of the visible Japanese glyph ink and its outline.");
    expect(promptText).toContain("Each speech bubble is one dialogue item.");
    expect(promptText).toContain("If two white balloon lobes touch, overlap, stack vertically, or connect through a narrow neck");
    expect(promptText).toContain("Never enlarge, shift, or reshape the rectangle");
    expect(promptText).toContain("The original page is 7680x4320 px.");
    expect(promptText).toContain("Image 1 was prepared before the API call to match the OpenAI detail: original vision frame");
    expect(promptText).toContain("Return x1, y1, x2, y2 as integer pixel coordinates in that 4256x2400 Image 1 frame.");
    expect(requestBody.input[0]?.content.find((part) => part.type === "input_text" && part.text?.includes("# Task"))?.text).not.toContain("Return x, y, w, h as normalized 0..1000");
    expect(imageDescription).toContain("prepared for OpenAI detail: original vision");
    expect(promptText).toContain("Do not return width/height, original-page pixels, normalized 0..1000 coordinates, viewport coordinates, crop coordinates, tile coordinates, or model-internal coordinates.");
  });

  it("uses OCR bbox candidates as single-pass geometry hints", () => {
    const options = {
      modelProvider: "openai-codex",
      imageWidth: 836,
      imageHeight: 1188,
      ocrBboxHints: [
        { id: 1, label: "text", x1: 67, y1: 589, x2: 267, y2: 760 },
        { id: 2, label: "text", x1: 83, y1: 767, x2: 239, y2: 1029 }
      ]
    };
    const variants = [{ role: "openai-vision", dataUrl: "data:image/png;base64,abc123", width: 836, height: 1188, originalWidth: 836, originalHeight: 1188 }];
    const prompt = getOverlayPrompt(options, variants);

    expect(prompt).toContain("# OCR bbox candidates");
    expect(prompt).toContain("Text content is intentionally omitted");
    expect(prompt).toContain("Treat each candidate as a locked geometry slot.");
    expect(prompt).toContain("Required candidate ids: 1, 2.");
    expect(prompt).toContain("candidate 1: label:text x1:67 y1:589 x2:267 y2:760");
    expect(prompt).toContain("candidate 2: label:text x1:83 y1:767 x2:239 y2:1029");
    expect(prompt).toContain("Do not merge two candidates into one record");
    expect(prompt).toContain("add a new record with id greater than 2");
    expect(prompt).not.toContain("Find one anchor point");
  });

  it("normalizes bbox hint JSON without passing OCR text into the prompt contract", async () => {
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
          { label: "image", bbox: [0, 0, 100, 100], content: "ignored" }
        ]
      }),
      "utf8"
    );

    const result = await collectOcrBboxHints({
      imageWidth: 836,
      imageHeight: 1188,
      ocrBboxHintsPath: hintPath
    });

    expect(result.hints).toHaveLength(1);
    expect(result.hints[0]).toMatchObject({ x1: 67, y1: 589, x2: 267, y2: 760 });
  });

  it("uses the same tight Japanese glyph bbox prompt for Gemma chat requests", () => {
    const messages = buildMessages(
      {
        modelProvider: "gemma",
        imageWidth: 836,
        imageHeight: 1188
      },
      [{ role: "original", dataUrl: "data:image/png;base64,abc123" }]
    );
    const systemText = messages[0]?.content.find((part) => part.type === "text")?.text ?? "";
    const userPrompt = messages[1]?.content.find((part) => part.type === "text" && part.text?.includes("# Task"))?.text ?? "";

    expect(systemText).toContain("Geometry accuracy comes before Korean text fit");
    expect(messages[1]?.content[0]).toMatchObject({ type: "image_url" });
    expect(messages[1]?.content[1]).toMatchObject({ type: "text" });
    expect(userPrompt).toContain("Detect every visible Japanese text group");
    expect(userPrompt).toContain("Return x1, y1, x2, y2 as normalized 0..1000");
    expect(userPrompt).toContain("direction, angle, fontSize");
    expect(userPrompt).toContain("For SFX, box only the sound-effect glyph strokes");
    expect(userPrompt).not.toContain("speech bubble, narration box, name call, or sound-effect block");
  });

  it("extracts text from Responses API output payloads", () => {
    expect(
      extractModelOutputText({
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: "id: 1\nko: 테스트"
              }
            ]
          }
        ]
      })
    ).toBe("id: 1\nko: 테스트");
  });

  it("collects Responses API streaming text deltas", () => {
    const parsed = parseResponsesSseText(
      [
        'event: response.output_text.delta',
        'data: {"type":"response.output_text.delta","delta":"id: 1"}',
        "",
        'event: response.output_text.delta',
        'data: {"type":"response.output_text.delta","delta":"\\nko: 테스트"}',
        "",
        'event: response.completed',
        'data: {"type":"response.completed","response":{"id":"resp_1","output":[]}}',
        "",
        "data: [DONE]",
        ""
      ].join("\n")
    );

    expect(parsed.outputText).toBe("id: 1\nko: 테스트");
    expect(parsed.eventCount).toBe(3);
  });

  it("launches an explicitly configured local GGUF without Hugging Face flags", () => {
    const localDir = createTempDir("local-model-");
    const modelPath = join(localDir, "supergemma-q4.gguf");
    const mmprojPath = join(localDir, "mmproj-BF16.gguf");
    writeFileSync(modelPath, "model");
    writeFileSync(mmprojPath, "mmproj");

    const args = buildLaunchArgs({
      port: 18180,
      fitTargetMb: 4096,
      gpuLayers: 30,
      ctx: 16384,
      batch: 32,
      ubatch: 32,
      modelSource: "local",
      localModelPath: modelPath,
      localMmprojPath: mmprojPath
    });

    expect(args).toContain("-m");
    expect(args).toContain(modelPath);
    expect(args).toContain("--mmproj");
    expect(args).toContain(mmprojPath);
    expect(args).not.toContain("-hf");
    expect(args).not.toContain("-hff");
    expect(isModelCached({ modelSource: "local", localModelPath: modelPath })).toBe(true);
  });

  it("prefers cached local model and mmproj paths when both exist", () => {
    const hubCacheDir = createTempDir("hf-cache-");
    const modelFile = "gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf";
    const repoId = "unsloth/gemma-4-26B-A4B-it-GGUF";
    const snapshotDir = writeCachedAssets({
      hubCacheDir,
      repoId,
      snapshot: "snapshot-new",
      modelFile
    });

    const args = buildLaunchArgs({
      port: 18180,
      fitTargetMb: 4096,
      gpuLayers: 30,
      ctx: 16384,
      batch: 32,
      ubatch: 32,
      modelRepo: repoId,
      modelFile,
      hfHubCacheDir: hubCacheDir
    });

    expect(args).toContain("-m");
    expect(args).toContain(join(snapshotDir, modelFile));
    expect(args).toContain("--mmproj");
    expect(args).toContain(join(snapshotDir, "mmproj-BF16.gguf"));
    expect(args).not.toContain("-hf");
    expect(args).not.toContain("-hff");
    expect(isModelCached({ modelRepo: repoId, modelFile, hfHubCacheDir: hubCacheDir })).toBe(true);
  });

  it("falls back to Hugging Face repo launch when mmproj is missing", () => {
    const hubCacheDir = createTempDir("hf-cache-");
    const modelFile = "gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf";
    const repoId = "unsloth/gemma-4-26B-A4B-it-GGUF";
    writeCachedAssets({
      hubCacheDir,
      repoId,
      snapshot: "snapshot-partial",
      modelFile,
      includeMmproj: false
    });

    const args = buildLaunchArgs({
      port: 18180,
      fitTargetMb: 4096,
      gpuLayers: 30,
      ctx: 16384,
      batch: 32,
      ubatch: 32,
      modelRepo: repoId,
      modelFile,
      hfHubCacheDir: hubCacheDir
    });

    expect(args).toContain("-hf");
    expect(args).toContain(repoId);
    expect(args).toContain("-hff");
    expect(args).toContain(modelFile);
    expect(args).not.toContain("--mmproj");
    expect(isModelCached({ modelRepo: repoId, modelFile, hfHubCacheDir: hubCacheDir })).toBe(false);
  });

  it("detects cached assets from HF_HOME when HF_HUB_CACHE is unset", () => {
    const hfHomeDir = createTempDir("hf-home-");
    const previousHfHome = process.env.HF_HOME;
    const previousHubCache = process.env.HF_HUB_CACHE;
    const previousLegacyHubCache = process.env.HUGGINGFACE_HUB_CACHE;
    delete process.env.HF_HUB_CACHE;
    delete process.env.HUGGINGFACE_HUB_CACHE;
    process.env.HF_HOME = hfHomeDir;

    const modelFile = "gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf";
    const repoId = "unsloth/gemma-4-26B-A4B-it-GGUF";
    writeCachedAssets({
      hubCacheDir: join(hfHomeDir, "hub"),
      repoId,
      snapshot: "snapshot-env",
      modelFile
    });

    try {
      expect(isModelCached({ modelRepo: repoId, modelFile })).toBe(true);
    } finally {
      if (previousHfHome === undefined) {
        delete process.env.HF_HOME;
      } else {
        process.env.HF_HOME = previousHfHome;
      }
      if (previousHubCache === undefined) {
        delete process.env.HF_HUB_CACHE;
      } else {
        process.env.HF_HUB_CACHE = previousHubCache;
      }
      if (previousLegacyHubCache === undefined) {
        delete process.env.HUGGINGFACE_HUB_CACHE;
      } else {
        process.env.HUGGINGFACE_HUB_CACHE = previousLegacyHubCache;
      }
    }
  });
});
