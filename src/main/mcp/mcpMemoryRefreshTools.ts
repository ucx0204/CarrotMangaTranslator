import {
  McpMemoryInspectSchema,
  McpMemoryRefreshPreviewSchema,
  McpMemoryRefreshApplySchema,
} from "../../shared/mcpMemoryRefresh";
import {
  inspectMcpMemoryStatus,
  prepareMcpMemoryRefresh,
} from "../application/mcpMemoryRefreshPolicy";
import { readWorkContextReferences } from "../library/libraryContextEditingFacade";
import { buildPageStoryMemory } from "../pipeline/storyMemoryBuilder";
import type { McpContextMigrationApplication } from "./mcpContextMigrationApplication";
import { createMcpBatchTool } from "./mcpBatchTool";

/** Independent saved-text operations; no model, image read, research or translation. */
export function createMcpMemoryRefreshTools(
  service: McpContextMigrationApplication,
  lifetime: AbortSignal,
  enabled: boolean,
  track: <T>(task: Promise<T>) => Promise<T>,
) {
  const tools = [
    createMcpBatchTool({
      name: "carrot_get_memory_status",
      description:
        "Inspect full saved-page text evidence across one work. Reports current/stale/unknown/missing/duplicate/orphan memories without exposing text or changing files. Legacy compact excerpts are unknown, never evidence of complete freshness. Current is not OCR, visual or summary-quality verification. Continue with the same snapshot and filter.",
      schema: McpMemoryInspectSchema,
      scopes: ["carrot.read"],
      write: false,
      execute: async (args, _owner, guard) => {
        const input = McpMemoryInspectSchema.parse(args);
        return inspectMcpMemoryStatus(
          await readMemoryGraph(input.chapterId, guard, lifetime),
          input,
          guard,
        );
      },
    }),
    createMcpBatchTool({
      name: "carrot_preview_memory_refresh",
      description:
        "Preview only selected saved-page text summaries. Use referenceSnapshot and full text fingerprints from carrot_get_memory_status. Choose the existing native excerpt builder or supply an explicitly reviewed saved-page summary; no model or internet lookup runs. Existing nonempty summaries require replaceExistingSummary=true. Manual visual summaries, unrelated rows, catalog, dialogue and images stay intact. Apply separately using its planFingerprint.",
      schema: McpMemoryRefreshPreviewSchema,
      scopes: ["carrot.read"],
      write: false,
      execute: async (args, _owner, guard) => {
        const input = McpMemoryRefreshPreviewSchema.parse(args);
        return prepareMcpMemoryRefresh(
          await readMemoryGraph(input.chapterId, guard, lifetime),
          input,
          new Date().toISOString(),
          guard,
          (page, pageIndex) => buildPageStoryMemory({ page, pageIndex }),
        ).preview;
      },
    }),
  ];
  if (enabled)
    tools.push(
      createMcpBatchTool({
        name: "carrot_apply_memory_refresh",
        description:
          "Apply the exact reviewed memory refresh with a new requestId. Publishes only selected summaries, native excerpts and full-text evidence together with mandatory encrypted recovery. Does not certify image content or summary quality. Rechecks the complete saved work before commit, preserves manual visual summaries and all artwork. Replay survives restart. Inspect, Undo/Redo or list its receipt with the existing context-migration tools; no provider, OCR, translation or renderer is executed.",
        schema: McpMemoryRefreshApplySchema,
        scopes: ["carrot.read", "carrot.edit", "carrot.process"],
        write: true,
        execute: (args, owner, guard) => {
          const input = McpMemoryRefreshApplySchema.parse(args);
          const { requestId: _requestId, ...intent } = input;
          return track(
            service.applyIntent(
              owner,
              input,
              guard,
              (graph, now, check) => {
                const { delta, beforeSnapshot, afterSnapshot } =
                  prepareMcpMemoryRefresh(
                    graph,
                    intent,
                    now,
                    check,
                    (page, pageIndex) =>
                      buildPageStoryMemory({ page, pageIndex }),
                  );
                return { delta, beforeSnapshot, afterSnapshot };
              },
              "carrot_apply_memory_refresh",
            ),
          );
        },
      }),
    );
  return tools;
}

async function readMemoryGraph(
  chapterId: string,
  guard: () => void,
  lifetime: AbortSignal,
) {
  lifetime.throwIfAborted();
  guard();
  const graph = await readWorkContextReferences(chapterId, guard);
  lifetime.throwIfAborted();
  guard();
  return graph;
}
