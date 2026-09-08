import { afterEach, expect, it, vi } from "vitest";
import {
  loadPipeline,
  cleanupPipelineTempDirs,
  makePage,
  basePipelineOptions,
} from "./helpers/wholePagePipelineHarness";
import { regionSoundTranslationResult } from "./helpers/wholePageTranslationResults";
import { createCodexTypesettingPreferences } from "../src/shared/codexTypesettingDefaults";
import {
  CodexImageEditError,
  editTranslatedPageWithCodex,
} from "../src/main/codexImageEditing";
import { CodexLetteringGenerationError } from "../src/main/pipeline/codexTypesettingLettering";
import { makeBlock } from "./unifiedInpaintingUiFixtures";
import type { CodexImageEdit } from "../src/main/codexImageEditing";
import type { JobEvent } from "../src/shared/jobTypes";
afterEach(cleanupPipelineTempDirs);

it("rejects stale full-page Codex delegation before requesting translation or images", async () => {
  const requestTranslation = vi.fn();
  const editImages = vi.fn();
  const { runWholePagePipeline } = await loadPipeline({
    requestTranslation,
    editImages,
  });
  const preferences = createCodexTypesettingPreferences("ko");
  await expect(
    runWholePagePipeline({
      ...basePipelineOptions([makePage("source", "page.png")], []),
      codexTypesetting: {
        version: 1,
        preset: preferences.presets[0],
        eraseOriginal: true,
        sfxRendering: "image",
      },
    }),
  ).rejects.toThrow("전체 Codex 위임");
  expect(requestTranslation).not.toHaveBeenCalled();
  expect(editImages).not.toHaveBeenCalled();
});

it.each(["complete", "partial", "error", "cancel"])(
  "keeps the normal region translation before auxiliary image outcome=%s",
  async (outcome) => {
    const events: JobEvent[] = [];
    const source = makePage("source", "page.png");
    const crop = makePage("crop", "crop.png", { width: 240, height: 180 });
    const controller = new AbortController();
    const requestTranslation = vi
      .fn()
      .mockResolvedValue(regionSoundTranslationResult());
    const editImages = vi.fn(async (input: CodexImageEdit) => {
      expect(input.page.blocks[0].translatedText).toBeTruthy();
      expect(requestTranslation).toHaveBeenCalledOnce();
      expect(await input.decode(input.page.imagePath)).toBeNull();
      input.progress({ stage: "images", step: "background" });
      const edited = { ...input.page, inpaintedImagePath: "clean.png" };
      if (outcome === "partial")
        throw new CodexImageEditError(
          edited,
          new Error("image generation failed"),
        );
      if (outcome === "error") throw "image transport failed";
      if (outcome === "cancel") {
        controller.abort();
        throw controller.signal.reason;
      }
      return edited;
    });
    const { runWholePagePipeline } = await loadPipeline({
      requestTranslation,
      editImages,
    });
    const preferences = createCodexTypesettingPreferences("ko");
    const options = {
      ...basePipelineOptions([crop], events),
      signal: controller.signal,
      codexTypesetting: {
        version: 1 as const,
        preset: preferences.presets[0],
        eraseOriginal: true,
        sfxRendering: "image" as const,
      },
      regionContext: {
        sourcePage: source,
        sourcePageIndex: 0,
        cropRect: { x: 0, y: 0, w: 240, h: 180 },
      },
    };
    if (outcome === "cancel") {
      await expect(runWholePagePipeline(options)).rejects.toMatchObject({
        name: "AbortError",
      });
      return;
    }
    const result = await runWholePagePipeline(options);
    expect(editImages).toHaveBeenCalledOnce();
    expect(result.pages[0].blocks.length).toBeGreaterThan(0);
    expect(result.pages[0].inpaintedImagePath).toBe(
      outcome === "error" ? undefined : "clean.png",
    );
    expect(result.imageEditingError).toBe(
      outcome === "complete"
        ? undefined
        : outcome === "partial"
          ? "image generation failed"
          : "image transport failed",
    );
    expect(
      events.some((event) => event.codexProgress?.stage === "images"),
    ).toBe(true);
  },
);

it("applies confirmed geometry and wording before returning text-only output", async () => {
  const page = { ...makePage("reviewed", "source.png"), blocks: [makeBlock()] };
  const sourceBbox = { x: 100, y: 200, w: 300, h: 400 };
  const result = await editTranslatedPageWithCodex({
    page,
    directory: "unused",
    signal: new AbortController().signal,
    eraseOriginal: false,
    output: "text",
    decode: async () => null,
    progress: () => {},
    confirmReading: async (reading) => ({
      ...reading,
      regions: reading.regions.map((r) => ({
        ...r,
        translatedText: "exact words",
        sourceBbox,
        renderBbox: sourceBbox,
      })),
    }),
  });
  expect(result.blocks[0]).toMatchObject({
    translatedText: "exact words",
    bbox: sourceBbox,
    renderBbox: sourceBbox,
  });
  expect(page.blocks[0].translatedText).not.toBe("exact words");
});
it("retains completed image layers and the real source path after a later layer fails", () => {
  const page = {
    ...makePage("partial", "original.png"),
    blocks: [makeBlock()],
  };
  const partial = {
    ...page,
    imagePath: "temporary-redacted.png",
    blocks: [
      {
        ...page.blocks[0],
        generatedLettering: {
          version: 1 as const,
          dataUrl: "data:image/png;base64,AA==",
          sourceText: "source",
          translatedText: "translation",
        },
      },
    ],
  };
  const cause = new CodexLetteringGenerationError(
    partial,
    "later image failed",
    Error("offline"),
  );
  const error = new CodexImageEditError(page, cause);
  expect(error.page.imagePath).toBe(page.imagePath);
  expect(error.page.blocks).toEqual(partial.blocks);
  expect(error.message).toBe("later image failed");
  expect(error.cause).toBe(cause);
});
