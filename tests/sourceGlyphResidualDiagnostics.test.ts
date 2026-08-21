import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { InpaintingWindowMask } from "../src/main/inpainting/inpaintingEngine";
import {
  buildPatternSourceGlyphEvidenceReceipt,
  createPatternBitmapBaseline,
} from "../src/main/inpainting/sourceGlyphEvidenceReceipt";
import {
  measureSourceGlyphComponentResiduals,
  measureUnassignedOcrHintResiduals,
} from "../src/main/inpainting/sourceGlyphResidualDiagnostics";

describe("source glyph residual v2 diagnostics", () => {
  it("finds one intact glyph component after the rest of a block was erased", () => {
    const width = 32;
    const height = 16;
    const before = solidBitmap(width, height, 255);
    const mask = emptyMask({ x: 2, y: 2, w: 28, h: 11 });
    drawMaskGlyph(mask, 1, 1);
    drawMaskGlyph(mask, 17, 1);
    paintMaskComponent(before, width, mask, { x: 1, y: 1, w: 5, h: 9 }, 0);
    paintMaskComponent(before, width, mask, { x: 17, y: 1, w: 5, h: 9 }, 0);
    const after = Buffer.from(before);
    paintMaskComponent(after, width, mask, { x: 17, y: 1, w: 5, h: 9 }, 255);

    const diagnostic = measureSourceGlyphComponentResiduals({
      after,
      before,
      pageWidth: width,
      sourceEvidence: { strategy: "adaptive", windowMask: mask },
    });

    expect(diagnostic.sourceLikeRemainingRatio).toBeLessThan(0.62);
    expect(diagnostic.candidateComponentCount).toBe(1);
    expect(diagnostic.components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourcePixelCount: 21,
          sourceLikeRemainingCount: 21,
          retainedRatio: 1,
          largestExactLikeRun: 21,
          diagnosticCandidate: true,
        }),
      ]),
    );
    expect(diagnostic).toEqual(
      expect.objectContaining({
        diagnosticOnly: true,
        promotionEligible: false,
      }),
    );
  });

  it("does not promote a retained thin line-art component", () => {
    const before = solidBitmap(32, 8, 255);
    const after = Buffer.from(before);
    const mask = emptyMask({ x: 2, y: 2, w: 24, h: 3 });
    mask.data.fill(1, 0, 20);

    const diagnostic = measureSourceGlyphComponentResiduals({
      after,
      before,
      pageWidth: 32,
      sourceEvidence: { strategy: "adaptive", windowMask: mask },
    });

    expect(diagnostic.components[0]).toEqual(
      expect.objectContaining({
        retainedRatio: 1,
        sourceAspectRatio: 20,
        diagnosticCandidate: false,
      }),
    );
    expect(diagnostic.candidateComponentCount).toBe(0);
  });

  it("emits an intact unassigned Japanese OCR hint as review-only evidence", () => {
    const width = 64;
    const height = 64;
    const before = solidBitmap(width, height, 248);
    drawBitmapGlyph(before, width);
    const after = Buffer.from(before);
    const originalBefore = Buffer.from(before);
    const originalAfter = Buffer.from(after);

    const results = measureUnassignedOcrHintResiduals({
      after,
      before,
      pageHeight: height,
      pageWidth: width,
      provenance: sealedProvenance(before, after, width, height, false),
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual(
      expect.objectContaining({
        hintId: "5",
        sourceText: "極",
        provenance: "sealed-raw-ocr-hint",
        diagnosticOnly: true,
        promotionEligible: false,
        resolutionNormalized: false,
        diagnosticCandidate: true,
        rejectionReasons: [],
        provenanceReceipt: expect.objectContaining({
          sealed: true,
          assignedCandidateIds: ["1"],
          assignedCandidateIdsSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          candidateMembershipSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      }),
    );
    expect(before.equals(originalBefore)).toBe(true);
    expect(after.equals(originalAfter)).toBe(true);
  });

  it("fails closed for assigned, erased, and known-block-overlapping hints", () => {
    const width = 64;
    const height = 64;
    const before = solidBitmap(width, height, 248);
    drawBitmapGlyph(before, width);
    const erased = Buffer.from(before);
    fillGray(erased, width, { x: 17, y: 17, w: 30, h: 32 }, 248);
    expect(
      measureUnassignedOcrHintResiduals({
        after: before,
        before,
        pageHeight: height,
        pageWidth: width,
        provenance: sealedProvenance(before, before, width, height, true),
      }),
    ).toEqual([]);

    const erasedResult = measureUnassignedOcrHintResiduals({
      after: erased,
      before,
      pageHeight: height,
      pageWidth: width,
      provenance: sealedProvenance(before, erased, width, height, false),
    })[0];
    expect(erasedResult?.diagnosticCandidate).toBe(false);
    expect(erasedResult?.rejectionReasons).toContain(
      "source-retention-below-profile",
    );

    const overlapProvenance = mutateFontProvenance(
      sealedProvenance(before, before, width, height, false),
      (font) => {
        font.page.blocks[0].bbox = { x: 250, y: 250, w: 500, h: 532 };
      },
    );
    const overlapResult = measureUnassignedOcrHintResiduals({
      after: before,
      before,
      pageHeight: height,
      pageWidth: width,
      provenance: overlapProvenance,
    })[0];
    expect(overlapResult?.diagnosticCandidate).toBe(false);
    expect(overlapResult?.rejectionReasons).toContain("overlaps-known-block");
  });

  it("rejects tampered sealed OCR/font/source bindings", () => {
    const width = 64;
    const height = 64;
    const bitmap = solidBitmap(width, height, 248);
    const provenance = sealedProvenance(bitmap, bitmap, width, height, false);
    provenance.expectedOcrResultSha256 = "0".repeat(64);

    expect(() =>
      measureUnassignedOcrHintResiduals({
        after: bitmap,
        before: bitmap,
        pageHeight: height,
        pageWidth: width,
        provenance,
      }),
    ).toThrow("Sealed OCR result SHA-256 mismatch");
  });

  it.each([
    [
      "membership source",
      (font: MutableFontFixture) => {
        font.requestBlocks[0].sourceGeometryDirection.candidateMembership.source =
          "caller_claimed_sealed";
      },
    ],
    [
      "voter subset",
      (font: MutableFontFixture) => {
        font.requestBlocks[0].sourceGeometryDirection.candidateMembership.voterCandidateIds =
          [6];
      },
    ],
    [
      "original membership",
      (font: MutableFontFixture) => {
        font.requestBlocks[0].sourceGeometryDirection.candidateMembership.originalCandidateIds =
          [6];
      },
    ],
    [
      "page block inventory",
      (font: MutableFontFixture) => {
        font.page.blocks = [];
      },
    ],
  ])("rejects tampered sealed %s", (_label, mutate) => {
    const width = 64;
    const height = 64;
    const bitmap = solidBitmap(width, height, 248);
    const provenance = mutateFontProvenance(
      sealedProvenance(bitmap, bitmap, width, height, true),
      mutate,
    );

    expect(() =>
      measureUnassignedOcrHintResiduals({
        after: bitmap,
        before: bitmap,
        pageHeight: height,
        pageWidth: width,
        provenance,
      }),
    ).toThrow(/sealed candidate membership|page\/request block inventory/u);
  });

  it("rejects a before bitmap not bound to the sealed source decoder receipt", () => {
    const width = 64;
    const height = 64;
    const source = solidBitmap(width, height, 248);
    const unrelated = solidBitmap(width, height, 247);
    const provenance = sealedProvenance(source, source, width, height, false);

    expect(() =>
      measureUnassignedOcrHintResiduals({
        after: unrelated,
        before: unrelated,
        pageHeight: height,
        pageWidth: width,
        provenance,
      }),
    ).toThrow("OCR/font/source provenance binding mismatch");
  });

  it("rejects an after bitmap not bound to the cleaned evidence receipt", () => {
    const width = 64;
    const height = 64;
    const source = solidBitmap(width, height, 248);
    const unrelatedAfter = solidBitmap(width, height, 247);
    const provenance = sealedProvenance(source, source, width, height, false);

    expect(() =>
      measureUnassignedOcrHintResiduals({
        after: unrelatedAfter,
        before: source,
        pageHeight: height,
        pageWidth: width,
        provenance,
      }),
    ).toThrow("OCR/font/source provenance binding mismatch");
  });

  it("rejects caller-rebound known evidence under sealed provenance", () => {
    const width = 64;
    const height = 64;
    const bitmap = solidBitmap(width, height, 248);
    const provenance = sealedProvenance(bitmap, bitmap, width, height, false);
    provenance.knownSourceEvidenceByBlockId.set("block-1", {
      strategy: "adaptive",
      windowMask: {
        bounds: { x: 0, y: 0, w: 1, h: 1 },
        data: new Uint8Array([0]),
      },
    });

    expect(() =>
      measureUnassignedOcrHintResiduals({
        after: bitmap,
        before: bitmap,
        pageHeight: height,
        pageWidth: width,
        provenance,
      }),
    ).toThrow("Known source evidence hash mismatch");
  });

  it("does not let sealed provenance mix with caller-owned overlap arrays", () => {
    const width = 64;
    const height = 64;
    const bitmap = solidBitmap(width, height, 248);

    expect(() =>
      measureUnassignedOcrHintResiduals({
        after: bitmap,
        before: bitmap,
        knownBlockBounds: [],
        pageHeight: height,
        pageWidth: width,
        provenance: sealedProvenance(bitmap, bitmap, width, height, false),
      }),
    ).toThrow("cannot be mixed with caller-supplied hints");
  });

  it("keeps caller-supplied raw hints unsealed and ineligible", () => {
    const width = 64;
    const height = 64;
    const bitmap = solidBitmap(width, height, 248);
    drawBitmapGlyph(bitmap, width);

    const result = measureUnassignedOcrHintResiduals({
      after: bitmap,
      assignedHintIds: new Set(),
      before: bitmap,
      hints: [rawHint("5", "極")],
      knownBlockBounds: [],
      knownSourceEvidence: [],
      pageHeight: height,
      pageWidth: width,
    })[0];

    expect(result).toMatchObject({
      provenance: "unsealed-raw-ocr-hint",
      diagnosticCandidate: false,
      rejectionReasons: ["unsealed-ocr-provenance"],
      provenanceReceipt: { sealed: false },
    });
  });
});

function sealedProvenance(
  sourceBitmap: Buffer,
  afterBitmap: Buffer,
  width: number,
  height: number,
  assigned: boolean,
) {
  const sourceImagePath = resolve("sealed-source-fixture.png");
  const sourcePageId = "sealed-page-1";
  const sourceImageBytes = Buffer.from("exact-source-image-fixture");
  const sourceImageSha256 = sha256(sourceImageBytes);
  const assignedCandidateId = assigned ? 5 : 1;
  const hints = assigned
    ? [rawHint("5", "極")]
    : [rawHint("1", "ASCII"), rawHint("5", "極")];
  const ocrResultBytes = Buffer.from(
    JSON.stringify({
      schemaVersion: 10,
      imagePath: sourceImagePath,
      width,
      height,
      hints,
    }),
  );
  const requestBlocks = [
    {
      blockId: "block-1",
      item: {
        id: assignedCandidateId,
        candidateIds: [assignedCandidateId],
      },
      sourceGeometryDirection: {
        contractVersion: "font-matching-ocr-geometry-direction-v2",
        source: "semantic_ocr_candidate_bbox_majority",
        candidateIds: [assignedCandidateId],
        candidateMembership: {
          contractVersion: "font-matching-ocr-candidate-membership-v2",
          source: "semantic_ocr_fixed_block_request_v5",
          bindingId: "B001",
          originalCandidateIds: [assignedCandidateId],
          voterCandidateIds: [assignedCandidateId],
        },
      },
    },
  ];
  const pageBlocks = [
    {
      id: "block-1",
      bbox: { x: 0, y: 0, w: 100, h: 100 },
      bboxSpace: "normalized_1000",
    },
  ];
  const fontInputBytes = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      sourcePageId,
      sourcePageSha256: sourceImageSha256,
      page: {
        id: sourcePageId,
        imagePath: sourceImagePath,
        width,
        height,
        blocks: pageBlocks,
      },
      requestBlocks,
    }),
  );
  const sourceBaseline = createPatternBitmapBaseline({
    assetPath: sourceImagePath,
    assetBytes: sourceImageBytes,
    bitmap: sourceBitmap,
    width,
    height,
  });
  const evidenceMask = {
    bounds: { x: 0, y: 0, w: 1, h: 1 },
    data: new Uint8Array([1]),
  };
  const sourceEvidenceReceipt = buildPatternSourceGlyphEvidenceReceipt({
    afterBitmap,
    before: sourceBaseline,
    cleanedAssetBytes: Buffer.from("sealed-cleaned-fixture"),
    cleanedAssetPath: resolve("sealed-cleaned-fixture.png"),
    expectedBlockIds: ["block-1"],
    pageId: sourcePageId,
    source: sourceBaseline,
    validationBindingsByBlockId: new Map([
      [
        "block-1",
        {
          blockId: "block-1",
          firstPassCore: evidenceMask,
          sourceGlyphEvidence: {
            strategy: "adaptive" as const,
            windowMask: evidenceMask,
          },
        },
      ],
    ]),
  });
  const knownSourceEvidenceByBlockId = new Map([
    [
      "block-1",
      {
        strategy: "adaptive" as const,
        windowMask: evidenceMask,
      },
    ],
  ]);
  return {
    expectedFontInputSha256: sha256(fontInputBytes),
    expectedOcrResultSha256: sha256(ocrResultBytes),
    expectedSourceImageSha256: sourceImageSha256,
    fontInputBytes,
    knownSourceEvidenceByBlockId,
    ocrResultBytes,
    sourceImageBytes,
    sourceImagePath,
    sourcePageId,
    sourceEvidenceReceipt,
  };
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function mutateFontProvenance<T extends ReturnType<typeof sealedProvenance>>(
  provenance: T,
  mutate: (font: MutableFontFixture) => void,
): T {
  const font = JSON.parse(
    Buffer.from(provenance.fontInputBytes).toString(),
  ) as MutableFontFixture;
  mutate(font);
  const fontInputBytes = Buffer.from(JSON.stringify(font));
  return {
    ...provenance,
    fontInputBytes,
    expectedFontInputSha256: sha256(fontInputBytes),
  };
}

