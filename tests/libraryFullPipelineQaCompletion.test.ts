import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildPatternSourceGlyphEvidenceReceipt,
  createPatternBitmapBaseline,
} from "../src/main/inpainting/sourceGlyphEvidenceReceipt";
import { completeTranslationWorkflow } from "../src/main/jobs/inpaintingJobPageCompletion";
import type {
  InpaintingJobState,
  InpaintingTarget,
} from "../src/main/jobs/inpaintingJobPageTypes";
import type { MangaPage } from "../src/shared/libraryTypes";

const {
  assertQaInpaintingResultMatchesProduction,
  isQaRunExactlyCompleted,
  isQaTargetlessPage,
  resolveQaPageCompletion,
  seedQaTranslationCompletion,
} =
  require("../scripts/library-full-pipeline-qa/page-completion-contract.cjs") as {
    assertQaInpaintingResultMatchesProduction: (
      result: {
        blocksErased: number;
      },
      options?: { targetless?: boolean },
    ) => unknown;
    isQaRunExactlyCompleted: (
      reportPages: Array<{ sourcePageId: string; status: string }>,
      expectedPageIds: string[],
    ) => boolean;
    isQaTargetlessPage: (page: MangaPage) => boolean;
    resolveQaPageCompletion: (options: {
      executionStatus: "completed" | "failed" | "pending";
      translationCompletion?: {
        workflow: string;
        status: "completed" | "failed" | "pending";
      };
      cleanedImagePath?: string;
      cleanedAssetKind?: string;
      blocksIncomplete?: number;
      sourceEvidenceBindingRequired?: boolean;
      sourceEvidenceReceipt?: unknown;
      expectedSourceImagePath?: string;
      expectedSourcePageId?: string;
      expectedSourceSha256?: string;
    }) => Promise<Record<string, unknown>>;
    seedQaTranslationCompletion: (page: MangaPage) => MangaPage;
  };

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("library full-pipeline QA page completion contract", () => {
  it("records execution and production completion independently", async () => {
    const bytes = Buffer.from("real-cleaned-png-fixture");
    const cleanedPath = createCleanedAsset(bytes);

    const result = await resolveQaPageCompletion({
      executionStatus: "completed",
      translationCompletion: {
        workflow: "bubble-layout",
        status: "completed",
      },
      cleanedImagePath: cleanedPath,
      blocksIncomplete: 0,
    });

    expect(result).toEqual({
      completionContractVersion: "library-full-pipeline-qa-page-completion-v1",
      status: "completed",
      stage: "done",
      executionStatus: "completed",
      productionTranslationCompletion: {
        workflow: "bubble-layout",
        status: "completed",
      },
      expectedTranslationCompletionWorkflow: "bubble-layout",
      cleanedAsset: {
        available: true,
        path: resolve(cleanedPath),
        sizeBytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
      sourceEvidenceBinding: {
        required: false,
        valid: true,
        kind: "not-required",
        reasons: [],
      },
      completionFailureReasons: [],
    });
  });

  it("keeps an executed page pending when production completion is pending", async () => {
    const cleanedPath = createCleanedAsset(Buffer.from("cleaned"));

    const result = await resolveQaPageCompletion({
      executionStatus: "completed",
      translationCompletion: {
        workflow: "bubble-layout",
        status: "pending",
      },
      cleanedImagePath: cleanedPath,
      blocksIncomplete: 1,
    });

    expect(result).toMatchObject({
      status: "pending",
      stage: "translation-completion-pending",
      executionStatus: "completed",
      productionTranslationCompletion: { status: "pending" },
      completionFailureReasons: [
        "translation-completion-pending",
        "blocks-incomplete",
      ],
    });
  });

  it("fails a completed receipt when the real cleaned asset is absent", async () => {
    const root = makeTemporaryRoot();
    const missingPath = join(root, "missing-cleaned.png");

    const result = await resolveQaPageCompletion({
      executionStatus: "completed",
      translationCompletion: {
        workflow: "bubble-layout",
        status: "completed",
      },
      cleanedImagePath: missingPath,
      blocksIncomplete: 0,
    });

    expect(result).toMatchObject({
      status: "failed",
      stage: "completion-contract-failed",
      cleanedAsset: {
        available: false,
        path: resolve(missingPath),
      },
      completionFailureReasons: ["cleaned-asset-missing"],
    });
  });

  it("never reports completed while blocks remain incomplete", async () => {
    const cleanedPath = createCleanedAsset(Buffer.from("cleaned"));

    const result = await resolveQaPageCompletion({
      executionStatus: "completed",
      translationCompletion: {
        workflow: "bubble-layout",
        status: "completed",
      },
      cleanedImagePath: cleanedPath,
      blocksIncomplete: 2,
    });

    expect(result).toMatchObject({
      status: "pending",
      executionStatus: "completed",
      completionFailureReasons: ["blocks-incomplete"],
    });
  });

  it("seeds pending and completes through the production completion helper", async () => {
    const cleanedPath = createCleanedAsset(Buffer.from("cleaned"));
    const seeded = seedQaTranslationCompletion(makePage());
    const completed = completeTranslationWorkflow(
      { page: seeded, blocksErased: 0 },
      { requestedCompletionWorkflow: "bubble-layout" } as InpaintingJobState,
      FULL_PAGE_TARGET,
    );

    expect(completed.page.translationCompletion).toEqual({
      workflow: "bubble-layout",
      status: "completed",
    });
    await expect(
      resolveQaPageCompletion({
        executionStatus: "completed",
        translationCompletion: completed.page.translationCompletion,
        cleanedImagePath: cleanedPath,
        blocksIncomplete: 0,
      }),
    ).resolves.toMatchObject({ status: "completed" });
  });

  it("fails a completed receipt from the wrong workflow", async () => {
    const cleanedPath = createCleanedAsset(Buffer.from("cleaned"));
    const result = await resolveQaPageCompletion({
      executionStatus: "completed",
      translationCompletion: {
        workflow: "erase-original",
        status: "completed",
      },
      cleanedImagePath: cleanedPath,
      blocksIncomplete: 0,
    });

    expect(result).toMatchObject({
      status: "failed",
      completionFailureReasons: ["translation-completion-workflow-mismatch"],
    });
  });

  it("fails when the cleaned asset no longer matches its sealed evidence receipt", async () => {
    const sourceBytes = Buffer.from("source-image");
    const cleanedBytes = Buffer.from("cleaned-image");
    const sourcePath = createCleanedAsset(sourceBytes);
    const cleanedPath = createCleanedAsset(cleanedBytes);
    const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
    const cleanedSha256 = createHash("sha256")
      .update(cleanedBytes)
      .digest("hex");

    const result = await resolveQaPageCompletion({
      executionStatus: "completed",
      translationCompletion: {
        workflow: "bubble-layout",
        status: "completed",
      },
      cleanedImagePath: cleanedPath,
      blocksIncomplete: 0,
      sourceEvidenceBindingRequired: true,
      expectedSourceImagePath: sourcePath,
      expectedSourcePageId: "page-1",
      expectedSourceSha256: sourceSha256,
      sourceEvidenceReceipt: {
        sealed: true,
        pageId: "page-1",
        source: { assetPath: sourcePath, assetSha256: sourceSha256 },
        after: {
          cleanedAssetPath: cleanedPath,
          cleanedAssetSha256: `${cleanedSha256.slice(0, -1)}0`,
        },
        decoderContract: "electron-native-image-bgra8-v1",
        sourceEvidenceProfileContract: "pattern-text-mask-zero-dilation-v1",
        residualProfileContract: "source-glyph-residual-v1",
        bindingSha256: "f".repeat(64),
      },
    } as never);

    expect(result).toMatchObject({
      status: "failed",
      sourceEvidenceBinding: {
        valid: false,
        reasons: expect.arrayContaining([
          "source-evidence-cleaned-sha-mismatch",
        ]),
      },
      completionFailureReasons: ["source-evidence-receipt-invalid"],
    });
  });

  it("accepts a production-shaped receipt only when real source and cleaned assets bind", async () => {
    const sourceBytes = Buffer.from("strict-source-image");
    const cleanedBytes = Buffer.from("strict-cleaned-image");
    const sourcePath = createCleanedAsset(sourceBytes);
    const cleanedPath = createCleanedAsset(cleanedBytes);
    const sourceBitmap = Buffer.alloc(8 * 8 * 4, 255);
    const cleanedBitmap = Buffer.from(sourceBitmap);
    cleanedBitmap[0] = 0;
    const source = createPatternBitmapBaseline({
      assetPath: sourcePath,
      assetBytes: sourceBytes,
      bitmap: sourceBitmap,
      width: 8,
      height: 8,
    });
    const mask = {
      bounds: { x: 0, y: 0, w: 2, h: 2 },
      data: new Uint8Array([1, 0, 0, 1]),
    };
    const receipt = buildPatternSourceGlyphEvidenceReceipt({
      afterBitmap: cleanedBitmap,
      before: source,
      cleanedAssetBytes: cleanedBytes,
      cleanedAssetPath: cleanedPath,
      expectedBlockIds: ["block-1"],
      pageId: "page-1",
      source,
      validationBindingsByBlockId: new Map([
        [
          "block-1",
          {
            blockId: "block-1",
            firstPassCore: mask,
            sourceGlyphEvidence: {
              strategy: "adaptive" as const,
              windowMask: mask,
            },
          },
        ],
      ]),
    });

    await expect(
      resolveQaPageCompletion({
        executionStatus: "completed",
        translationCompletion: {
          workflow: "bubble-layout",
          status: "completed",
        },
        cleanedImagePath: cleanedPath,
        cleanedAssetKind: "production-inpainted",
        blocksIncomplete: 0,
        sourceEvidenceBindingRequired: true,
        sourceEvidenceReceipt: receipt,
        expectedSourceImagePath: sourcePath,
        expectedSourcePageId: "page-1",
        expectedSourceSha256: createHash("sha256")
          .update(sourceBytes)
          .digest("hex"),
      }),
    ).resolves.toMatchObject({
      status: "completed",
      sourceEvidenceBinding: { valid: true, reasons: [] },
    });
  });

  it("matches production no-change rejection and exact cohort cardinality", () => {
    expect(() =>
      assertQaInpaintingResultMatchesProduction({ blocksErased: 0 }),
    ).toThrow("no erased blocks");
    expect(isQaTargetlessPage(makePage())).toBe(true);
    expect(
      assertQaInpaintingResultMatchesProduction(
        { blocksErased: 0 },
        { targetless: true },
      ),
    ).toEqual({ blocksErased: 0 });
    expect(
      isQaRunExactlyCompleted(
        [
          { sourcePageId: "p1", status: "completed" },
          { sourcePageId: "p2", status: "completed" },
        ],
        ["p1", "p2"],
      ),
    ).toBe(true);
    expect(
      isQaRunExactlyCompleted(
        [{ sourcePageId: "p1", status: "completed" }],
        ["p1", "p2"],
      ),
    ).toBe(false);
  });
});

const FULL_PAGE_TARGET: InpaintingTarget = {
  drawnPatternMode: false,
  drawnStrokes: [],
  layoutOnly: false,
  targetType: "source",
};

function makePage(): MangaPage {
  return {
    id: "page-1",
    name: "page.png",
    imagePath: "original.png",
    dataUrl: "",
    width: 64,
    height: 64,
    blocks: [],
    analysisStatus: "completed",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function createCleanedAsset(bytes: Buffer): string {
  const root = makeTemporaryRoot();
  const filePath = join(root, "cleaned.png");
  writeFileSync(filePath, bytes);
  return filePath;
}

function makeTemporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "mgt-qa-page-completion-"));
  temporaryRoots.push(root);
  return root;
}
