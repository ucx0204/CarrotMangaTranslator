import { reduceMcpCandidatePng } from "./mcpCandidatePng";
import { randomUUID } from "node:crypto";
import {
  McpExternalImageGetPreviewSchema,
  type McpExternalImageChangeView,
} from "../../shared/mcpExternalImages";
import { McpEditError } from "../application/mcpEditPolicy";
import { readImageRedactionState } from "../imageRedactionStore";
import { readMcpImageEditPage } from "./mcpImageEditEvidence";
import type { McpImageUploadStore } from "./mcpImageUploadStore";
import { withExternalImageAssets } from "./mcpExternalImageAssets";
import { prepareMcpExternalImage } from "./mcpExternalImagePreparation";
import { createMcpBatchTool } from "./mcpBatchTool";
import { textContent } from "./mcpReadTools";

type Inspect = (
  owner: string,
  args: unknown,
  guard: () => void,
) => Promise<{
  chapterId: string;
  contextRevision: string;
  pages: { pageId: string; expectedRevision: string }[];
  changes: McpExternalImageChangeView[];
}>;
export function createMcpExternalImageReadTool(
  uploads: McpImageUploadStore,
  inspect: Inspect,
  lifetime: AbortSignal,
) {
  return createMcpBatchTool({
    name: "carrot_get_external_image_preview",
    schema: McpExternalImageGetPreviewSchema,
    scopes: ["carrot.read", "carrot.images"],
    write: false,
    description:
      "Inspect an owned external candidate BEFORE applying it. A background preview is the composited background only; a lettering preview is the masked transparent ASSET, not the final transformed page. No file/page save, model or renderer pipeline. Long edge at most 1600px and 4 MiB. Original/image/context binding, upload readiness/expiry, image permission and redaction are rechecked. Background application is a separate explicit action.",
    execute: async (value, owner, guard) => {
      const args = McpExternalImageGetPreviewSchema.parse(value);
      const check = () => {
        lifetime.throwIfAborted();
        guard();
      };
      await imageAccess(check);
      const plan = await inspect(
        owner,
        { ...args, offset: 0, limit: 1 },
        check,
      );
      const target = plan.pages[0],
        change = plan.changes[0];
      if (!target || !change)
        throw new McpEditError(
          "not_found",
          "External image plan is unavailable.",
        );
      const input = {
        chapterId: plan.chapterId,
        pageId: target.pageId,
        revision: target.expectedRevision,
        contextRevision: plan.contextRevision,
        requestId: randomUUID(),
        reason: "Inspect owned external candidate",
        command: change.command,
      };
      const page = await readMcpImageEditPage(input, check);
      return withExternalImageAssets(
        uploads,
        owner,
        input,
        check,
        async (assets) => {
          const prepared = await prepareMcpExternalImage(page, input, assets);
          if (prepared.change.stats.snapshot !== change.stats.snapshot)
            throw new McpEditError(
              "revision_conflict",
              "External candidate changed since review.",
            );
          const png = reduceMcpCandidatePng(prepared.pixels.bytes);
          await readMcpImageEditPage(input, check);
          await imageAccess(check);
          assets.guard();
          return {
            ...args,
            chapterId: input.chapterId,
            pageId: input.pageId,
            revision: input.revision,
            kind:
              input.command.kind === "lettering"
                ? ("lettering-asset" as const)
                : ("background-candidate" as const),
            snapshot: change.stats.snapshot,
            ...png,
          };
        },
      );
    },
    formatResult: ({ imageData, ...metadata }) => [
      ...textContent(metadata),
      { type: "image", data: imageData, mimeType: "image/png" },
    ],
  });
}
async function imageAccess(guard: () => void) {
  guard();
  if ((await readImageRedactionState()).enabled)
    throw new McpEditError(
      "access_denied",
      "External candidate transfer is blocked by image redaction review.",
    );
  guard();
}
