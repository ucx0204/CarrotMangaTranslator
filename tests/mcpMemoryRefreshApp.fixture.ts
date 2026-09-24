import { randomUUID } from "node:crypto";
import { contextMigrationAppFixture } from "./mcpContextMigrationApp.fixture";
import {
  McpMemoryRefreshPreviewSchema,
  McpMemoryRefreshApplySchema,
  mcpMemoryRefreshOutputs,
} from "../src/shared/mcpMemoryRefresh";

export async function memoryRefreshAppFixture() {
  const f = await contextMigrationAppFixture();
  const status = async () =>
    mcpMemoryRefreshOutputs.carrot_get_memory_status.parse(
      await f.invoke("carrot_get_memory_status", { chapterId: "chapter" }),
    );
  const input = async (extra: object = {}) => {
    const current = await status();
    const row = current.items.find(
      (item) => item.chapterId === "chapter" && item.revision !== null,
    );
    if (!row) throw new Error("Missing fixture memory target");
    const intent = McpMemoryRefreshPreviewSchema.parse({
      chapterId: "chapter",
      referenceSnapshot: current.referenceSnapshot,
      replaceExistingSummary: true,
      pages: [
        {
          chapterId: row.chapterId,
          pageId: row.pageId,
          revision: row.revision,
          sourceFingerprint: row.sourceFingerprint,
          translationFingerprint: row.translationFingerprint,
          summary: {
            kind: "reviewed-page-text",
            text: "Reviewed current page text",
          },
        },
      ],
      ...extra,
    });
    const preview = mcpMemoryRefreshOutputs.carrot_preview_memory_refresh.parse(
      await f.invoke("carrot_preview_memory_refresh", intent),
    );
    return McpMemoryRefreshApplySchema.parse({
      ...intent,
      planFingerprint: preview.planFingerprint,
      requestId: randomUUID(),
    });
  };
  const apply = async (request?: Awaited<ReturnType<typeof input>>) =>
    mcpMemoryRefreshOutputs.carrot_apply_memory_refresh.parse(
      await f.invoke("carrot_apply_memory_refresh", request ?? (await input())),
    );
  return { ...f, status, memoryInput: input, refresh: apply };
}
