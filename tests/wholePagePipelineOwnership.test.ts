import { describe, expect, it, vi } from "vitest";
import type { MangaPage } from "../src/shared/libraryTypes";
import type { PipelineOptions } from "../src/main/pipeline/types";

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: () => "C:\\unused-app-data",
  },
}));

import { runWholePagePipeline } from "../src/main/wholePagePipeline";

function makePage(): MangaPage {
  return {
    id: "page-1",
    name: "001.png",
    imagePath: "001.png",
    dataUrl: "",
    width: 100,
    height: 100,
    blocks: [],
    analysisStatus: "idle",
    createdAt: "2026-08-22T00:00:00.000Z",
    updatedAt: "2026-08-22T00:00:00.000Z",
  };
}

function minimalOptions(
  pages: MangaPage[],
  signal = new AbortController().signal,
): PipelineOptions {
  return { pages, signal } as PipelineOptions;
}

describe("whole page pipeline dependency ownership", () => {
  it("does not allocate default dependencies for an empty run", async () => {
    await expect(runWholePagePipeline(minimalOptions([]))).resolves.toEqual({
      pages: [],
      warnings: [],
    });
  });

  it("preserves the abort error while releasing default dependencies", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      runWholePagePipeline(minimalOptions([makePage()], controller.signal)),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
