import { nativeImage } from "electron";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CodexPageReading } from "../../shared/codexTypesettingTypes";
import { codexSourceContextRect } from "../../shared/codexTypesettingMask";
import type {
  CodexTypesettingPorts,
  TypesettingComposition,
  TypesettingBackgroundReview,
} from "../application/codexTypesettingContracts";
import {
  partitionCodexReading,
  codexBatchStage,
} from "../application/codexTypesettingBatches";
import { backgroundReviewSchema } from "../application/codexTypesettingValidation";
import {
  sourceRegionCrops,
  typesettingPageImages,
} from "./codexTypesettingRaster";

type Context = {
  composition: TypesettingComposition;
  reading: CodexPageReading;
  attempt: number;
  directory: string;
  signal: AbortSignal;
  ask: CodexTypesettingPorts["ask"];
  evidence: CodexTypesettingPorts["saveEvidence"];
};

/** Each model turn inspects immutable pixels; generation occurs outside that turn. */
export async function inspectTypesettingBackground(
  context: Context,
): Promise<TypesettingBackgroundReview> {
  context.signal.throwIfAborted();
  const { page } = context.composition;
  if (!page.inpaintedImagePath) throw new Error("검수할 제거 배경이 없습니다.");
  const bytes = await readFile(page.inpaintedImagePath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const snapshot = nativeImage.createFromBuffer(bytes);
  const views = typesettingPageImages(
    page,
    snapshot,
    "Actual cleaned background; NO translation foreground",
  );
  await writeFile(
    join(
      context.directory,
      `background-review-${page.id}-${context.attempt}.png`,
    ),
    bytes,
  );
  const batches = partitionCodexReading(context.reading, 12);
  const result: TypesettingBackgroundReview = { issues: [], corrections: [] };
  for (const [index, batch] of batches.entries()) {
    context.signal.throwIfAborted();
    const stage = codexBatchStage(
      `background-${page.id}-${context.attempt}`,
      index,
      batches.length,
    );
    const images = await backgroundImages(context, batch, snapshot);
    // Native whole-page views also expose damage between detected text boxes.
    const response = backgroundReviewSchema.parse(
      await context.ask(stage, backgroundPrompt(context, batch, sha256), [
        ...views,
        ...images,
      ]),
    );
    const activeReview = validateBackgroundAcknowledgement(
      response,
      batch,
      context.attempt + 1,
      sha256,
    );
    await context.evidence(`audit-${stage}`, {
      response,
      reading: batch,
      sha256,
      preservedObservations: activeReview.preservedObservations,
    });
    result.issues.push(...activeReview.issues);
    result.corrections.push(...response.corrections);
  }
  context.signal.throwIfAborted();
  const actual = createHash("sha256")
    .update(await readFile(page.inpaintedImagePath))
    .digest("hex");
  if (actual !== sha256)
    throw new Error("검수 중 실제 제거 배경이 변경되었습니다.");
  return result;
}

async function backgroundImages(
  context: Context,
  batch: CodexPageReading,
  snapshot: ReturnType<typeof nativeImage.createFromBuffer>,
) {
  const { page, backgroundCandidates = [] } = context.composition;
  const originals = await sourceRegionCrops(
    [page],
    new Map([[page.id, batch]]),
    true,
  );
  const active = batch.regions.filter((region) => region.action !== "keep");
  return active.flatMap((region, index) => {
    const crop = codexSourceContextRect(region, page);
    const image = snapshot.crop({
      x: crop.x,
      y: crop.y,
      width: crop.w,
      height: crop.h,
    });
    return [
      originals[index],
      {
        label:
          originals[index].label +
          "; ACTUAL saved background crop, inspect residual source strokes, erased artwork and pixel seams",
        dataUrl: image.toDataURL(),
      },
      ...backgroundCandidates
        .filter((candidate) => candidate.regionId === region.id)
        .flatMap((candidate) => [
          {
            label: `${region.id}; RAW generator output, NOT the accepted local splice; native page-pixel source crop=${JSON.stringify(candidate.crop)}; output sha256=${candidate.sha256}. A clean-looking raw output cannot override a failed actual splice.`,
            dataUrl: candidate.dataUrl,
          },
          ...(candidate.blendMask
            ? [
                {
                  label: `${region.id}; actual splice alpha in the raw crop coordinates: WHITE=complete replacement core, GRAY=outer feather only, BLACK=preserved original. This is a mask, not artwork. Existing raw proposal reused=${Boolean(candidate.reused)}.`,
                  dataUrl: candidate.blendMask,
                },
              ]
            : []),
        ]),
    ];
  });
}

function backgroundPrompt(
  context: Context,
  batch: CodexPageReading,
  sha256: string,
) {
  return `Inspect source removal BEFORE any translation lettering is generated. Every requested Japanese target remains in the quality denominator, including hard effects crossing people, hatching and panel edges. Original-preserving fallback is a FAILURE, never successful removal.
Frozen actual background revision=${context.attempt + 1}; sha256=${sha256}. Acknowledge both exactly. Inspect every actual native view and source/background crop. Detect residual strokes, lost balloon curves, damaged drawing, mismatched screentone phase and seams. Raw generator outputs are evidence only; the saved local splice is authoritative. Judge its natural visual continuity at native size, not pixel equality across the unused raw crop. Technical missing-coverage, opacity or protected-region failures cannot be overruled. A staged splice is not accepted until this visual inspection. The opaque source core expands each glyph contour and outline; feather blends only outside those contours and preserves distant gaps. Reject visible original ghosts and important object/character loss.
Return {revision,sha256,issues:[{regionId,kind:"background",reason,sourceRemaining}],corrections:[{regionId,erasePolygons,background,reason}]}. Set sourceRemaining=true when any requested original letter or stroke still remains; false for texture, seam or artwork-only issues. This controls whether translation lettering may be generated: never allow it to conceal an unremoved original. Issues and corrections must refer only to the requested active IDs. Attribute between-box damage to the responsible requested region; never invent a region ID. Corrections are OPTIONAL, unique per region, and replace that region's complete removal polygons in its ORIGINAL CONTEXT CROP coordinates (0..1000), not page or generated-output coordinates. Original source/translation/action identities cannot be changed. Empty polygons preserve source and are unresolved.
This is a single-pass workflow. Report visible defects as concise issues for the user; do not regenerate, retry or assume a future repair. Return corrections=[]; the application preserves the first result for direct review and user-requested editing. Judge readability, natural appearance and important artwork preservation at native viewing size; do not reject harmless texture variation only visible under extreme magnification.
Requested active regions=${JSON.stringify(batch.regions.filter((region) => region.action !== "keep"))}
Protected context=${JSON.stringify(batch.regions.filter((region) => region.action === "keep"))}. Unreadable preserved regions already count as failures in the application. Their remaining source is expected in this inspection; do not propose erasure or list them as active issues.
Runtime failures=${JSON.stringify(context.composition.issues.filter((issue) => batch.regions.some((region) => region.id === issue.regionId)))}`;
}

function validateBackgroundAcknowledgement(
  response: ReturnType<typeof backgroundReviewSchema.parse>,
  batch: CodexPageReading,
  revision: number,
  sha256: string,
) {
  if (response.revision !== revision || response.sha256 !== sha256)
    throw new Error("실제 제거 배경의 번호·해시와 검수 응답이 다릅니다.");
  const active = new Set(
    batch.regions
      .filter((region) => region.action !== "keep")
      .map((region) => region.id),
  );
  const corrections = response.corrections.map((item) => item.regionId);
  const preserved = new Set(
    batch.regions
      .filter((region) => region.action === "keep" && region.preserveReason)
      .map((region) => region.id),
  );
  if (
    new Set(corrections).size !== corrections.length ||
    corrections.some((id) => !active.has(id)) ||
    response.issues.some(
      (issue) => !active.has(issue.regionId) && !preserved.has(issue.regionId),
    )
  )
    throw new Error("배경 검수가 중복 수정 또는 대상 밖 영역을 참조했습니다.");
  // Keep observations remain in the raw audit and the existing quality denominator;
  // they must never become active erasure/repair targets or discard valid neighbors.
  return {
    issues: response.issues.filter((issue) => active.has(issue.regionId)),
    preservedObservations: response.issues.filter((issue) =>
      preserved.has(issue.regionId),
    ),
  };
}
