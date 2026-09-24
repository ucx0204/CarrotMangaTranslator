import {
  readMcpTypographyFontEnvironment,
  runMcpTypographyFontAnalysis,
} from "./mcpTypographyFontRuntime";
import { mcpSourceTypographyItem } from "./mcpSourceTypographyItem";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { MangaPage } from "../../shared/libraryTypes";
import { McpTypographyFontChoiceSchema } from "../../shared/mcpTypographyAnalysis";
import { McpEditError } from "../application/mcpEditPolicy";
import type { McpTypographyAnalysisService } from "../application/mcpTypographyAnalysisService";
import { selectMcpBlockOcr } from "../application/mcpBlockOcrService";
import type { McpOperationContext } from "../application/mcpOperationService";
import type { InpaintingJobContext } from "../jobs/inpaintingJobTypes";
import { createFontChapterC18Port } from "../pipeline/fontChapterC18";
import type {
  FontChapterC18Port,
  FontChapterC18Resolver,
} from "../pipeline/fontChapterC18Types";
import { estimatePageSourceFontSizes } from "../pipeline/sourceFontSizeEstimator";
import { probePageExportSourceImage } from "../pageExportRasterSafety";

type Analyze = ConstructorParameters<
  typeof McpTypographyAnalysisService
>[0]["analyze"];
type Input = Parameters<Analyze>[0];
type Estimate = Awaited<ReturnType<typeof estimatePageSourceFontSizes>>[number];
type Runtime = {
  chapter: FontChapterC18Port;
  measure: typeof estimatePageSourceFontSizes;
};

/** Read-only source evidence. This adapter never imports a block-application or save function. */
export function createMcpTypographyAnalyzer(
  app: InpaintingJobContext,
  runtime: Runtime = {
    chapter: createFontChapterC18Port(app.appPaths),
    measure: estimatePageSourceFontSizes,
  },
): Analyze {
  return async (input, context) => {
    context.assertAuthorized();
    const environment = await readMcpTypographyFontEnvironment(input);
    context.assertAuthorized();
    const prepared = await prepareSources(input, context, runtime.measure);
    const resolver =
      input.request.mode === "size"
        ? undefined
        : await runMcpTypographyFontAnalysis(
            app,
            input,
            prepared.map((entry) => ({
              page: entry.page,
              items: entry.selected
                .filter((item) => item.eligibility.fontEligible)
                .map((item) => item.item),
            })),
            context,
            runtime.chapter,
          );
    context.assertAuthorized();
    for (const entry of prepared) {
      if ((await sourceDigest(entry.page, context)) !== entry.sourceImageSha256)
        throw new McpEditError(
          "revision_conflict",
          "Original image changed during typography analysis.",
        );
    }
    const after = await readMcpTypographyFontEnvironment(input);
    context.assertAuthorized();
    if (environment.snapshot !== after.snapshot)
      throw new McpEditError(
        "revision_conflict",
        "Font profile or candidate environment changed during analysis.",
      );
    return {
      environmentSnapshot: environment.snapshot,
      pages: prepared.map((entry, index) =>
        projectEvidence(
          entry,
          input.prepared[index],
          resolver,
          environment.fontIds,
        ),
      ),
    };
  };
}

async function prepareSources(
  input: Input,
  context: McpOperationContext,
  measure: Runtime["measure"],
) {
  const result = [];
  for (const [index, page] of input.pages.entries()) {
    context.assertAuthorized();
    const inspected = input.prepared[index];
    const sourceImageSha256 = await sourceDigest(page, context);
    const selected = page.blocks.flatMap((block, blockIndex) => {
      const eligibility = inspected.blocks[blockIndex];
      if (!eligibility.fontEligible && !eligibility.sizeEligible) return [];
      selectMcpBlockOcr(page, block.id); // Geometry validation only, not OCR.
      if (!["horizontal", "vertical"].includes(block.sourceDirection))
        throw new McpEditError(
          "invalid_edit",
          "A valid source direction is required.",
        );
      return [
        {
          block,
          item: mcpSourceTypographyItem(page, block, blockIndex),
          eligibility,
        },
      ];
    });
    context.progress({
      phase: "source_size_measurement",
      completed: index,
      total: input.pages.length,
    });
    const sizeTargets = selected.filter(
      (entry) => entry.eligibility.sizeEligible,
    );
    const estimates = sizeTargets.length
      ? await measure({
          enabled: true,
          items: sizeTargets.map((entry) => entry.item),
          page,
          signal: context.signal,
        })
      : [];
    context.assertAuthorized();
    if (estimates.length !== sizeTargets.length)
      throw new McpEditError(
        "invalid_edit",
        "Source measurement inventory mismatch.",
      );
    const byBlock = new Map<string, Estimate>(
      sizeTargets.map((entry, i) => [entry.block.id, estimates[i]]),
    );
    result.push({ page, inspected, selected, byBlock, sourceImageSha256 });
  }
  return result;
}

type Prepared = Awaited<ReturnType<typeof prepareSources>>;
async function sourceDigest(page: MangaPage, context: McpOperationContext) {
  context.assertAuthorized();
  const dimensions = await probePageExportSourceImage(
    page.imagePath,
    context.signal,
  );
  if (dimensions.width !== page.width || dimensions.height !== page.height)
    throw new McpEditError(
      "revision_conflict",
      "Source dimensions differ from the saved page.",
    );
  const bytes = await readFile(page.imagePath, { signal: context.signal });
  context.assertAuthorized();
  return createHash("sha256").update(bytes).digest("hex");
}

function projectEvidence(
  entry: Prepared[number],
  inspected: Input["prepared"][number],
  resolver: FontChapterC18Resolver | undefined,
  available: Set<string>,
) {
  const selected = new Map(entry.selected.map((item) => [item.block.id, item]));
  const items = inspected.blocks.map((block) => {
    const target = selected.get(block.blockId);
    const font = candidateEvidence(entry, target, resolver, available);
    const estimate = block.sizeEligible
      ? (entry.byBlock.get(block.blockId) ?? null)
      : null;
    return {
      blockId: block.blockId,
      font,
      estimate,
      fontExclusion:
        block.fontExclusion ?? (font ? null : "no_available_c23_candidate"),
      sizeExclusion:
        block.sizeExclusion ??
        (estimate ? null : "insufficient_raster_evidence"),
    };
  });
  return {
    pageId: entry.page.id,
    revision: inspected.revision,
    sourceImageSha256: entry.sourceImageSha256,
    items,
  };
}

function candidateEvidence(
  entry: Prepared[number],
  target: Prepared[number]["selected"][number] | undefined,
  resolver: FontChapterC18Resolver | undefined,
  available: Set<string>,
) {
  if (!target?.eligibility.fontEligible || !resolver) return null;
  const raw = resolver(entry.page.id, target.item);
  if (!raw) return null;
  const choice = McpTypographyFontChoiceSchema.parse(raw);
  return available.has(choice.fontId) ? choice : null;
}
