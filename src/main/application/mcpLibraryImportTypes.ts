import type { McpUploadedImport } from "../../shared/mcpFileUploads";
import type {
  CreateImportFromPreviewRequest,
  ImportPreviewResult,
  ImportChapterDraft,
} from "../../shared/importTypes";
import type {
  McpChooseImport,
  McpScanImport,
  McpImportReceipt,
  McpImportPreviewReferenceSchema,
} from "../../shared/mcpLibraryImport";
import type { McpImportPublication } from "../../shared/mcpImportPublication";
import type {
  McpImportDuplicates,
  mcpImportDuplicateOutputs,
} from "../../shared/mcpImportDuplicates";
import type { McpOperationContext } from "./mcpOperationService";
import type {
  McpImportSourcePageIdentity,
  McpPreparedImportMapping,
} from "./mcpImportMappingPolicy";

export type PreparedMcpImport = {
  preview: ImportPreviewResult;
  sourceBytes: number;
  evidence: string;
  warnings: string[];
  identify: (
    chapters: ImportChapterDraft[],
    guard: () => void,
    sourceUrl?: string,
    observePage?: (identity: McpImportSourcePageIdentity) => void,
  ) => Promise<ImportChapterDraft[]>;
  verify: () => Promise<void>;
  cleanup: () => Promise<void>;
};
export type McpImportEntry = {
  owner: string;
  prepared: PreparedMcpImport;
  reference: ReturnType<typeof McpImportPreviewReferenceSchema.parse>;
  pageIds: string[][];
  sourceUrl?: string;
  busy: false | "checking" | "importing";
  imported: boolean;
};
export type McpLibraryImportPorts = {
  now: () => number;
  prepare: (
    input: McpChooseImport | McpScanImport | McpUploadedImport,
    context: McpOperationContext,
    owner: string,
  ) => Promise<PreparedMcpImport | undefined>;
  find: (
    owner: string,
    input: McpImportPublication,
  ) => Promise<McpImportReceipt | undefined>;
  duplicates: (
    target: McpImportDuplicates["target"],
    chapters: ImportChapterDraft[],
    guard: () => void,
  ) => Promise<
    ReturnType<
      typeof mcpImportDuplicateOutputs.carrot_get_import_duplicates.parse
    >
  >;
  commit: (
    owner: string,
    input: McpImportPublication,
    request: CreateImportFromPreviewRequest,
    source: "local" | "web",
    verify: () => Promise<void>,
    context: McpOperationContext,
    mapping: McpPreparedImportMapping,
  ) => Promise<McpImportReceipt>;
  reportError: (error: unknown) => void;
};