type MutableFontFixture = {
  page: {
    blocks: Array<{
      bbox?: { h: number; w: number; x: number; y: number };
      id: string;
    }>;
  };
  requestBlocks: Array<{
    sourceGeometryDirection: {
      candidateMembership: {
        originalCandidateIds: number[];
        source: string;
        voterCandidateIds: number[];
      };
    };
  }>;
};

function rawHint(id: string, ocrText: string) {
  return {
    id,
    label: "ocr_textline",
    ocrText,
    reviewReasons: ["dense_page_single_glyph"],
    reviewStatus: "deferred",
    score: 0.999,
    x1: 16,
    y1: 16,
    x2: 48,
    y2: 50,
  };
}

function drawMaskGlyph(
  mask: InpaintingWindowMask,
  originX: number,
  originY: number,
): void {
  for (let y = 0; y < 9; y += 1) {
    setMask(mask, originX, originY + y);
    setMask(mask, originX + 4, originY + y);
  }
  for (let x = 1; x < 4; x += 1) setMask(mask, originX + x, originY + 4);
}

function setMask(mask: InpaintingWindowMask, x: number, y: number): void {
  mask.data[y * mask.bounds.w + x] = 1;
}

function paintMaskComponent(
  bitmap: Buffer,
  pageWidth: number,
  mask: InpaintingWindowMask,
  localBounds: { x: number; y: number; w: number; h: number },
  value: number,
): void {
  for (let y = localBounds.y; y < localBounds.y + localBounds.h; y += 1) {
    for (let x = localBounds.x; x < localBounds.x + localBounds.w; x += 1) {
      if (!mask.data[y * mask.bounds.w + x]) continue;
      setGray(bitmap, pageWidth, mask.bounds.x + x, mask.bounds.y + y, value);
    }
  }
}

