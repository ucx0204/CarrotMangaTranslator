import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import type { McpContextSnapshot } from "../application/mcpContextEditPolicy";
import type { TypographySnapshotRequest } from "../application/mcpTypographyBatchPolicy";
import { assertTypographyEvidence } from "../application/mcpTypographyBatchPolicy";
import { McpEditError } from "../application/mcpEditPolicy";
import {
  McpTypographyAnalysisObservationSchema,
  type McpTypographyAnalysisObservation,
} from "../../shared/mcpTypographyAnalysis";
import { MAX_PAGE_EXPORT_ORIGINAL_IMAGE_BYTES } from "../../shared/pageExportLimits";
import { probePageExportSourceImage } from "../pageExportRasterSafety";
import { readMcpFontCatalog } from "./mcpFontCatalogAdapter";
import { readMcpTypographyFontEnvironment } from "./mcpTypographyFontRuntime";

/** Internal forward-edit evidence only: paths come from the saved library, never remote input.
 * This performs no model work, downloads, page saves or image transfer. */
export async function verifyMcpTypographySourceEvidence(
  saved: McpContextSnapshot,
  value: McpTypographyAnalysisObservation,
  dependencies: TypographySnapshotRequest["dependencies"],
  guard: () => void,
  now = Date.now,
) {
  guard();
  const observation = McpTypographyAnalysisObservationSchema.parse(value);
  assertFresh(observation, now);
  assertTypographyEvidence(saved, observation, dependencies);
  await verifyEnvironment(saved, observation, guard);
  for (const inspected of observation.pages) {
    guard();
    const page = saved.chapter.pages.find(
      (item) => item.id === inspected.pageId,
    );
    if (!page) throw new McpEditError("not_found", "Analyzed page is missing.");
    const dimensions = await probePageExportSourceImage(page.imagePath);
    guard();
    if (dimensions.width !== page.width || dimensions.height !== page.height)
      throw new McpEditError(
        "revision_conflict",
        "Original dimensions changed.",
      );
    const hash = await originalHash(page.imagePath, guard);
    guard();
    if (hash !== inspected.sourceImageSha256)
      throw new McpEditError(
        "revision_conflict",
        "Analyzed original bytes changed.",
      );
  }
  const environment = await verifyEnvironment(saved, observation, guard);
  guard();
  assertFresh(observation, now);
  return environment;
}

async function verifyEnvironment(
  saved: McpContextSnapshot,
  observation: McpTypographyAnalysisObservation,
  guard: () => void,
) {
  guard();
  const catalog = await readMcpFontCatalog();
  guard();
  if (catalog.snapshot !== observation.catalogSnapshot)
    throw new McpEditError(
      "revision_conflict",
      "Typography font catalog changed.",
    );
  const environment = await readMcpTypographyFontEnvironment({
    saved,
    request: { mode: observation.mode },
  });
  guard();
  if (environment.snapshot !== observation.environmentSnapshot)
    throw new McpEditError(
      "revision_conflict",
      "Typography profile, candidate pool or runtime identity changed.",
    );
  return environment;
}

function assertFresh(
  observation: McpTypographyAnalysisObservation,
  now: () => number,
) {
  if (observation.expiresAt <= now())
    throw new McpEditError(
      "not_found",
      "Typography observation expired; analyze again before a forward edit.",
    );
}

async function originalHash(path: string, guard: () => void): Promise<string> {
  const hash = createHash("sha256");
  let bytes = 0;
  // Iteration closes the stream on a guard, size-limit or filesystem failure.
  for await (const chunk of createReadStream(path, {
    highWaterMark: 1024 * 1024,
  })) {
    guard();
    bytes += chunk.length;
    if (bytes > MAX_PAGE_EXPORT_ORIGINAL_IMAGE_BYTES)
      throw new McpEditError(
        "invalid_edit",
        "Typography source exceeds the app image budget.",
      );
    hash.update(chunk);
  }
  guard();
  return hash.digest("hex");
}
