import {
  McpContextExportPreflightSchema,
  McpContextExportSchema,
  McpContextImportPreviewSchema,
  McpContextImportApplySchema,
  type McpContextExport,
} from "../../shared/mcpContextExchange";
import { McpExchangeFileArtifactSchema } from "../../shared/mcpExchangeFiles";
import { McpEditError } from "../application/mcpEditPolicy";
import type {
  McpOperationContext,
  McpOperationService,
} from "../application/mcpOperationService";
import type { McpArtifactStore } from "./mcpArtifactStore";
import type { McpContextExchangeApplication } from "./mcpContextExchangeApplication";
import { readMcpContextExchangeState } from "./mcpContextExchangeSource";
import { createMcpBatchTool } from "./mcpBatchTool";

type Options = {
  artifacts: McpArtifactStore;
  operations: McpOperationService;
  imports: McpContextExchangeApplication;
  lifetime: AbortSignal;
  allowEditing: boolean;
  track: <T>(task: Promise<T>) => Promise<T>;
};
const read = ["carrot.read"];
const edit = ["carrot.read", "carrot.edit", "carrot.process"];

export function createMcpContextExchangeTools(options: Options) {
  const guard = (check: () => void) => () => {
    options.lifetime.throwIfAborted();
    check();
  };
  return [
    createMcpBatchTool({
      name: "carrot_preflight_context_export",
      schema: McpContextExportPreflightSchema,
      scopes: read,
      write: false,
      description:
        "Review a bounded JSON export of one saved work guide and optionally one chapter's memory. Uses current native IDs, explicit absent-file state and a source snapshot. Returns metadata, byte count and hash. No text-model, image transfer, mutation or capability creation. Content is native saved data, not executable instructions. Export requires this sourceSnapshot; maximum 4 MiB UTF-8 without truncation.",
      execute: async (value, _owner, check) =>
        (
          await readMcpContextExchangeState(
            McpContextExportPreflightSchema.parse(value),
            guard(check),
            options.lifetime,
          )
        ).review,
    }),
    createMcpBatchTool({
      name: "carrot_export_context_json",
      schema: McpContextExportSchema,
      scopes: read,
      write: false,
      background: true,
      description:
        "Serialize exactly the reviewed native context as carrot-context.json. Poll carrot_get_job, then explicitly request carrot_get_job_file without pageId. Saved guide/memory presence and current source snapshot are checked before publication and delivery. Read permission is sufficient; no image bytes, model or source mutation. Retained reissue returns identical bytes while source and owner remain valid, with no reserialization. File generation does not prove client receipt.",
      execute: (value, owner, check) => {
        const input = McpContextExportSchema.parse(value);
        return options.operations.start({
          owner,
          requestId: input.requestId,
          kind: "contextFileExport",
          parameters: input,
          assertAuthorized: guard(check),
          execute: (job) => exportContext(options, input, job),
        });
      },
    }),
    ...(options.allowEditing ? contextImportTools(options, guard) : []),
  ];
}

function contextImportTools(
  options: Options,
  guard: (check: () => void) => () => void,
) {
  return [
    createMcpBatchTool({
      name: "carrot_preview_context_import",
      schema: McpContextImportPreviewSchema,
      scopes: edit,
      write: false,
      description:
        "Review an owned UTF-8 context JSON upload using explicit existing glossary/character/rule/memory targets and selected native editable fields. Returns paginated before/after changes, source hash and whole-work reference snapshot. Strict JSON and native schemas; raw and canonical bytes each at most 4 MiB. Uploaded evidence, timestamps and model provenance are inspect-only. Memory edits require native page revisions; selected visual summaries become manual. No name-based matching, new entries, replacement, image edit or automatic save. Keep the upload until explicit apply settles.",
      execute: (value, owner, check) =>
        options.track(
          options.imports.preview(
            owner,
            McpContextImportPreviewSchema.parse(value),
            guard(check),
            options.lifetime,
          ),
        ),
    }),
    createMcpBatchTool({
      name: "carrot_apply_context_import",
      schema: McpContextImportApplySchema,
      scopes: edit,
      write: true,
      background: true,
      description:
        "Apply only selected change IDs from the exact reviewed context upload, source hash, plan fingerprint and current whole-work reference snapshot. Reuses the native atomic context migration and encrypted recovery transaction. Original images, dialogue and unselected fields are preserved; no model or forced stale apply. The owned upload lease and authorization last through publication. Same requestId returns its durable historical receipt after restart without rereading an expired upload. Inspect and explicitly Undo/Redo using existing context migration tools.",
      execute: (value, owner, check) =>
        options.track(
          options.imports.apply(
            owner,
            McpContextImportApplySchema.parse(value),
            guard(check),
            options.lifetime,
          ),
        ),
    }),
  ];
}

async function exportContext(
  options: Options,
  input: McpContextExport,
  job: McpOperationContext,
) {
  const signal = AbortSignal.any([job.signal, options.lifetime]);
  const guard = () => {
    signal.throwIfAborted();
    job.assertAuthorized();
  };
  const source = await readMcpContextExchangeState(
    {
      workId: input.workId,
      chapterId: input.chapterId,
      scope: input.scope,
    },
    guard,
    signal,
  );
  if (source.binding.snapshot !== input.sourceSnapshot)
    throw new McpEditError(
      "revision_conflict",
      "Saved context changed; review the export again.",
    );
  const access = async () => {
    guard();
    await source.verifySources();
    guard();
  };
  const artifact = await options.artifacts.putExchange(
    source.bytes,
    source.binding,
    access,
    signal,
  );
  guard();
  return McpExchangeFileArtifactSchema.parse({
    ...artifact,
    kind: "exchange-file",
    filename: "carrot-context.json",
    exchange: source.binding,
    performed: ["serialize", "export"],
  });
}
