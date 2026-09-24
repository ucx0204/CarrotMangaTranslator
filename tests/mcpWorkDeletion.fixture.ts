import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { chapterMoveFixture } from "./mcpChapterMove.fixture";
import {
  McpWorkDeletionApplySchema,
  mcpWorkDeletionOutputs,
} from "../src/shared/mcpWorkDeletion";

export async function workDeletionFixture(probeAvailable = true) {
  const f = await chapterMoveFixture(probeAvailable);
  const workDirectory = join(f.env.libraryDir, "works", "work");
  const indexPath = join(f.env.libraryDir, "index.json");
  const captureWork = async () => ({
    tree: await f.files.captureChapterDeletionTree(
      workDirectory,
      () => {},
      "work.json",
    ),
    index: JSON.parse(await readFile(indexPath, "utf8")),
  });
  const originalWork = await captureWork();
  const previewWork = async (workId = "work") =>
    mcpWorkDeletionOutputs.carrot_preview_work_deletion.parse(
      await f.call("carrot_preview_work_deletion", { workId }),
    );
  const commandWork = async (workId = "work") =>
    McpWorkDeletionApplySchema.parse({
      workId,
      requestId: randomUUID(),
      snapshot: (await previewWork(workId)).snapshot,
      confirm: "delete-work-with-seven-day-recovery",
    });
  const applyWork = async (
    input: Awaited<ReturnType<typeof commandWork>>,
    caller = f.auth(),
  ) =>
    mcpWorkDeletionOutputs.carrot_delete_work.parse(
      await f.call("carrot_delete_work", input, caller),
    );
  const inspectWork = async (id: string) =>
    mcpWorkDeletionOutputs.carrot_get_work_deletion.parse(
      await f.call("carrot_get_work_deletion", { id }),
    );
  const recoverWork = async (id: string, direction: "undo" | "redo") => {
    const input = {
      id,
      snapshot: (await inspectWork(id)).snapshot,
      requestId: randomUUID(),
      confirm: true,
    };
    return {
      input,
      receipt: mcpWorkDeletionOutputs.carrot_undo_work_deletion.parse(
        await f.call(`carrot_${direction}_work_deletion`, input),
      ),
    };
  };
  return {
    ...f,
    workDirectory,
    indexPath,
    originalWork,
    captureWork,
    previewWork,
    commandWork,
    applyWork,
    inspectWork,
    recoverWork,
    assertWorkOriginal: async () =>
      expect(await captureWork()).toEqual(originalWork),
  };
}
