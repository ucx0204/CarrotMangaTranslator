import { z } from "zod/v4";
import { McpImportCreateSchema } from "./mcpLibraryImport";
import { McpWorkFileCreateSchema } from "./mcpWorkFileImport";
import { McpImportBatchRunSchema } from "./mcpImportBatch";
import { McpResearchBatchRunSchema } from "./mcpResearchBatch";
import { McpContextApplySchema } from "./mcpContextEditing";
import { McpWorkflowRunSchema } from "./mcpWorkflow";
import { McpTranslationBatchActionSchema } from "./mcpTranslationBatch";
import { McpTypographyAnalysisTargetSchema } from "./mcpTypographyAnalysis";
import { McpTypographyBatchPreviewSchema } from "./mcpTypographyBatch";
import { McpLetteringPrepareSchema } from "./mcpLettering";
import { McpSoundEffectPrepareSchema } from "./mcpSoundEffects";
import {
  McpExportPagesTargetSchema,
  McpExportZipTargetSchema,
} from "./mcpExportBatch";
import { McpWorkFileExportTargetSchema } from "./mcpWorkFileExport";
import { McpTextExportTargetSchema } from "./mcpTextExchange";
import { McpContextExportSchema } from "./mcpContextExchange";

const action = <K extends string, S extends z.ZodType>(kind: K, input: S) =>
  z.object({ kind: z.literal(kind), input }).strict();
const importCreate = action("import-create", McpImportCreateSchema);
const workFileImport = action("work-file-import", McpWorkFileCreateSchema);
export const McpCompositeImportActionSchema = z.discriminatedUnion("kind", [
  importCreate,
  workFileImport,
]);
export type McpCompositeImportAction = z.infer<
  typeof McpCompositeImportActionSchema
>;
/** A closed native dispatch table: no arbitrary tool name, code or JSON arguments. */
export const McpCompositeWorkflowActionSchema = z.discriminatedUnion("kind", [
  importCreate,
  workFileImport,
  action("import-batch-run", McpImportBatchRunSchema),
  action("research-run", McpResearchBatchRunSchema),
  action("context-apply", McpContextApplySchema),
  action("workflow-run", McpWorkflowRunSchema),
  action("selection-apply", McpTranslationBatchActionSchema),
  action("typography-analyze", McpTypographyAnalysisTargetSchema),
  action("typography-prepare", McpTypographyBatchPreviewSchema),
  action("typography-apply", McpTranslationBatchActionSchema),
  action("lettering-prepare", McpLetteringPrepareSchema),
  action("lettering-apply", McpTranslationBatchActionSchema),
  action("sfx-prepare", McpSoundEffectPrepareSchema),
  action("sfx-apply", McpTranslationBatchActionSchema),
  action("images-export", McpExportPagesTargetSchema),
  action("work-file-export", McpWorkFileExportTargetSchema),
  action("zip-export", McpExportZipTargetSchema),
  action("text-export", McpTextExportTargetSchema),
  action("context-export", McpContextExportSchema),
]);
export type McpCompositeWorkflowAction = z.infer<
  typeof McpCompositeWorkflowActionSchema
>;
export const McpCompositeWorkflowActionKindSchema = z.enum([
  "import-create",
  "work-file-import",
  "import-batch-run",
  "research-run",
  "context-apply",
  "workflow-run",
  "selection-apply",
  "typography-analyze",
  "typography-prepare",
  "typography-apply",
  "lettering-prepare",
  "lettering-apply",
  "sfx-prepare",
  "sfx-apply",
  "images-export",
  "work-file-export",
  "zip-export",
  "text-export",
  "context-export",
]);
