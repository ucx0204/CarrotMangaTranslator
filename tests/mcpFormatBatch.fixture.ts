import { randomUUID } from "node:crypto";
import { setImmediate as tick } from "node:timers/promises";
import { translationBatchFixture } from "./mcpTranslationBatch.fixture";
import { McpPageBatchService } from "../src/main/application/mcpPageBatchService";
import {
  formatBatchPolicy,
  type FormatSnapshotRequest,
} from "../src/main/application/mcpFormatBatchPolicy";
import type { BatchPorts } from "../src/main/application/mcpPageBatchTypes";
import { McpEditError } from "../src/main/application/mcpEditPolicy";
import { McpFormatBatchPreviewSchema } from "../src/shared/mcpFormatBatch";
import { mcpContextRevision } from "../src/shared/mcpContextEditing";
import { createPageRevision } from "../src/shared/pageRevision";

export function formatBatchFixture() {
  const f = translationBatchFixture();
  let time = 1000;
  const ports: BatchPorts<FormatSnapshotRequest> = {
    ...f.ports,
    commit: (request, expected, guard, committed) =>
      f.edits.commitFormatBatch(
        request,
        expected.membership,
        guard,
        committed,
        async (run) => {
          guard();
          if (
            expected.contextRevision !== null &&
            expected.contextRevision !== mcpContextRevision(f.saved)
          )
            throw new McpEditError("revision_conflict", "context changed");
          return run();
        },
      ),
  };
  const service = new McpPageBatchService(
    ports,
    formatBatchPolicy,
    () => time,
    f.lifetime.signal,
  );
  const request = () =>
    McpFormatBatchPreviewSchema.parse({
      chapterId: f.chapter.id,
      contextRevision: mcpContextRevision(f.saved),
      requestId: randomUUID(),
      reason: "User finds typography cramped; AI selects each repair",
      pages: f.chapter.pages.map((page) => ({
        pageId: page.id,
        revision: createPageRevision(page),
        edits: [
          {
            blockId: "a",
            fields: { letterSpacing: 0.12, textOpacity: 0.8 },
            reason: "Improve spacing only",
          },
        ],
      })),
    });
  const inspect = (batchId: string) =>
    service.inspect(f.owner, { batchId }, f.guard);
  const done = async (batchId: string) => {
    for (let count = 0; count < 100; count++) {
      await tick();
      const result = await inspect(batchId);
      if (result.status !== "running") return result;
    }
    throw new Error("Format batch did not settle");
  };
  return {
    ...f,
    service,
    ports,
    request,
    inspect,
    done,
    advance: (ms: number) => {
      time += ms;
    },
    start: (
      batchId: string,
      direction: "apply" | "undo" | "redo",
      requestId: string = randomUUID(),
    ) => service.start(f.owner, { batchId, requestId }, direction, f.guard),
    close: async () => {
      await service.close();
      await f.service.close();
    },
  };
}
