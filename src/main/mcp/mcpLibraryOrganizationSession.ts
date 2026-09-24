import type { McpLibraryChangedEvent } from "../../shared/mcpEditingTypes";
import { createMcpPageDeletionTools } from "./mcpPageDeletionTools";
import { createMcpWorkDeletionTools } from "./mcpWorkDeletionTools";
import { createMcpChapterMoveTools } from "./mcpChapterMoveTools";
import { createMcpChapterDeletionTools } from "./mcpChapterDeletionTools";
import { createMcpBatchTool } from "./mcpBatchTool";
import { McpLibraryOrganizationApplication } from "./mcpLibraryOrganizationApplication";
import { McpLibraryOrganizationRepository } from "./mcpLibraryOrganizationRepository";
import { McpRetentionCatalog } from "./mcpRetentionCatalog";
import type { McpRetentionStorage } from "./mcpRetentionStorage";
import type { McpPreferences } from "../../shared/mcpDesktopTypes";
import {
  McpRetainedGetSchema,
  McpRetentionListSchema,
} from "../../shared/mcpRetention";
import {
  McpLibraryOrganizationPreviewSchema,
  McpLibraryOrganizationApplySchema,
  McpLibraryOrganizationRecoverySchema,
} from "../../shared/mcpLibraryOrganization";

type Run = <T>(
  guard: () => void,
  execute: (check: () => void) => Promise<T>,
) => Promise<T>;

export function createMcpLibraryOrganizationSession(
  storage: McpRetentionStorage,
  preferences: McpPreferences,
  notifyChanged?: (event: McpLibraryChangedEvent) => void,
  assertChapterClosed?: (chapterId: string) => Promise<void>,
) {
  const lifetime = new AbortController();
  const pending = new Set<Promise<unknown>>();
  const service = new McpLibraryOrganizationApplication(
    new McpLibraryOrganizationRepository(storage),
    notifyChanged,
  );
  const catalog = new McpRetentionCatalog(storage, lifetime.signal, false);
  const run: Run = (guard, execute) => {
    const check = () => {
      lifetime.signal.throwIfAborted();
      guard();
    };
    const task = Promise.resolve().then(async () => {
      check();
      const result = await execute(check);
      check();
      return result;
    });
    pending.add(task);
    return task.finally(() => pending.delete(task));
  };
  const editor = assertChapterClosed
    ? { assertChapterClosed, notifyLibraryChanged: notifyChanged }
    : undefined;
  const tools = [
    ...createMcpPageDeletionTools(storage, catalog, preferences, editor, run),
    ...readTools(service, catalog, run),
    ...createMcpWorkDeletionTools(storage, catalog, preferences, editor, run),
    ...createMcpChapterMoveTools(storage, catalog, preferences, editor, run),
    ...createMcpChapterDeletionTools(
      storage,
      catalog,
      preferences,
      editor,
      run,
    ),
  ];
  if (preferences.allowEditing && preferences.allowProcessing)
    tools.push(...mutationTools(service, run));
  return {
    tools,
    stop: () => lifetime.abort(),
    close: async () => {
      lifetime.abort();
      await Promise.allSettled([...pending]);
    },
  };
}
function readTools(
  service: McpLibraryOrganizationApplication,
  catalog: McpRetentionCatalog,
  run: Run,
) {
  return [
    createMcpBatchTool({
      name: "carrot_preview_library_change",
      schema: McpLibraryOrganizationPreviewSchema,
      scopes: ["carrot.read"],
      write: false,
      description:
        "Review one work/chapter rename or complete chapter/page order through native policies. Returns actual before/after values, current metadata snapshot and plan fingerprint without saving, moving files, reading image bytes or running models. Reordering requires every current chapter or page exactly once. Page order also shows before/after memory row IDs, indexes and names; native reconciliation may remove duplicate/orphan memory rows, retained for exact Undo. No summary text is returned. Moves and deletion are unsupported.",
      execute: (args, _owner, guard) =>
        run(guard, (check) =>
          service.preview(
            McpLibraryOrganizationPreviewSchema.parse(args).intent,
            check,
          ),
        ),
    }),
    createMcpBatchTool({
      name: "carrot_get_library_change",
      schema: McpRetainedGetSchema,
      scopes: ["carrot.read"],
      write: false,
      description:
        "Inspect an owned retained library metadata change and current snapshot for advisory Undo/Redo availability. No raw native records or image paths. Later saved edits can block recovery; missing/deleted targets are not recreated. Does not execute models or restore data.",
      execute: (args, owner, guard) =>
        run(guard, (check) =>
          service.inspect(owner, McpRetainedGetSchema.parse(args).id, check),
        ),
    }),
    createMcpBatchTool({
      name: "carrot_list_library_changes",
      schema: McpRetentionListSchema,
      scopes: ["carrot.read"],
      write: false,
      description:
        "List this approved connection's metadata change IDs after restart. Uses the existing seven-day catalog and its pagination snapshot. Discard an owned record with carrot_discard_retained; discarding recovery never removes a work, chapter or original.",
      execute: (args, owner, guard) =>
        run(guard, (check) =>
          catalog.list(
            owner,
            "library",
            McpRetentionListSchema.parse(args),
            check,
          ),
        ),
    }),
  ];
}
function mutationTools(service: McpLibraryOrganizationApplication, run: Run) {
  const scopes = ["carrot.read", "carrot.edit", "carrot.process"];
  return [
    createMcpBatchTool({
      name: "carrot_apply_library_change",
      schema: McpLibraryOrganizationApplySchema,
      scopes,
      write: true,
      description:
        "Apply the exact naming/chapter/page-order intent reviewed by carrot_preview_library_change with its snapshot, fingerprint and a new requestId. Native metadata and encrypted recovery are published atomically. Page ordering changes order/status and the reviewed memory layout, not page payloads, source images or summary generation. No automatic translation, moves or deletion. Replayed requests return a historical receipt even after Undo; they do not apply again.",
      execute: (args, owner, guard) =>
        run(guard, (check) =>
          service.apply(
            owner,
            McpLibraryOrganizationApplySchema.parse(args),
            check,
          ),
        ),
    }),
    ...(["undo", "redo"] as const).map((direction) =>
      createMcpBatchTool({
        name: `carrot_${direction}_library_change`,
        schema: McpLibraryOrganizationRecoverySchema,
        scopes,
        write: true,
        description: `${direction.toUpperCase()} one owned library metadata change using the current snapshot from carrot_get_library_change and a new requestId. Exact title/order/metadata restoration without image or model work. Conflicting later edits are rejected, never overwritten. Seven-day retention, same data profile/connection, maximum 32 recovery actions.`,
        execute: (args, owner, guard) =>
          run(guard, (check) =>
            service.recover(
              owner,
              McpLibraryOrganizationRecoverySchema.parse(args),
              direction,
              check,
            ),
          ),
      }),
    ),
  ];
}
