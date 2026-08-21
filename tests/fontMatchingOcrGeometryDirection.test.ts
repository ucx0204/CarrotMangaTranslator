import { describe, expect, it } from "vitest";
import {
  attachFontMatchingFixedBlockCandidateMembership,
  FONT_MATCHING_OCR_GEOMETRY_DIRECTION_CONTRACT_VERSION,
  readFontMatchingOcrGeometryDirection,
  resolveFontMatchingOcrGeometryDirection,
} from "../src/main/pipeline/fontMatchingOcrGeometryDirection";
import type {
  FontMatchingOcrCandidateMembershipV2,
  OverlayItem,
} from "../src/main/pipeline/types";

describe("Font Matching OCR candidate geometry direction", () => {
  it("mirrors the semantic OCR 1.25 aspect rule and majority tie", () => {
    const item = boundItem([1, 2]);
    const evidence = resolveFontMatchingOcrGeometryDirection(item, [
      hint(1, 20, 26),
      hint(2, 20, 25),
    ]);

    expect(evidence).toEqual({
      contractVersion: FONT_MATCHING_OCR_GEOMETRY_DIRECTION_CONTRACT_VERSION,
      source: "semantic_ocr_candidate_bbox_majority",
      direction: "vertical",
      candidateIds: [1, 2],
      candidateMembership: item.sourceCandidateMembership,
    });
  });

  it("uses only code-owned voters while ignoring raw review roles", () => {
    const item = boundItem([8, 9, 10], [8]);
    const evidence = resolveFontMatchingOcrGeometryDirection(item, [
      hint(8, 20, 80),
      { ...hint(9, 90, 20), reviewRole: "ruby" },
      { ...hint(10, 90, 20), reviewRole: "RUBY" },
    ]);

    expect(evidence).toMatchObject({
      direction: "vertical",
      candidateIds: [8],
      candidateMembership: { originalCandidateIds: [8, 9, 10] },
    });
    expect(
      readFontMatchingOcrGeometryDirection(
        evidence,
        item,
        item.sourceCandidateMembership,
      ),
    ).toEqual(evidence);
  });

  it("abstains for general model-authored candidate ids without provenance", () => {
    expect(
      resolveFontMatchingOcrGeometryDirection({ id: 12, candidateIds: [12] }, [
        hint(12, 100, 30),
      ]),
    ).toBeUndefined();
    expect(
      resolveFontMatchingOcrGeometryDirection({ id: 12 }, [hint(12, 100, 30)]),
    ).toBeUndefined();
  });

  it("stamps only exact code-owned fixed-block request membership", () => {
    const [attached] = attachFontMatchingFixedBlockCandidateMembership(
      [overlayItem(1, [2, 1])],
      {
        fixedBlockTranslationVersion: 6,
        fixedBlockIds: ["B001"],
        fixedBlockCandidateIds: [[2, 1]],
        fixedBlockDirectionVoterCandidateIds: [[2, 1]],
      },
    );
    if (!attached) throw new Error("missing attached fixed-block item");
    expect(attached?.sourceCandidateMembership).toEqual({
      contractVersion: "font-matching-ocr-candidate-membership-v2",
      source: "semantic_ocr_fixed_block_request_v6",
      bindingId: "B001",
      originalCandidateIds: [2, 1],
      voterCandidateIds: [2, 1],
    });
    expect(
      resolveFontMatchingOcrGeometryDirection(attached, [
        hint(1, 20, 80),
        hint(2, 80, 20),
      ]),
    ).toMatchObject({ candidateIds: [2, 1], direction: "vertical" });

    const [orderMismatch] = attachFontMatchingFixedBlockCandidateMembership(
      [overlayItem(1, [1, 2])],
      {
        fixedBlockTranslationVersion: 6,
        fixedBlockIds: ["B001"],
        fixedBlockCandidateIds: [[2, 1]],
        fixedBlockDirectionVoterCandidateIds: [[2, 1]],
      },
    );
    const [generalFallback] = attachFontMatchingFixedBlockCandidateMembership(
      [overlayItem(1, [1, 2])],
      { modelAuthoredCandidateIds: [[1, 2]] },
    );
    expect(orderMismatch?.sourceCandidateMembership).toBeUndefined();
    expect(generalFallback?.sourceCandidateMembership).toBeUndefined();
  });

  it("accepts cached v5 membership while current requests remain v6", () => {
    const [cached] = attachFontMatchingFixedBlockCandidateMembership(
      [overlayItem(1, [1, 2])],
      {
        fixedBlockTranslationVersion: 5,
        fixedBlockIds: ["B001"],
        fixedBlockCandidateIds: [[1, 2]],
        fixedBlockDirectionVoterCandidateIds: [[1]],
      },
    );
    if (!cached?.sourceCandidateMembership) {
      throw new Error("missing cached fixed-block membership");
    }
    expect(cached.sourceCandidateMembership.source).toBe(
      "semantic_ocr_fixed_block_request_v5",
    );

    const evidence = resolveFontMatchingOcrGeometryDirection(cached, [
      hint(1, 20, 80),
      hint(2, 80, 20),
    ]);
    expect(evidence).toMatchObject({
      candidateIds: [1],
      direction: "vertical",
      candidateMembership: {
        source: "semantic_ocr_fixed_block_request_v5",
      },
    });
    expect(
      readFontMatchingOcrGeometryDirection(
        evidence,
        cached,
        cached.sourceCandidateMembership,
      ),
    ).toEqual(evidence);
  });

  it("fails closed on missing, duplicate, or malformed candidate geometry", () => {
    const pair = boundItem([1, 2]);
    const singleton = boundItem([1]);
    expect(
      resolveFontMatchingOcrGeometryDirection(pair, [hint(1, 20, 80)]),
    ).toBeUndefined();
    expect(
      resolveFontMatchingOcrGeometryDirection(singleton, [
        hint(1, 20, 80),
        hint(1, 20, 80),
      ]),
    ).toBeUndefined();
    expect(
      resolveFontMatchingOcrGeometryDirection(singleton, [
        hint(1, 20, 80),
        { ...hint(1, 20, 80), x2: 0 },
      ]),
    ).toBeUndefined();
    expect(
      resolveFontMatchingOcrGeometryDirection(singleton, [
        { ...hint(1, 20, 80), x2: 0 },
      ]),
    ).toBeUndefined();
  });

  it("binds worker evidence voters to the enclosing item membership", () => {
    const item = boundItem([3, 4], [3]);
    const valid = resolveFontMatchingOcrGeometryDirection(item, [
      hint(3, 20, 80),
      { ...hint(4, 80, 20), reviewRole: "ruby" },
    ]);
    expect(valid).toBeDefined();
    if (!valid) throw new Error("missing valid direction evidence");
    expect(
      readFontMatchingOcrGeometryDirection(
        valid,
        item,
        item.sourceCandidateMembership,
      ),
    ).toEqual(valid);
    expect(
      readFontMatchingOcrGeometryDirection(
        { ...valid, source: "model_direction" },
        item,
        item.sourceCandidateMembership,
      ),
    ).toBeNull();
    expect(
      readFontMatchingOcrGeometryDirection(
        { ...valid, candidateIds: [3, 99] },
        item,
        item.sourceCandidateMembership,
      ),
    ).toBeNull();
    expect(
      readFontMatchingOcrGeometryDirection(
        {
          ...valid,
          candidateMembership: {
            ...valid.candidateMembership,
            originalCandidateIds: [3],
          },
        },
        item,
        item.sourceCandidateMembership,
      ),
    ).toBeNull();
    expect(
      readFontMatchingOcrGeometryDirection(
        { ...valid, candidateIds: [] },
        item,
        item.sourceCandidateMembership,
      ),
    ).toBeNull();
    expect(
      readFontMatchingOcrGeometryDirection(valid, item, {
        ...item.sourceCandidateMembership,
        bindingId: "forged-binding",
      }),
    ).toBeNull();
    expect(
      readFontMatchingOcrGeometryDirection(valid, item, undefined),
    ).toBeNull();
  });
});

function boundItem(
  candidateIds: number[],
  voterCandidateIds: number[] = candidateIds,
) {
  return {
    id: Math.min(...candidateIds),
    candidateIds,
    sourceCandidateMembership: membership(candidateIds, voterCandidateIds),
  };
}

function membership(
  candidateIds: number[],
  voterCandidateIds: number[] = candidateIds,
): FontMatchingOcrCandidateMembershipV2 {
  return {
    contractVersion: "font-matching-ocr-candidate-membership-v2",
    source: "sealed_font_input_request_block_v2",
    bindingId: `block-${candidateIds.join("-")}`,
    originalCandidateIds: candidateIds,
    voterCandidateIds,
  };
}

function overlayItem(id: number, candidateIds: number[]): OverlayItem {
  return {
    id,
    candidateIds,
    type: "nonsolid",
    bbox: { x: 0, y: 0, w: 100, h: 100 },
    jp: "テスト",
    ko: "테스트",
  };
}

function hint(id: number, width: number, height: number) {
  return { id, x1: 10, y1: 20, x2: 10 + width, y2: 20 + height };
}
