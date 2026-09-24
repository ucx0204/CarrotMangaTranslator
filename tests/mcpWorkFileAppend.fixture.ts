import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  McpWorkFileCreateSchema,
  mcpWorkFileOutputs,
  type McpWorkFileAppendReview,
} from "../src/shared/mcpWorkFileImport";
import { workFileFixture } from "./mcpWorkFileImport.fixture";

export async function workFileAppendFixture() {
  const f = await workFileFixture();
  const workPath = join(f.env.libraryDir, "works", "work", "work.json");
  const guidePath = join(f.env.libraryDir, "works", "work", "style-guide.json");
  const { readWorkStyleGuide } =
    await import("../src/main/libraryStore/workContextFiles");
  await writeFile(guidePath, JSON.stringify(await readWorkStyleGuide("work")));
  const inspectAppend = async (input: McpWorkFileAppendReview) =>
    mcpWorkFileOutputs.carrot_preview_work_file_append.parse(
      await f.invoke("carrot_preview_work_file_append", input),
    );
  const prepareAppend = async (
    target: McpWorkFileAppendReview["target"] = {
      workId: "work",
      contextPolicy: "preserve-destination",
    },
  ) => {
    const { command } = await f.prepareWorkFile();
    const input = {
      uploadId: command.uploadId,
      snapshot: command.snapshot,
      chapters: command.chapters,
      target,
    };
    const review = await inspectAppend(input);
    return {
      input,
      review,
      command: McpWorkFileCreateSchema.parse({
        ...command,
        target: review.target,
      }),
    };
  };
  const capture = async () => ({
    work: await readFile(workPath),
    chapter: await readFile(f.chapterPath),
    guide: await readFile(guidePath),
    library: await f.library.listLibrary(),
  });
  return { ...f, workPath, guidePath, inspectAppend, prepareAppend, capture };
}
