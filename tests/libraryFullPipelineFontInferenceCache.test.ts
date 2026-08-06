import path from "node:path";
import { describe, expect, it } from "vitest";

type CacheModule = {
  CACHE_VALIDATION_VERSION: number;
  resolveFontReplayInferencePath: (
    cacheFrom: string,
    record: unknown,
    cached: unknown,
  ) => string;
  restoreCachedFontInference: (options: Record<string, unknown>) => {
    runtimeArtifactStatus: unknown;
    pixelInferenceByBlockId: Map<string, unknown>;
  };
};

const cache =
  require("../scripts/library-full-pipeline-qa/font-replay-inference-cache.cjs") as CacheModule;

describe("font replay verified inference cache", () => {
  it("restores a validated subset as a block-addressed Map", () => {
    const fixture = makeFixture();
    const restored = cache.restoreCachedFontInference(fixture);

    expect(restored.runtimeArtifactStatus).toEqual(
      fixture.currentRuntime.status,
    );
    expect([...restored.pixelInferenceByBlockId.keys()]).toEqual(["block-b"]);
    expect(restored.pixelInferenceByBlockId.get("block-a")).toBeUndefined();
    expect(restored.pixelInferenceByBlockId.get("block-b")).toEqual(
      fixture.trace.pixelInference[0],
    );
  });

  it.each([
    ["runtime artifact", mutateRuntime, "runtime_artifact_mismatch"],
    ["renderer", mutateRenderer, "pixel_inference_identity_mismatch"],
    ["boundary", mutateBoundary, "pixel_inference_identity_mismatch"],
    ["page id", mutatePageId, "pixel_inference_identity_mismatch"],
    ["block order", mutateBlockOrder, "request_blocks_mismatch"],
    ["block id", mutateBlockId, "pixel_block_ids_mismatch"],
    ["retired font policy", mutateRetiredFont, "retired_font_policy_mismatch"],
    [
      "glyph morphology",
      mutateGlyphMorphology,
      "glyph_morphology_contract_mismatch",
    ],
  ])("rejects %s drift", (_label, mutate, code) => {
    const fixture = makeFixture();
    mutate(fixture);

    expect(() => cache.restoreCachedFontInference(fixture)).toThrow(
      expect.objectContaining({ code }),
    );
  });

  it("rejects an explicit inference path outside the source run", () => {
    expect(() =>
      cache.resolveFontReplayInferencePath(
        "C:\\cache-run",
        { selectionIndex: 0 },
        {
          selectionIndex: 0,
          fontInferencePath: "C:\\different-run\\font-inference.json",
        },
      ),
    ).toThrow(
      expect.objectContaining({ code: "inference_path_outside_cache_run" }),
    );
  });

  it("uses the deterministic inference path when the report omits it", () => {
    expect(
      cache.resolveFontReplayInferencePath(
        "C:\\cache-run",
        { selectionIndex: 8 },
        { selectionIndex: 8 },
      ),
    ).toBe(path.join("C:\\cache-run", "pages", "09", "font-inference.json"));
  });

  it("allows a legacy cache without morphology and leaves fail-closed policy to runtime", () => {
    const fixture = makeFixture();
    Reflect.deleteProperty(fixture.trace.pixelInference[0], "glyphMorphology");

    const restored = cache.restoreCachedFontInference(fixture);

    expect(cache.CACHE_VALIDATION_VERSION).toBe(2);
    expect(restored.pixelInferenceByBlockId.get("block-b")).not.toHaveProperty(
      "glyphMorphology",
    );
  });

  it("accepts a retired font that is absent from the sealed active inventory", () => {
    const fixture = makeFixture();
    fixture.currentRuntime.status.candidateIds = ["body"];
    fixture.trace.runtimeArtifactStatus.candidateIds = ["body"];
    fixture.trace.pixelInference[0].localEvidence.rankedCandidates =
      fixture.trace.pixelInference[0].localEvidence.rankedCandidates.filter(
        (candidate) => candidate.fontId !== "gugi",
      );

    const restored = cache.restoreCachedFontInference(fixture);

    expect(restored.pixelInferenceByBlockId.get("block-b")).toBeDefined();
  });
});

