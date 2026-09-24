import { hashStableValue } from "../../shared/blockFingerprint";
import type { McpCompositeWorkflowAction } from "../../shared/mcpCompositeWorkflowActions";

type Family = McpCompositeWorkflowAction["kind"];
type Mode = "job" | "workflow" | "research" | "batch" | "immediate";
type Specification = { mode: Mode; tool: string; nativeKind: string };
const specifications = {
  "import-create": {
    mode: "job",
    tool: "carrot_import_chapters",
    nativeKind: "importCreate",
  },
  "work-file-import": {
    mode: "job",
    tool: "carrot_import_work_file",
    nativeKind: "workFileImport",
  },
  "import-batch-run": {
    mode: "job",
    tool: "carrot_run_import_batch",
    nativeKind: "importBatchScan",
  },
  "research-run": {
    mode: "research",
    tool: "carrot_run_research_batch",
    nativeKind: "research-run",
  },
  "context-apply": {
    mode: "immediate",
    tool: "carrot_apply_context_proposal",
    nativeKind: "context-apply",
  },
  "workflow-run": {
    mode: "workflow",
    tool: "carrot_run_workflow",
    nativeKind: "workflow-run",
  },
  "selection-apply": {
    mode: "batch",
    tool: "carrot_apply_selection_batch",
    nativeKind: "selection-apply",
  },
  "typography-analyze": {
    mode: "job",
    tool: "carrot_run_typography_analysis",
    nativeKind: "typographyAnalysis",
  },
  "typography-prepare": {
    mode: "immediate",
    tool: "carrot_preview_typography_batch",
    nativeKind: "typography-prepare",
  },
  "typography-apply": {
    mode: "batch",
    tool: "carrot_apply_typography_batch",
    nativeKind: "typography-apply",
  },
  "lettering-prepare": {
    mode: "job",
    tool: "carrot_prepare_lettering_batch",
    nativeKind: "letteringPrepare",
  },
  "lettering-apply": {
    mode: "batch",
    tool: "carrot_apply_lettering_batch",
    nativeKind: "lettering-apply",
  },
  "sfx-prepare": {
    mode: "job",
    tool: "carrot_prepare_sound_effect_batch",
    nativeKind: "soundEffectPrepare",
  },
  "sfx-apply": {
    mode: "batch",
    tool: "carrot_apply_sound_effect_batch",
    nativeKind: "sfx-apply",
  },
  "images-export": {
    mode: "job",
    tool: "carrot_export_pages_png",
    nativeKind: "exportPages",
  },
  "work-file-export": {
    mode: "job",
    tool: "carrot_export_work_file",
    nativeKind: "workFileExport",
  },
  "zip-export": {
    mode: "job",
    tool: "carrot_create_export_zip",
    nativeKind: "exportZip",
  },
  "text-export": {
    mode: "job",
    tool: "carrot_export_text_file",
    nativeKind: "textFileExport",
  },
  "context-export": {
    mode: "job",
    tool: "carrot_export_context_json",
    nativeKind: "contextFileExport",
  },
} satisfies Record<Family, Specification>;

/** Closed native dispatch; no caller-selected tool name or executable argument. */
export function compositeNativeDispatch(
  action: McpCompositeWorkflowAction,
): Specification {
  const spec = specifications[action.kind];
  if (action.kind === "sfx-prepare" && action.input.command.kind === "generate")
    return { ...spec, tool: "carrot_generate_sound_effects" };
  if (action.kind === "images-export" && action.input.imageExport)
    return {
      ...spec,
      tool:
        action.input.imageExport.format === "psd"
          ? "carrot_export_pages_psd"
          : "carrot_export_pages_images",
    };
  return spec;
}

export function compositeNativeReference(action: McpCompositeWorkflowAction) {
  const spec = compositeNativeDispatch(action);
  if (spec.mode === "immediate") return null;
  const kind =
    spec.mode === "workflow" || spec.mode === "research"
      ? "run"
      : spec.nativeKind;
  return {
    requestId: action.input.requestId,
    kind: spec.nativeKind,
    fingerprint: hashStableValue([kind, action.input]),
  };
}

export function compositeNativeFamily(family: Family): Specification {
  return specifications[family];
}
