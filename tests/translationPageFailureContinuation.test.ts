import { afterEach, describe, expect, it, vi } from "vitest";
import type { TranslationOptions } from "../src/main/appSettings";
import {
  basePipelineOptions,
  cleanupPipelineTempDirs,
  loadPipeline,
  makePage,
} from "./helpers/wholePagePipelineHarness";
import { successTranslationResult } from "./helpers/wholePageTranslationResults";

afterEach(async () => {
  delete process.env.MANGA_TRANSLATOR_PAGE_RETRIES;
  vi.clearAllMocks();
  await cleanupPipelineTempDirs();
});

describe("translation page failure continuation", () => {
  it.each([
    undefined,
    "increase-context-length",
    "increase-max-output-tokens",
    "increase-work-context-budget",
  ] as const)(
    "persists exhausted page failures before continuing, retaining guidance %s",
    async (failureGuidance) => {
      process.env.MANGA_TRANSLATOR_PAGE_RETRIES = "2";
      const firstPage = makePage("page-a", "001.png");
      const secondPage = makePage("page-b", "002.png");
      const onPageFailed = vi.fn();
      const requestTranslation = vi.fn(
        async (_server: unknown, options: TranslationOptions) => {
          if (options.imagePath === firstPage.imagePath) {
            throw Object.assign(new Error("response truncated"), {
              outputTruncated: true,
              failureGuidance,
            });
          }
          expect(onPageFailed).toHaveBeenCalledOnce();
          return successTranslationResult();
        },
      );
      const { runWholePagePipeline } = await loadPipeline({
        requestTranslation,
      });
      const result = await runWholePagePipeline({
        ...basePipelineOptions([firstPage, secondPage], []),
        onPageFailed,
      });

      expect(
        requestTranslation.mock.calls.map(([, options]) => options.imagePath),
      ).toEqual([
        firstPage.imagePath,
        firstPage.imagePath,
        secondPage.imagePath,
      ]);
      expect(result.pages.map((page) => page.analysisStatus)).toEqual([
        "failed",
        "completed",
      ]);
      expect(result.pageLocalFailureIds).toEqual([firstPage.id]);
      expect(result.failureGuidance).toBe(failureGuidance);
      expect(onPageFailed).toHaveBeenCalledWith(
        expect.objectContaining({
          id: firstPage.id,
          lastError: "response truncated",
        }),
        "response truncated",
      );
    },
  );

  it("stops when an exhausted page failure cannot be persisted", async () => {
    process.env.MANGA_TRANSLATOR_PAGE_RETRIES = "1";
    const requestTranslation = vi
      .fn()
      .mockRejectedValue(new Error("bad response"));
    const storageError = new Error("failure save rejected");
    const { runWholePagePipeline } = await loadPipeline({ requestTranslation });

    await expect(
      runWholePagePipeline({
        ...basePipelineOptions(
          [makePage("page-a", "001.png"), makePage("page-b", "002.png")],
          [],
        ),
        onPageFailed: vi.fn().mockRejectedValue(storageError),
      }),
    ).rejects.toBe(storageError);
    expect(requestTranslation).toHaveBeenCalledOnce();
  });
});