type Fixture = ReturnType<typeof makeFixture>;

function makeFixture() {
  const imageSha = "a".repeat(64);
  const rendererHash = "b".repeat(64);
  const status = {
    state: "ready",
    automaticMutationAllowed: true,
    semanticBootstrapAllowed: false,
    modelVersion: "model-v1",
    catalogVersion: "catalog-v1",
    candidateIds: ["body", "gugi"],
    candidateOrderSha256: "c".repeat(64),
    calibration: { temperature: 1, noneThreshold: 0.5 },
    policy: { automaticMutation: { minimumAutomaticConfidence: 0.8 } },
  };
  const requestBlocks = [
    { blockId: "block-a", item: { sourceText: "A" } },
    { blockId: "block-b", item: { sourceText: "B" } },
  ];
  return {
    cachedPage: {
      status: "completed",
      selectionIndex: 0,
      sourcePageId: "page-1",
      sourcePageSha256: imageSha,
    },
    currentRuntime: {
      status,
      rendererHash,
      retiredFontIds: ["gugi"],
    },
    fontInput: {
      sourcePageId: "page-1",
      sourcePageSha256: imageSha,
      requestBlocks,
    },
    record: {
      selectionIndex: 0,
      page: { id: "page-1", imageSha256: imageSha },
    },
    trace: {
      requestBlocks: structuredClone(requestBlocks),
      runtimeArtifactStatus: structuredClone(status),
      pixelInference: [
        {
          kind: "verified_pixel_inference",
          pageId: "page-1",
          blockId: "block-b",
          modelVersion: "model-v1",
          candidateOrderSha256: "c".repeat(64),
          inputBoundary: {
            source: "user_page",
            datasetSplit: null,
            qaOverlay: false,
          },
          glyphMorphology: {
            contractVersion: "font-matching-glyph-morphology-v1",
            maskSource: "raw_grayscale_otsu_minority_area3",
            distanceTransform: "opencv_dist_l2_mask5",
            connectivity: 8,
            maskWidth: 40,
            maskHeight: 20,
            otsuThreshold: 90,
            foregroundPolarity: "dark",
            foregroundPixelCount: 120,
            connectedComponentCount: 3,
            globalForegroundDistanceMean: 1.8,
            medianComponentDistanceMean: 1.75,
            medianComponentFill: 0.61,
            foregroundMeanLuma: 30,
            backgroundMeanLuma: 230,
          },
          localEvidence: {
            catalogVersion: "catalog-v1",
            modelVersion: "model-v1",
            rendererHash,
            rankedCandidates: [
              {
                rank: 1,
                fontId: "body",
                renderStatus: "rendered",
                confidence: 0.8,
                reasonCodes: ["verified_pixel_model"],
              },
              {
                rank: 2,
                fontId: "gugi",
                renderStatus: "unrenderable",
                unrenderableReason: "font_retired_by_product_policy",
                confidence: 0,
                reasonCodes: ["font_retired_by_product_policy"],
              },
            ],
          },
        },
      ],
    },
  };
}

function mutateRuntime(fixture: Fixture): void {
  fixture.currentRuntime.status.modelVersion = "model-v2";
}

function mutateRenderer(fixture: Fixture): void {
  fixture.trace.pixelInference[0].localEvidence.rendererHash = "d".repeat(64);
}

function mutateBoundary(fixture: Fixture): void {
  fixture.trace.pixelInference[0].inputBoundary.qaOverlay = true;
}

function mutatePageId(fixture: Fixture): void {
  fixture.trace.pixelInference[0].pageId = "different-page";
}

function mutateBlockOrder(fixture: Fixture): void {
  fixture.trace.requestBlocks.reverse();
}

function mutateBlockId(fixture: Fixture): void {
  fixture.trace.pixelInference[0].blockId = "different-block";
}

function mutateRetiredFont(fixture: Fixture): void {
  const retired =
    fixture.trace.pixelInference[0].localEvidence.rankedCandidates[1];
  retired.renderStatus = "rendered";
  retired.unrenderableReason = "not-retired";
}

function mutateGlyphMorphology(fixture: Fixture): void {
  fixture.trace.pixelInference[0].glyphMorphology.distanceTransform =
    "different_transform";
}
