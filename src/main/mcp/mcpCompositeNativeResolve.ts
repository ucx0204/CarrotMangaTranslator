import type { McpCompositeWorkflowAction } from "../../shared/mcpCompositeWorkflowActions";
import type { McpCompositePrepare } from "../../shared/mcpCompositeWorkflow";
import type { SoundEffectPlan } from "../application/mcpSoundEffectPolicy";
import type {
  McpCompositeGuard,
  McpCompositeRecord,
} from "../application/mcpCompositeWorkflowPorts";
import type { CompositeNativeCallOptions } from "./mcpCompositeNativeCalls";
import type {
  McpCompositeSourceOptions,
  readMcpCompositeSources,
} from "./mcpCompositeNativePages";
import {
  createCompositeNativeReader,
  requireMcpCompositeNativeTool,
} from "./mcpCompositeNativeTools";
import {
  compositeNativeDispatch,
  compositeNativeFamily,
} from "./mcpCompositeNativeDispatch";
import {
  costCompositeImport,
  inspectCompositeContext,
  type CompositeImportOptions,
} from "./mcpCompositeNativeContext";
import { costCompositeNativeOutput } from "./mcpCompositeNativeOutputs";
import {
  costCompositeNativeBatch,
  readCompositeNativeBatch,
} from "./mcpCompositeNativeBatches";
import {
  costCompositeImportBatchRun,
  costCompositeResearchRun,
  costCompositeWorkflowRun,
} from "./mcpCompositeNativeRuns";
import {
  costCompositeLetteringPreparation,
  costCompositeSoundEffectPreparation,
  costCompositeTypographyAnalysis,
  costCompositeTypographyPreparation,
} from "./mcpCompositeNativePreparation";
import { nativeCompositeCost, scopeError } from "./mcpCompositeNativeScope";

export type CompositeNativeOptions = CompositeNativeCallOptions &
  McpCompositeSourceOptions &
  CompositeImportOptions & {
    readSoundEffectPlan: (
      owner: string,
      batchId: string,
      guard: () => void,
    ) => SoundEffectPlan;
  };
export type CompositeSourceRead = Awaited<
  ReturnType<typeof readMcpCompositeSources>
>;
export type CompositeContextAnchor = Awaited<
  ReturnType<typeof inspectCompositeContext>
>;
type Preparation = Extract<
  McpCompositeWorkflowAction,
  {
    kind:
      | "typography-analyze"
      | "typography-prepare"
      | "lettering-prepare"
      | "sfx-prepare";
  }
>;

/** The policy freezes requirements already authorized for every declared family. */
export function compositeNativeRequirements(
  options: CompositeNativeOptions,
  plan: McpCompositePrepare,
) {
  const names = new Set<string>();
  for (const phase of plan.phases) {
    if (phase.kind === "review") names.add("carrot_render_page_preview");
    else addFamilyRequirements(names, phase.action);
  }
  const scopes = new Set<string>(["carrot.read"]);
  for (const name of names)
    for (const scope of requireMcpCompositeNativeTool(options.tools, name)
      .requiredScopes ?? [])
      scopes.add(scope);
  return [...scopes].sort();
}
function addFamilyRequirements(
  names: Set<string>,
  family: McpCompositeWorkflowAction["kind"],
) {
  names.add(compositeNativeFamily(family).tool);
  if (family === "images-export") {
    names.add("carrot_export_pages_images");
    names.add("carrot_export_pages_psd");
  }
  if (family === "sfx-prepare") names.add("carrot_generate_sound_effects");
}

/** Every branch reads the native target/review before deriving its finite admission cost. */
export async function resolveCompositeNativeAction(
  options: CompositeNativeOptions,
  record: McpCompositeRecord,
  action: McpCompositeWorkflowAction,
  phaseId: string,
  source: CompositeSourceRead,
  guard: McpCompositeGuard,
): Promise<{
  cost: ReturnType<typeof nativeCompositeCost>;
  context?: CompositeContextAnchor;
}> {
  const read = createCompositeNativeReader(options.tools);
  guard(
    requireMcpCompositeNativeTool(
      options.tools,
      compositeNativeDispatch(action).tool,
    ).requiredScopes,
  );
  switch (action.kind) {
    case "import-create":
    case "work-file-import":
      return {
        cost: await costCompositeImport(
          options,
          record,
          action,
          phaseId,
          guard,
        ),
      };
    case "context-apply":
      return {
        cost: nativeCompositeCost(),
        context: await inspectCompositeContext(
          read,
          record.owner,
          action,
          source.values,
          guard,
        ),
      };
    case "selection-apply":
    case "typography-apply":
    case "lettering-apply":
    case "sfx-apply": {
      const batch = await readCompositeNativeBatch(
        options,
        record.owner,
        action.kind,
        action.input.batchId,
        guard,
      );
      return {
        cost: costCompositeNativeBatch(
          source.values,
          batch,
          action.input.requestId,
        ),
      };
    }
    default:
      return {
        cost: await resolveOtherAction(options, record, action, source, guard),
      };
  }
}
async function resolveOtherAction(
  options: CompositeNativeOptions,
  record: McpCompositeRecord,
  action: McpCompositeWorkflowAction,
  source: CompositeSourceRead,
  guard: McpCompositeGuard,
) {
  const read = createCompositeNativeReader(options.tools);
  if (isOutput(action))
    return costCompositeNativeOutput(
      { read, operations: options.operations },
      record,
      action,
      source.values,
      guard,
    );
  switch (action.kind) {
    case "workflow-run":
      return costCompositeWorkflowRun(
        read,
        record,
        action,
        source.values,
        source.settings,
        guard,
      );
    case "research-run":
      return costCompositeResearchRun(
        read,
        record,
        action,
        source.values,
        guard,
      );
    case "import-batch-run":
      return costCompositeImportBatchRun(read, record, action, guard);
    case "typography-analyze":
    case "typography-prepare":
    case "lettering-prepare":
    case "sfx-prepare":
      return resolvePreparation(options, record, action, source, guard);
    default:
      throw scopeError();
  }
}
function isOutput(action: McpCompositeWorkflowAction): action is Extract<
  McpCompositeWorkflowAction,
  {
    kind:
      | "images-export"
      | "work-file-export"
      | "zip-export"
      | "text-export"
      | "context-export";
  }
> {
  return [
    "images-export",
    "work-file-export",
    "zip-export",
    "text-export",
    "context-export",
  ].includes(action.kind);
}
async function resolvePreparation(
  options: CompositeNativeOptions,
  record: McpCompositeRecord,
  action: Preparation,
  source: CompositeSourceRead,
  guard: McpCompositeGuard,
) {
  const read = createCompositeNativeReader(options.tools);
  switch (action.kind) {
    case "typography-analyze":
      return costCompositeTypographyAnalysis(
        read,
        record,
        action,
        source.values,
        guard,
      );
    case "typography-prepare":
      return costCompositeTypographyPreparation(
        options.operations,
        record,
        action,
        source.values,
        guard,
      );
    case "lettering-prepare":
      return costCompositeLetteringPreparation(action, source.values);
    case "sfx-prepare":
      return costCompositeSoundEffectPreparation(
        read,
        record,
        action,
        source.values,
        guard,
      );
  }
}
