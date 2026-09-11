import { expect, it, vi } from "vitest";
import {
  translateStoredSoundEffectRegions,
  type SoundEffectTranslationPageDependencies,
} from "../src/main/jobs/soundEffectTranslationPage";

vi.mock("electron", () => ({ app: { isPackaged: false } }));

const { parseJsonLenient } =
  require("../src/main/runtime/parsing/overlay-json-recovery.cjs") as {
    parseJsonLenient: (text: string) => unknown;
  };
const valid = JSON.stringify({
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

function run(
  requestTranslation: SoundEffectTranslationPageDependencies["requestTranslation"],
  abortController = new AbortController(),
) {
  const region = {
    id: "FX001",
    bbox: { x: 10, y: 10, w: 20, h: 20 },
    detectorConfidence: 0.9,
  };
  return translateStoredSoundEffectRegions(
    {
      abortController,
      context: { decodeImage: vi.fn() } as never,
      endpoint: { server: { baseUrl: "http://model" } } as never,
      pageIndex: 0,
      run: {
        baseOptions: {
          outputDir: "run",
          targetLanguage: "ko",
          ctx: 32768,
          maxTokens: 4096,
          ocrPipeline: "hayai-ocr",
        },
        progressContext: {
          jobId: "job",
          emit: vi.fn(),
          progressTotal: 1,
          pageTotal: 1,
          ocrPipeline: "hayai-ocr",
        },
        runtime: { parseJsonLenient },
      } as never,
      runPaths: { runDir: "run" } as never,
      target: {
        page: {
          id: "page",
          name: "page.png",
          imagePath: "page.png",
          width: 100,
          height: 100,
          blocks: [],
        } as never,
        pageIndex: 0,
        revision: "page-v1:0000000000000000",
        regions: [region],
      },
      workContext: undefined,
    },
    {
      buildImages: vi.fn(async () => ({
        context: { path: "context.png", width: 100, height: 100 },
        crop: { path: "crop.png", width: 50, height: 50 },
      })),
      requestTranslation,
    },
  );
}

it("retries unparseable model output once with JSON feedback", async () => {
  const request: SoundEffectTranslationPageDependencies["requestTranslation"] =
    vi.fn(async ({ pageOptions }) => {
      if (pageOptions.translationAttempt === 1)
        return { outputText: "not JSON" } as never;
      expect(pageOptions.soundEffectRetryFeedback).toContain("JSON");
      return { outputText: valid } as never;
    });
  const result = await run(request);
  expect(request).toHaveBeenCalledTimes(2);
  expect(result.items).toEqual([
    expect.objectContaining({ regionId: "FX001", translation: "쿵" }),
  ]);
});

it("keeps a repeatedly malformed candidate pending without inventing a translation", async () => {
  const request = vi.fn(async () => ({ outputText: "{broken" }) as never);
  const result = await run(request);
  expect(request).toHaveBeenCalledTimes(2);
  expect(result.items).toEqual([]);
  expect(result.warnings.join(" ")).toContain("pending");
});

it("does not disguise transport or artifact-write failures as JSON retries", async () => {
  const failure = new Error("artifact write failed");
  const request = vi.fn(async () => {
    throw failure;
  });
  await expect(run(request)).rejects.toBe(failure);
  expect(request).toHaveBeenCalledTimes(1);
});

it("does not start a retry after cancellation during the response", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled by user");
  const request = vi.fn(async () => {
    controller.abort(reason);
    return { outputText: "not JSON" } as never;
  });
  await expect(run(request, controller)).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(request).toHaveBeenCalledTimes(1);
});
