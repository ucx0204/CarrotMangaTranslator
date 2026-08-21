import { unlink } from "node:fs/promises";
import type { MangaPage } from "../../shared/libraryTypes";
import type { InpaintingEngine } from "./inpaintingEngine";
import { logInpaintingRuntimeInfo } from "./inpaintingRuntimeLogger";
import type { PatternPageInpaintingResult } from "./inpaintingTypes";
import type { PatternMaskContext } from "./patternPageMask";
import {
  buildSourceGlyphEvidence,
  measureSourceGlyphResidual,
  type PatternSourceGlyphResidualDiagnostic,
  type SourceGlyphEvidence,
} from "./sourceGlyphResidual";
import {
  assertPatternValidationBindings,
  buildPatternSourceGlyphEvidenceReceipt,
  type PatternBitmapBaseline,
} from "./sourceGlyphEvidenceReceipt";

type PatternInpaintedOutput = { bytes: Buffer; path: string };

/**
 * Strict QA/offline side-channel. Production never calls this with required=true,
 * so immutable source decoding, hashing, and diagnostic failures cannot affect
 * authoritative inpainting availability, bytes, or completion counts.
 */
export async function attachRequiredPatternSourceDiagnostics(
  result: PatternPageInpaintingResult,
  context: {
    afterBitmap: Buffer;
    before?: PatternBitmapBaseline;
    engine?: InpaintingEngine;
    loadImmutableSource: () => Promise<PatternBitmapBaseline>;
    maskContext: PatternMaskContext;
    output?: PatternInpaintedOutput;
    page: MangaPage;
    patternBlockIds: readonly string[];
    required: boolean;
  },
): Promise<PatternPageInpaintingResult> {
  if (!context.required) return result;
  if (!context.before) {
    throw new Error("Strict source evidence baseline is unavailable.");
  }
  const source = await context.loadImmutableSource();
  if (
    source.width !== context.before.width ||
    source.height !== context.before.height
  ) {
    throw new Error(
      `원본과 재시도 이미지 크기가 일치하지 않습니다: ${context.page.name}`,
    );
  }
  hydratePatternSourceGlyphEvidence({
    bitmap: source.bitmap,
    context: context.maskContext,
    height: source.height,
    page: context.page,
    width: source.width,
  });
  assertPatternValidationBindings(context.maskContext);
  const residualDiagnostics = measurePatternResidualDiagnostics({
    after: context.afterBitmap,
    immutableSource: source.bitmap,
    mask: context.maskContext,
    width: source.width,
  });
  logPatternResidualDiagnostics(
    context.maskContext,
    context.engine,
    residualDiagnostics,
  );
  const sourceEvidenceReceipt = buildPatternSourceGlyphEvidenceReceipt({
    afterBitmap: context.afterBitmap,
    before: context.before,
    ...(context.output
      ? {
          cleanedAssetBytes: context.output.bytes,
          cleanedAssetPath: context.output.path,
        }
      : {}),
    expectedBlockIds: context.patternBlockIds,
    pageId: context.page.id,
    source,
    validationBindingsByBlockId:
      context.maskContext.validationBindingsByBlockId,
  });
  if (context.output && !sourceEvidenceReceipt.sealed) {
    throw new Error(
      `Strict source evidence receipt is unsealed: ${sourceEvidenceReceipt.sealingErrors.join(",")}`,
    );
  }
  return { ...result, residualDiagnostics, sourceEvidenceReceipt };
}

/**
 * A strict QA/offline receipt failure happens after the PNG was written but
 * before its path can be returned or persisted. Remove only that invocation's
 * freshly generated UUID output. Existing page assets and sidecars are never
 * inferred or traversed from page state here.
 */
export async function cleanupStrictDiagnosticOutput(
  outputPath: string,
  diagnosticError: unknown,
  removeOutput: (filePath: string) => Promise<void> = unlink,
): Promise<never> {
  try {
    await removeOutput(outputPath);
  } catch (cleanupError) {
    if (!isMissingFileError(cleanupError)) {
      const failure = new AggregateError(
        [diagnosticError, cleanupError],
        "Strict source diagnostics failed and the generated output could not be removed.",
        { cause: diagnosticError },
      ) as AggregateError & {
        code: "inpainting.strictDiagnosticOutputCleanupFailed";
        generatedOutputPath: string;
      };
      failure.code = "inpainting.strictDiagnosticOutputCleanupFailed";
      failure.generatedOutputPath = outputPath;
      throw failure;
    }
  }
  throw diagnosticError;
}

/** Build diagnostics atomically without changing any authoritative mask. */
export function hydratePatternSourceGlyphEvidence(options: {
  bitmap: Buffer;
  context: PatternMaskContext;
  height: number;
  page: MangaPage;
  width: number;
}): void {
  const blocksById = new Map(
    options.page.blocks.map((block) => [block.id, block]),
  );
  const evidence: SourceGlyphEvidence[] = [];
  const bindings: PatternMaskContext["validationBindingsByBlockId"] = new Map();
  for (const [index, blockId] of options.context.validationBlockIds.entries()) {
    const block = blocksById.get(blockId);
    const firstPassCore = options.context.validationWindowMasks[index];
    if (!block || !firstPassCore) {
      throw new Error(`Missing diagnostic source block binding: ${blockId}`);
    }
    const sourceGlyphEvidence = buildSourceGlyphEvidence({
      bitmap: options.bitmap,
      block,
      height: options.height,
      page: options.page,
      width: options.width,
    });
    evidence.push(sourceGlyphEvidence);
    bindings.set(blockId, {
      blockId,
      firstPassCore,
      sourceGlyphEvidence,
    });
  }
  options.context.sourceGlyphEvidence = evidence;
  options.context.validationBindingsByBlockId = bindings;
}

function measurePatternResidualDiagnostics(options: {
  after: Buffer;
  immutableSource: Buffer;
  mask: PatternMaskContext;
  width: number;
}): PatternSourceGlyphResidualDiagnostic[] {
  return options.mask.validationWindowMasks.map((firstPassCore, index) => {
    const blockId = options.mask.validationBlockIds[index];
    const sourceEvidence = options.mask.sourceGlyphEvidence[index];
    if (!blockId || !sourceEvidence) {
      throw new Error(
        "Source-glyph validation evidence binding is incomplete.",
      );
    }
    return measureSourceGlyphResidual({
      after: options.after,
      before: options.immutableSource,
      blockId,
      firstPassCore,
      pageWidth: options.width,
      sourceEvidence,
    });
  });
}

function logPatternResidualDiagnostics(
  mask: PatternMaskContext,
  engine: InpaintingEngine | undefined,
  diagnostics: readonly PatternSourceGlyphResidualDiagnostic[],
): void {
  const candidates = diagnostics.filter((item) => item.residualVeto);
  if (candidates.length === 0) return;
  logInpaintingRuntimeInfo(
    "Diagnostic source-like glyph evidence remains after inpainting",
    {
      model: engine?.model,
      blocks: mask.blocksErased,
      diagnosticOnly: true,
      promotionEligible: false,
      residualCandidates: candidates.length,
      residualDiagnostics: candidates,
    },
  );
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
