import { createMcpMemoryRefreshTools } from "./mcpMemoryRefreshTools";
import type { InpaintingJobContext } from "../jobs/inpaintingJobTypes";
import {
  McpContextMigrationApplySchema,
  McpContextMigrationRecoverySchema,
} from "../../shared/mcpContextMigration";
import {
  McpRetainedGetSchema,
  McpRetentionListSchema,
} from "../../shared/mcpRetention";
import { createMcpBatchTool } from "./mcpBatchTool";
import { McpContextMigrationApplication } from "./mcpContextMigrationApplication";
import { McpContextMigrationRepository } from "./mcpContextMigrationRepository";
import type { McpRetentionStorage } from "./mcpRetentionStorage";
import type { McpRetentionCatalog } from "./mcpRetentionCatalog";

type Editing = ConstructorParameters<typeof McpContextMigrationApplication>[2];

export function createMcpContextMigrationSession(
  storage: McpRetentionStorage,
  app: InpaintingJobContext,
  editing: Editing,
  catalog: McpRetentionCatalog,
  lifetime: AbortSignal,
  enabled: boolean,
) {
  const service = new McpContextMigrationApplication(
    new McpContextMigrationRepository(storage),
    app,
    editing,
    lifetime,
  );
  const tasks = new Set<Promise<unknown>>();
  const track = <T>(task: Promise<T>): Promise<T> => {
    tasks.add(task);
    return task.finally(() => tasks.delete(task));
  };
  const tools = [
    ...createMcpMemoryRefreshTools(service, lifetime, enabled, track),
    createMcpBatchTool({
      name: "carrot_list_context_migrations",
      schema: McpRetentionListSchema,
      scopes: ["carrot.read"],
      write: false,
      description:
        "List this approved connection's restart-persistent whole-work context migration receipts. Metadata only, bounded by the existing seven-day retention catalog. No names, story text, paths, models or writes. Continue pagination with its catalog snapshot.",
      execute: (args, owner, guard) =>
        catalog.list(
          owner,
          "context",
          McpRetentionListSchema.parse(args),
          guard,
        ),
    }),
    createMcpBatchTool({
      name: "carrot_get_context_migration",
      schema: McpRetainedGetSchema,
      scopes: ["carrot.read"],
      write: false,
      description:
        "Inspect one owned durable context migration, its current whole-work reference snapshot and advisory Undo/Redo availability. Does not restore or disclose raw records. Any subsequent saved-page, catalog, memory or membership change can block exact recovery. Actual availability and authority are checked again before native publication.",
      execute: (args, owner, guard) =>
        service.inspect(owner, McpRetainedGetSchema.parse(args).id, guard),
    }),
  ];
  if (enabled) tools.push(...mutationTools(service, track));
  return {
    tools,
    application: service,
    close: async () => {
      await Promise.allSettled([...tasks]);
    },
  };
}

function mutationTools(
  service: McpContextMigrationApplication,
  track: <T>(task: Promise<T>) => Promise<T>,
) {
  const scopes = ["carrot.read", "carrot.edit", "carrot.process"];
  return [
    createMcpBatchTool({
      name: "carrot_apply_context_migration",
      schema: McpContextMigrationApplySchema,
      scopes,
      write: true,
      description:
        "Apply the exact explicit merge/delete/replacement intent reviewed with carrot_preview_context_migration. Requires its unfiltered reference snapshot and matching plan fingerprint. Preserves manual entries by default and never infers name identity. Publishes catalog, block/memory ID remapping and encrypted recovery together. Dialogue, summary/digests, formatting and images are preserved. No OCR, translation or internet research runs. Repeated requestId returns its historical receipt, including after restart.",
      execute: (args, owner, guard) =>
        track(
          service.apply(
            owner,
            McpContextMigrationApplySchema.parse(args),
            guard,
          ),
        ),
    }),
    ...(["undo", "redo"] as const).map((direction) =>
      createMcpBatchTool({
        name: `carrot_${direction}_context_migration`,
        schema: McpContextMigrationRecoverySchema,
        scopes,
        write: true,
        description: `${direction.toUpperCase()} one owned retained context migration with the current referenceSnapshot from carrot_get_context_migration and a new requestId. Existing native ownership and a single transaction protect all affected chapters. Restores exact catalog, memory and reference-field presence without models. Later edits conflict; no forced overwrite. Seven-day retention and 32 actions per record. Discarding its retained record disables recovery, not the saved context.`,
        execute: (args, owner, guard) =>
          track(
            service.recover(
              owner,
              McpContextMigrationRecoverySchema.parse(args),
              direction,
              guard,
            ),
          ),
      }),
    ),
  ];
}
