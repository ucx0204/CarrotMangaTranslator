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
type Erasure = Extract<
  McpImageEditCommand,
  { kind: "erase-blocks" | "erase-mask" }
>;
type Production = {
  app: InpaintingJobContext;
  page: MangaPage;
  prepared: Prepared;
  guard: () => void;
  signal: AbortSignal;
  runtime: McpImageEditRuntime | undefined;
  produced: (value: McpImageProduct) => void;
};

export async function produceMcpImageEdit(
  app: InpaintingJobContext,
  page: MangaPage,
  command: McpImageEditCommand,
  prepared: Prepared,
  guard: () => void,
  signal: AbortSignal,
  runtime: McpImageEditRuntime | undefined,
  produced: Production["produced"],
): Promise<McpImageProduct> {
  guard();
  const input = { app, page, prepared, guard, signal, runtime, produced };
  return command.kind === "paint" || command.kind === "restore"
    ? produceRetouch(input, command)
    : produceErasure(input, command);
}
async function produceRetouch(
  input: Production,
  command: Extract<McpImageEditCommand, { kind: "paint" | "restore" }>,
) {
  const next = await applyInpaintingRetouch(input.page, {
    mode: command.kind,
    geometry: command.geometry,
    color: command.kind === "paint" ? command.color : undefined,
    protectedMask: input.prepared.protectedMask,
    decodeFallback: input.app.decodeImage,
  });
  const result = {
    page: next,
    componentsChanged: input.prepared.stats.components,
    componentsIncomplete: 0,
  };
  input.produced(result);
  input.guard();
  return result;
}
async function acquireLocalEngine(input: Production, command: Erasure) {
  if (!command.allowAssetDownloads)
    throw new McpEditError(
      "invalid_edit",
      "Explicit allowAssetDownloads=true is required for approved local engine preparation. No model was run.",
    );
  const runtime =
    input.runtime ??
    (await import("../jobs/inpaintingJobRuntime.js"))
      .productionInpaintingJobRuntime;
  input.guard();
  const settings = await runtime.getSettings(input.app.appPaths);
  input.guard();
  if ((settings.inpainting?.model ?? "flux-klein") !== command.expectedEngine)
    throw new McpEditError(
      "revision_conflict",
      "Configured erasure engine differs from the reviewed plan. No fallback or settings change was made.",
    );
  return runtime.acquireEngine({
    appPaths: input.app.appPaths,
    model: command.expectedEngine,
    fluxBackend: settings.inpainting?.fluxBackend,
    koharuBackend: settings.inpainting?.koharuBackend,
    computeGpuIndex: settings.hardware?.computeGpuIndex,
    allowUnsafeLowMemoryFlux:
      settings.inpainting?.allowUnsafeLowMemoryFlux ?? false,
    signal: input.signal,
  });
}
async function produceErasure(input: Production, command: Erasure) {
  const lease = await acquireLocalEngine(input, command);
  let failure: unknown, result: McpImageProduct | undefined;
  try {
    input.guard();
    if (lease.engine.model !== command.expectedEngine)
      throw new McpEditError(
        "invalid_edit",
        "Native runtime returned an unexpected erasure engine.",
      );
    const erased = await inpaintDrawnPatternPage(input.page, {
      strokes: [],
      preparedMask: input.prepared.mask,
      featherPx: 0,
      inpaintingEngine: lease.engine,
      decodeFallback: input.app.decodeImage,
      signal: input.signal,
    });
    result = {
      page: erased.page,
      componentsChanged: erased.blocksErased,
      componentsIncomplete: erased.blocksIncomplete ?? 0,
    };
    input.produced(result);
    input.guard();
  } catch (error) {
    failure = error;
  }
  try {
    // Cleanup is not cancellable and cannot be skipped by reporting failures.
    await lease.release();
  } catch (error) {
    failure = failure
      ? new AggregateError(
          [failure, error],
          "Image processing and native cleanup failed.",
          { cause: error },
        )
      : error;
  }
  if (failure) throw failure;
  input.guard();
  if (!result) throw new Error("Native image processing returned no result.");
  return result;
}
