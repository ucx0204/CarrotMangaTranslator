import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { chapterDeletionFixture } from "./mcpChapterDeletion.fixture";
import {
  McpChapterMoveApplySchema,
  mcpChapterMoveOutputs,
  type McpChapterMoveIntent,
} from "../src/shared/mcpChapterMove";

export async function chapterMoveFixture(probeAvailable = true) {
  const f = await chapterDeletionFixture(probeAvailable);
  const destinationWork = {
    ...f.source.work,
    id: "destination",
    title: "Destination work",
    chapterOrder: ["dest-chapter"],
  };
  const destinationRoot = join(f.env.libraryDir, "works", destinationWork.id);
  await mkdir(join(destinationRoot, "chapters", "dest-chapter"), {
    recursive: true,
  });
  await writeFile(
    join(destinationRoot, "work.json"),
    JSON.stringify(destinationWork),
  );
  await writeFile(
    join(destinationRoot, "chapters", "dest-chapter", "chapter.json"),
    JSON.stringify({
      ...f.source.chapter,
      id: "dest-chapter",
      workId: destinationWork.id,
      pages: [],
      pageOrder: [],
      status: "idle",
    }),
  );
  await writeFile(
    join(f.env.libraryDir, "index.json"),
    JSON.stringify({ workOrder: ["work", "destination"] }),
  );
  const intent: McpChapterMoveIntent = {
    ...f.target,
    destinationWorkId: destinationWork.id,
    beforeChapterId: "dest-chapter",
  };
  const previewMove = async (value = intent) =>
    mcpChapterMoveOutputs.carrot_preview_chapter_move.parse(
      await f.call("carrot_preview_chapter_move", { intent: value }),
    );
  const commandMove = async (value = intent) => {
    const review = await previewMove(value);
    return McpChapterMoveApplySchema.parse({
      intent: value,
      snapshot: review.snapshot,
      planFingerprint: review.planFingerprint,
      requestId: randomUUID(),
      confirm: "move-chapter-between-existing-works",
    });
  };
  const applyMove = async (
    input: Awaited<ReturnType<typeof commandMove>>,
    caller = f.auth(),
  ) =>
    mcpChapterMoveOutputs.carrot_move_chapter.parse(
      await f.call("carrot_move_chapter", input, caller),
    );
  const inspectMove = async (id: string) =>
    mcpChapterMoveOutputs.carrot_get_chapter_move.parse(
      await f.call("carrot_get_chapter_move", { id }),
    );
  const recoverMove = async (id: string, direction: "undo" | "redo") => {
    const view = await inspectMove(id);
    const input = {
      id,
      snapshot: view.snapshot,
      requestId: randomUUID(),
      confirm: true,
    };
    const receipt = mcpChapterMoveOutputs.carrot_undo_chapter_move.parse(
      await f.call(`carrot_${direction}_chapter_move`, input),
    );
    return { input, receipt };
  };
  const assertMoveRestored = async () => {
    await f.assertOriginal();
    expect(
      JSON.parse(await readFile(join(destinationRoot, "work.json"), "utf8")),
    ).toEqual(destinationWork);
  };
  return {
    ...f,
    intent,
    destinationRoot,
    destinationWork,
    previewMove,
    commandMove,
    applyMove,
    inspectMove,
    recoverMove,
    assertMoveRestored,
  };
}
