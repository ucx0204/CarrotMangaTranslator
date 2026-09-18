import { hashStableValue } from "../../shared/blockFingerprint";
import type { InpaintingJobContext } from "../jobs/inpaintingJobTypes";
import type { LetteringPreparation } from "../application/mcpLetteringPolicy";
import { McpEditError } from "../application/mcpEditPolicy";
import { validateBatchTargets } from "../application/mcpPageBatchPolicy";
import { readWorkContextForEdit } from "../library";
import { getAppSettings } from "../settingsStore";
import { createProductionBubbleLayoutRunner } from "../bubbleLayout/bubbleLayoutFacade";
import { disposeCachedKoharuLayoutSessions } from "../bubbleLayout/session";
import type { BubbleLayoutRunnerFactory } from "../inpainting/bubbleLayoutRunner";
import {
  captureMcpLetteringBinding,
  assertMcpLetteringBinding,
} from "./mcpLetteringEvidence";
import {
  prepareMcpLetteringPages,
  resolveMcpLetteringRecipe,
} from "./mcpLetteringPagePreparation";

type Runtime = {
  create: BubbleLayoutRunnerFactory;
  dispose: () => Promise<unknown>;
};
export function createMcpLetteringPreparation(
  app: InpaintingJobContext,
  runtime: Runtime = {
    create: createProductionBubbleLayoutRunner,
    dispose: disposeCachedKoharuLayoutSessions,
  },
): LetteringPreparation {
  return async (saved, input, access) => {
    const geometry =
      input.command.kind === "layout" && input.command.mode !== "wrap";
    if (
      geometry &&
      input.command.kind === "layout" &&
      !input.command.allowAssetDownloads
    )
      throw new McpEditError(
        "invalid_edit",
        "Native geometry detection may install approved Koharu assets. Explicit allowAssetDownloads=true is required.",
      );
    const recipe = resolveMcpLetteringRecipe(input);
    const before = await captureMcpLetteringBinding(saved, input, access.guard);
    const runner = geometry
      ? await createRunner(app, runtime, access.guard)
      : undefined;
    const result = await withModelCleanup(
      () =>
        prepareMcpLetteringPages(
          saved,
          input,
          access,
          recipe,
          before.catalog,
          runner,
        ),
      runner ? runtime.dispose : undefined,
    );
    access.guard();
    access.signal?.throwIfAborted();
    const current = await readWorkContextForEdit(input.chapterId);
    validateBatchTargets(current, input);
    if (
      current.workId !== saved.workId ||
      hashStableValue(current.chapter) !== hashStableValue(saved.chapter)
    )
      throw new McpEditError(
        "revision_conflict",
        "Saved lettering context changed during preparation.",
      );
    const after = await captureMcpLetteringBinding(
      current,
      input,
      access.guard,
    );
    assertMcpLetteringBinding(before.binding, after.binding);
    return { ...result, binding: before.binding };
  };
}
async function createRunner(
  app: InpaintingJobContext,
  runtime: Runtime,
  guard: () => void,
) {
  const settings = await getAppSettings(app.appPaths);
  guard();
  return runtime.create({
    dataRoot: app.appPaths.dataRoot,
    decodeFallback: app.decodeImage,
    directMl: settings.hardware,
  });
}
async function withModelCleanup<T>(
  run: () => Promise<T>,
  dispose?: Runtime["dispose"],
): Promise<T> {
  const failures: unknown[] = [];
  let result!: T;
  try {
    result = await run();
  } catch (error) {
    failures.push(error);
  }
  if (dispose) {
    try {
      await dispose();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length)
    throw new AggregateError(
      failures,
      "Lettering preparation and model cleanup failed.",
    );
  return result;
}
