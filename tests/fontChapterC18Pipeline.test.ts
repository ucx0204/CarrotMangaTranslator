import { afterEach, describe, expect, it, vi } from "vitest";
import type { WholePagePipelineDependencies } from "../src/main/pipeline/wholePagePipelinePorts";
import { makeAutomaticFontCandidate } from "./helpers/automaticFontCandidate";
import { successTranslationResult } from "./helpers/wholePageTranslationResults";
import {
  basePipelineOptions,
  cleanupPipelineTempDirs,
  loadPipeline,
  makePage,
} from "./helpers/wholePagePipelineHarness";
afterEach(cleanupPipelineTempDirs);
describe("C18 chapter pipeline integration", () => {
  it("prepares a single source chapter palette after all translations and applies it to each page", async () => {
    const requestTranslation = vi
      .fn()
      .mockResolvedValue(successTranslationResult());
    const prepare = vi.fn<
      NonNullable<
        WholePagePipelineDependencies["fontMatching"]["chapter"]
      >["prepare"]
    >(async (pages) => {
      expect(requestTranslation).toHaveBeenCalledTimes(2);
      expect(pages).toHaveLength(2);
      expect(pages.every((page) => page.items.length > 0)).toBe(true);
      return () => ({
        fontId: "jua",
        fontWeight: 400,
        italic: false,
        groupId: "chapter-source-1",
        runtimeVersion: "c18.1",
      });
    });
    const { runWholePagePipeline, runtime } = await loadPipeline({
      requestTranslation,
      fontMatchingCandidates: [makeAutomaticFontCandidate({ fontId: "jua" })],
      fontMatchingChapter: { prepare },
    });
    const result = await runWholePagePipeline({
      ...basePipelineOptions(
        [makePage("p1", "001.png"), makePage("p2", "002.png")],
        [],
      ),
      autoFontMatching: true,
      aiFontSizeMatching: false,
    });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(runtime.disposeEndpoint.mock.invocationCallOrder[0]).toBeLessThan(
      prepare.mock.invocationCallOrder[0] ?? 0,
    );
    for (const page of result.pages) {
      expect(page.blocks[0]).toMatchObject({
        fontFamily: "jua",
        fontWeight: 400,
        bold: false,
      });
      expect(page.fontContinuity).toBeUndefined();
    }
  });

  it("does not report old page typography as successful when chapter analysis fails", async () => {
    const prepare = vi
      .fn()
      .mockRejectedValue(new Error("C18 asset bytes differ"));
    const onPageComplete = vi.fn();
    const { runWholePagePipeline } = await loadPipeline({
      fontMatchingChapter: { prepare },
      fontMatchingCandidates: [makeAutomaticFontCandidate()],
    });
    await expect(
      runWholePagePipeline({
        ...basePipelineOptions([makePage("p1", "001.png")], []),
        autoFontMatching: true,
        onPageComplete,
      }),
    ).rejects.toThrow("C18 asset bytes differ");
    expect(onPageComplete).not.toHaveBeenCalled();
  });
});