function drawBitmapGlyph(bitmap: Buffer, width: number): void {
  fillGray(bitmap, width, { x: 26, y: 18, w: 10, h: 30 }, 92);
  fillGray(bitmap, width, { x: 28, y: 20, w: 6, h: 26 }, 12);
  fillGray(bitmap, width, { x: 18, y: 29, w: 28, h: 10 }, 92);
  fillGray(bitmap, width, { x: 20, y: 31, w: 24, h: 6 }, 12);
}

function solidBitmap(width: number, height: number, value: number): Buffer {
  const bitmap = Buffer.alloc(width * height * 4, value);
  for (let index = 3; index < bitmap.length; index += 4) bitmap[index] = 255;
  return bitmap;
}

function emptyMask(
  bounds: InpaintingWindowMask["bounds"],
): InpaintingWindowMask {
  return { bounds, data: new Uint8Array(bounds.w * bounds.h) };
}

function fillGray(
  bitmap: Buffer,
  width: number,
  rect: { x: number; y: number; w: number; h: number },
  value: number,
): void {
  for (let y = rect.y; y < rect.y + rect.h; y += 1) {
    for (let x = rect.x; x < rect.x + rect.w; x += 1) {
      setGray(bitmap, width, x, y, value);
    }
  }
}

function setGray(
  bitmap: Buffer,
  width: number,
  x: number,
  y: number,
  value: number,
): void {
  const offset = (y * width + x) * 4;
  bitmap[offset] = value;
  bitmap[offset + 1] = value;
  bitmap[offset + 2] = value;
  bitmap[offset + 3] = 255;
}
