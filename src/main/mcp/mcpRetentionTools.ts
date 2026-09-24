import {
  McpRetentionListSchema,
  McpRetainedGetSchema,
  McpRetainedDiscardSchema,
  McpRecoveryActionSchema,
} from "../../shared/mcpRetention";
import { createMcpBatchTool } from "./mcpBatchTool";
import type { McpRecoveryAction } from "../../shared/mcpRetention";
import { McpEditError } from "../application/mcpEditPolicy";

type Service = {
  list: (
    owner: string,
    kind: "change" | "output",
    input: { offset: number; limit: number; snapshot?: string },
    guard: () => void,
  ) => Promise<unknown>;
  change: (owner: string, id: string, guard: () => void) => Promise<unknown>;
  output: (owner: string, id: string, guard: () => void) => Promise<unknown>;
  file: (
    owner: string,
    id: string,
    guard: () => void,
    assertAdditionalScopes: (scopes: readonly string[]) => void,
  ) => Promise<unknown>;
  apply: (
    owner: string,
    input: McpRecoveryAction,
    direction: "undo" | "redo",
    guard: () => void,
  ) => Promise<unknown>;
  discard: (owner: string, id: string, guard: () => void) => Promise<unknown>;
};
export function createMcpRetentionTools(
  service: Service,
  enabled: boolean,
  images: boolean,
) {
  const tools = readRetentionTools(service);
  tools.push(
    createMcpBatchTool({
      name: "carrot_get_output_file",
      schema: McpRetainedGetSchema,
      scopes: ["carrot.read"],
      write: false,
      background: true,
      description:
        "Issue a NEW ten-minute file link for owned retained text/context or native PNG/JPEG/WebP/PSD/ZIP/working-file bytes. Text/context needs read permission; image-bearing formats additionally require enabled image transfer, current image permission and redaction approval. Rechecks owner, same profile, saved source binding, exact content bytes and retention expiry on access. No rendering, model, implicit export or page save. Revocation, stop, source changes or explicit discard block the link. Historical bytes are never regenerated or resized.",
      execute: (args, owner, guard, assertAdditionalScopes) =>
        service.file(
          owner,
          McpRetainedGetSchema.parse(args).id,
          guard,
          (scopes) => {
            if (!images)
              throw new McpEditError(
                "access_denied",
                "Image transfer is not enabled for this MCP session.",
              );
            assertAdditionalScopes(scopes);
          },
        ),
    }),
  );
  if (enabled) {
    for (const direction of ["undo", "redo"] as const)
      tools.push(
        createMcpBatchTool({
          name: `carrot_${direction}_change`,
          schema: McpRecoveryActionSchema,
          scopes: ["carrot.read", "carrot.edit", "carrot.process"],
          write: true,
          description: `${direction.toUpperCase()} an owned durable page change using every current page/review revision from carrot_get_change and a fresh requestId. Native handoff, locks, source evidence and an atomic page/assets/receipt transaction are mandatory. Restores retained content without another model or renderer. Exact retries remain historical after restart; later edits conflict. Supports up to 50 pages per native record, 32 actions, and seven-day retention. Never revives an executable analysis plan.`,
          execute: (args, owner, guard) =>
            service.apply(
              owner,
              McpRecoveryActionSchema.parse(args),
              direction,
              guard,
            ),
        }),
      );
    tools.push(
      createMcpBatchTool({
        name: "carrot_discard_retained",
        schema: McpRetainedDiscardSchema,
        scopes: ["carrot.read", "carrot.edit", "carrot.process"],
        write: true,
        description:
          "Explicitly discard ONE owned durable recovery record or retained output with confirm=true. Removes only this record's private copies and invalidates its file links. Does not alter saved pages, restored image copies, original artwork, other exports or another owner's records. Recovery/download is no longer available after discard.",
        execute: (args, owner, guard) =>
          service.discard(
            owner,
            McpRetainedDiscardSchema.parse(args).id,
            guard,
          ),
      }),
    );
  }
  return tools;
}

function readRetentionTools(service: Service) {
  return ["change", "output"].flatMap((kind) => {
    const selected =
      kind === "change" ? ("change" as const) : ("output" as const);
    return [
      createMcpBatchTool({
        name: `carrot_list_${kind}s`,
        schema: McpRetentionListSchema,
        scopes: ["carrot.read"],
        write: false,
        description:
          "List this connection's durable saved page changes or retained text/context/raster/PSD/ZIP/working-file outputs. Metadata only; no image, path, model or page mutation. Records survive restart in the same encrypted profile for seven days, within 256 records/1 GiB. Pagination after offset zero requires the returned catalog snapshot. A new unrelated OAuth connection cannot inherit these records.",
        execute: (args, owner, guard) =>
          service.list(
            owner,
            selected,
            McpRetentionListSchema.parse(args),
            guard,
          ),
      }),
      createMcpBatchTool({
        name: `carrot_get_${kind}`,
        schema: McpRetainedGetSchema,
        scopes: ["carrot.read"],
        write: false,
        description:
          selected === "change"
            ? "Inspect an owned durable native page-change record, current page/review revisions, changed fields and advisory undo/redo availability. No raw snapshots, images, paths, model observations or writes. After restart use this record ID, not the expired session batch ID. Later edits, sources and chapter membership are checked; redo also checks saved context. Runtime job statuses/checkpoints are not restored."
            : "Inspect an owned retained text/context/raster/PSD/ZIP/working-file output and its saved source bindings without rendering or transferring bytes. Stored output and source integrity must remain valid. Image-bearing downloads additionally require enabled image transfer, current image permission and redaction approval. Use carrot_get_output_file to issue a fresh short-lived link; old links never revive.",
        execute: (args, owner, guard) =>
          service[selected](owner, McpRetainedGetSchema.parse(args).id, guard),
      }),
    ];
  });
}
