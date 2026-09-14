import { afterEach, describe, expect, it, vi } from "vitest";
import {
  basePipelineOptions,
  cleanupPipelineTempDirs,
  loadPipeline,
  makeEmptyWorkContext,
  makePage,
} from "./helpers/wholePagePipelineHarness";
import {
  translationWithPageContext,
  successTranslationResult,
} from "./helpers/wholePageTranslationResults";
import type { PreparedTranslationCheckpoint } from "../src/main/pipeline/preparedTranslationCheckpointContract";
import type { MangaPage } from "../src/shared/libraryTypes";
import { createPageRevision } from "../src/shared/pageRevision";
import type { TranslationOptions } from "../src/main/appSettings";
import { makeAutomaticFontCandidate } from "./helpers/automaticFontCandidate";
import { makePage as makeInpaintingPage } from "./inpaintingSelectionJobFixtures";

afterEach(cleanupPipelineTempDirs);

function withoutVolatileFields(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (key, value: unknown) =>
      [
        "id",
        "createdAt",
        "updatedAt",
        "processingTiming",
        "elapsedMs",
        "modelElapsedMs",
      ].includes(key)
        ? undefined
        : typeof value === "string"
          ? value.replace(/glossary-[0-9a-f-]{36}/g, "glossary-generated")
          : value,
    ),
  );
}

