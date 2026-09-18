import type { MangaPage } from "../../shared/libraryTypes";
import type { McpImageEditCommand } from "../../shared/mcpImageEditing";
import type { InpaintingJobContext } from "../jobs/inpaintingJobTypes";
import type { InpaintingJobRuntime } from "../jobs/inpaintingJobRuntime";
import { applyInpaintingRetouch } from "../inpainting";
import { inpaintDrawnPatternPage } from "../inpainting/drawnPatternPage";
import { McpEditError } from "../application/mcpEditPolicy";
import type { prepareMcpImageEdit } from "./mcpImageEditEvidence";

export type McpImageEditRuntime = Pick<
  InpaintingJobRuntime,
  "getSettings" | "acquireEngine"
>;
type Prepared = Awaited<ReturnType<typeof prepareMcpImageEdit>>;
export type McpImageProduct = {
  page: MangaPage;
  componentsChanged: number;
  componentsIncomplete: number;
};
export async function produceMcpImageEdit(
  app: InpaintingJobContext,
  page: MangaPage,
  command: McpImageEditCommand,
  prepared: Prepared,
  guard: () => void,
  signal: AbortSignal,
  runtime: McpImageEditRuntime,
  produced: (value: McpImageProduct) => void,
): Promise<McpImageProduct> {
  guard();
  if (command.kind === "paint" || command.kind === "restore") {
    const next = await applyInpaintingRetouch(page, {
      mode: command.kind,
      geometry: command.geometry,
      color: command.kind === "paint" ? command.color : undefined,
      protectedMask: prepared.protectedMask,
      decodeFallback: app.decodeImage,
    });
    const result = {
      page: next,
      componentsChanged: prepared.stats.components,
      componentsIncomplete: 0,
    };
    produced(result);
    guard();
    return result;
  }
  if (!command.allowAssetDownloads)
    throw new McpEditError(
      "invalid_edit",
      "Explicit allowAssetDownloads=true is required for the app's approved local engine preparation. No model was run.",
    );
  const settings = await runtime.getSettings(app.appPaths);
  guard();
  if ((settings.inpainting?.model ?? "flux-klein") !== command.expectedEngine)
    throw new McpEditError(
      "revision_conflict",
      "Configured erasure engine differs from the reviewed plan. No fallback or settings change was made.",
    );
  const lease = await runtime.acquireEngine({
    appPaths: app.appPaths,
    model: command.expectedEngine,
    fluxBackend: settings.inpainting?.fluxBackend,
    koharuBackend: settings.inpainting?.koharuBackend,
    computeGpuIndex: settings.hardware?.computeGpuIndex,
    allowUnsafeLowMemoryFlux:
      settings.inpainting?.allowUnsafeLowMemoryFlux ?? false,
    signal,
  });
  let failure: unknown, result: McpImageProduct | undefined;
  try {
    guard();
    if (lease.engine.model !== command.expectedEngine)
      throw new McpEditError(
        "invalid_edit",
        "Native runtime returned an unexpected erasure engine.",
      );
    const erased = await inpaintDrawnPatternPage(page, {
      strokes: [],
      preparedMask: prepared.mask,
      featherPx: 0,
      inpaintingEngine: lease.engine,
      decodeFallback: app.decodeImage,
      signal,
    });
    result = {
      page: erased.page,
      componentsChanged: erased.blocksErased,
      componentsIncomplete: erased.blocksIncomplete ?? 0,
    };
    produced(result);
    guard();
  } catch (error) {
    failure = error;
  }
  try {
    // Cleanup is not cancellable and cannot be skipped by a reporting callback.
    await lease.release();
  } catch (error) {
    failure = failure
      ? new AggregateError(
          [failure, error],
          "Image processing and native model cleanup failed.",
        )
      : error;
  }
  if (failure) throw failure;
  guard();
  if (!result) throw new Error("Native image processing returned no result.");
  return result;
}
