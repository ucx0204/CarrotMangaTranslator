import { describe, expect, it, vi } from "vitest";

import { runPageTypographyStages } from "../src/main/pipeline/pageTypographyStages";

describe("page typography stages", () => {
  it("overlaps independent pixel-font and source-size inference without changing either result", async () => {
    const font = deferred<{ pixelInferenceByBlockId: Map<string, never> }>();
    const size = deferred<readonly [undefined]>();
    const fontMatching = vi.fn(() => font.promise);
    const fontSize = vi.fn(() => size.promise);
    const logInfo = vi.fn();

    const pending = runPageTypographyStages(
      {
        jobId: "job-parallel-typography",
        page: { id: "page-1" },
        pageOptions: {
          autoFontMatching: true,
          fontSizeAutoFit: true,
          keepBlocksMode: false,
        },
        items: [{}],
      } as never,
      {
        runFontMatching: fontMatching,
        estimateSourceFontSizes: fontSize,
        logInfo,
      } as never,
    );

    expect(fontMatching).toHaveBeenCalledTimes(1);
    expect(fontSize).toHaveBeenCalledTimes(1);
    const fontResult = { pixelInferenceByBlockId: new Map<string, never>() };
    const sizeResult = [undefined] as const;
    font.resolve(fontResult);
    size.resolve(sizeResult);

    await expect(pending).resolves.toEqual({
      pixelInference: fontResult,
      sourceFontSizeEstimates: sizeResult,
    });
    expect(logInfo).toHaveBeenCalledWith(
      "Page typography stages completed",
      expect.objectContaining({
        jobId: "job-parallel-typography",
        pageId: "page-1",
        itemCount: 1,
      }),
    );
  });

  it("does not emit timing diagnostics when both automatic stages are disabled", async () => {
    const logInfo = vi.fn();
    const fontResult = { pixelInferenceByBlockId: new Map<string, never>() };
    const sizeResult = [undefined] as const;

    await expect(
      runPageTypographyStages(
        {
          jobId: "job-disabled-typography",
          page: { id: "page-2" },
          pageOptions: {
            autoFontMatching: false,
            fontSizeAutoFit: false,
            keepBlocksMode: false,
          },
          items: [{}],
        } as never,
        {
          runFontMatching: vi.fn(async () => fontResult),
          estimateSourceFontSizes: vi.fn(async () => sizeResult),
          logInfo,
        } as never,
      ),
    ).resolves.toEqual({
      pixelInference: fontResult,
      sourceFontSizeEstimates: sizeResult,
    });
    expect(logInfo).not.toHaveBeenCalled();
  });

  it("measures source font sizes when automatic fitting is enabled for kept blocks", async () => {
    const estimateSourceFontSizes = vi.fn(async () => [
      { confidence: 0.91, facePx: 28, method: "raster-core-v1" as const },
    ]);

    await runPageTypographyStages(
      {
        jobId: "job-keep-typography",
        page: { id: "page-keep" },
        pageOptions: {
          autoFontMatching: false,
          fontSizeAutoFit: true,
          keepBlocksMode: true,
        },
        items: [{}],
      } as never,
      {
        runFontMatching: vi.fn(async () => ({
          pixelInferenceByBlockId: new Map<string, never>(),
        })),
        estimateSourceFontSizes,
        logInfo: vi.fn(),
      } as never,
    );

    expect(estimateSourceFontSizes).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true }),
    );
  });
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