describe("whole page input handoff parity", () => {
  it("hands off and saves an OCR-empty page before releasing its ownership", async () => {
    const page = makePage("no-text", "empty.png");
    const requestTranslation = vi.fn();
    const order: string[] = [];
    const pipeline = await loadPipeline({
      ocrHintsByImagePath: new Map([
        [
          page.imagePath,
          {
            hints: [],
            diagnostics: [],
            noTextDetected: true,
            textEvidenceCount: 0,
          },
        ],
      ]),
      requestTranslation,
    });
    const result = await pipeline.runWholePagePipeline({
      ...basePipelineOptions([page], []),
      acquirePage: async () => {
        order.push("input");
        return page;
      },
      onPageComplete: async () => {
        order.push("save");
        return true;
      },
      onPageSettled: () => {
        order.push("release");
      },
    });
    expect(order).toEqual(["input", "save", "release"]);
    expect(requestTranslation).not.toHaveBeenCalled();
    expect(result.pages[0]).toMatchObject({
      id: page.id,
      analysisStatus: "completed",
      blocks: [],
    });
  });

  it.each(["auto", "keep"] as const)(
    "preserves %s mode font results and releases after typography",
    async (blockMode) => {
      const page = makePage("a", "001.png", {
        blocks: makeInpaintingPage("a", "001.png").blocks,
      });
      const run = async (handoff: boolean) => {
        const order: string[] = [];
        const inferPage = vi.fn(async () => {
          order.push("font");
          return { pixelInferenceByBlockId: new Map() };
        });
        const pipeline = await loadPipeline({
          fontMatchingCandidates: [makeAutomaticFontCandidate()],
          fontMatchingPageInference: { inferPage },
        });
        const result = await pipeline.runWholePagePipeline({
          ...basePipelineOptions([structuredClone(page)], []),
          blockMode,
          skipOcrPrepass: true,
          autoFontMatching: true,
          acquirePage: handoff
            ? async () => {
                order.push("input");
                return structuredClone(page);
              }
            : undefined,
          onPageComplete: async () => {
            order.push("save");
            return true;
          },
          onPageSettled: handoff
            ? () => {
                order.push("release");
              }
            : undefined,
        });
        return { result, order, inferPage };
      };
      const before = await run(false);
      const after = await run(true);
      expect(withoutVolatileFields(after.result.pages)).toEqual(
        withoutVolatileFields(before.result.pages),
      );
      expect(after.inferPage).toHaveBeenCalledTimes(
        before.inferPage.mock.calls.length,
      );
      expect(after.order[0]).toBe("input");
      expect(after.order.slice(-2)).toEqual(["save", "release"]);
    },
  );
  it("preserves unchanged translation, context order and checkpoint inputs", async () => {
    const pages = [makePage("a", "001.png"), makePage("b", "002.png")];
    const run = async (handoff: boolean) => {
      const request = vi.fn(async () =>
        translationWithPageContext("勇者", "용사", {
          visualSummary: "문을 연다.",
          glossary: [{ source: "勇者", target: "용사", category: "term" }],
          characters: [],
        }),
      );
      const pipeline = await loadPipeline({ requestTranslation: request });
      const checkpoints: PreparedTranslationCheckpoint[] = [];
      const order: string[] = [];
      const result = await pipeline.runWholePagePipeline({
        ...basePipelineOptions(structuredClone(pages), []),
        collectPageContext: true,
        workContext: makeEmptyWorkContext(),
        acquirePage: handoff
          ? async (id) => {
              order.push(`input:${id}`);
              const page = pages.find((page) => page.id === id);
              if (!page) throw new Error("Missing page fixture.");
              return structuredClone(page);
            }
          : undefined,
        onPagePrepared: async (checkpoint) => {
          checkpoints.push(checkpoint);
          return true;
        },
        onPageComplete: async (page) => {
          order.push(`save:${page.id}`);
          return true;
        },
        onPageSettled: handoff
          ? (id) => {
              order.push(`release:${id}`);
            }
          : undefined,
      });
      return { result, checkpoints, order, pipeline, request };
    };
    const previous = await run(false);
    const next = await run(true);
    expect(withoutVolatileFields(next.result.pages)).toEqual(
      withoutVolatileFields(previous.result.pages),
    );
    expect(
      next.checkpoints.map((checkpoint) => checkpoint.inputRevision),
    ).toEqual(
      previous.checkpoints.map((checkpoint) => checkpoint.inputRevision),
    );
    expect(
      withoutVolatileFields(
        next.pipeline.runtime.saveChapterStoryMemory.mock.calls,
      ),
    ).toEqual(
      withoutVolatileFields(
        previous.pipeline.runtime.saveChapterStoryMemory.mock.calls,
      ),
    );
    expect(next.order).toEqual([
      "input:a",
      "input:b",
      "save:a",
      "release:a",
      "save:b",
      "release:b",
    ]);
  });

  it("invalidates an old checkpoint after handoff and consumes the edited page", async () => {
    const original = makePage("a", "001.png");
    let checkpoint: PreparedTranslationCheckpoint | undefined;
    const seed = await loadPipeline();
    await seed.runWholePagePipeline({
      ...basePipelineOptions([original], []),
      onPagePrepared: async (value) => {
        checkpoint = value;
        return true;
      },
    });
    if (!checkpoint) throw new Error("No checkpoint was produced");
    const edited = {
      ...original,
      inpaintedImagePath: "new-edit.png",
      width: 1200,
    };
    const requested = vi.fn(
      async (_server: unknown, options: TranslationOptions) => {
        expect(options.pageId).toBe(edited.id);
        return successTranslationResult();
      },
    );
    const pipeline = await loadPipeline({ requestTranslation: requested });
    const saved: MangaPage[] = [];
    const prepared: PreparedTranslationCheckpoint[] = [];
    await pipeline.runWholePagePipeline({
      ...basePipelineOptions([original], []),
      translationCheckpoints: new Map([[original.id, checkpoint]]),
      acquirePage: async () => edited,
      onPagePrepared: async (value) => {
        prepared.push(value);
        return true;
      },
      onPageComplete: async (page) => {
        saved.push(page);
        return true;
      },
    });
    expect(requested).toHaveBeenCalledOnce();
    expect(prepared[0].inputRevision).toBe(createPageRevision(edited));
    expect(saved[0].width).toBe(1200);
  });

  it("keeps a compatible checkpoint reusable after an unchanged handoff", async () => {
    const original = makePage("a", "001.png");
    let checkpoint: PreparedTranslationCheckpoint | undefined;
    const seed = await loadPipeline();
    await seed.runWholePagePipeline({
      ...basePipelineOptions([original], []),
      onPagePrepared: async (value) => {
        checkpoint = value;
        return true;
      },
    });
    if (!checkpoint) throw new Error("No checkpoint was produced");
    const request = vi.fn();
    const pipeline = await loadPipeline({ requestTranslation: request });
    const release = vi.fn();
    await pipeline.runWholePagePipeline({
      ...basePipelineOptions([original], []),
      translationCheckpoints: new Map([[original.id, checkpoint]]),
      acquirePage: async () => structuredClone(original),
      onPageComplete: async () => true,
      onPageSettled: release,
    });
    expect(request).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith(original.id, false);
  });
});
