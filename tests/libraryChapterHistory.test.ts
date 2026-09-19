import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { soundEffectFixture } from "./mcpSoundEffect.fixture";

it("publishes the optional chapter participant atomically with a native page save", async () => {
  const f = await soundEffectFixture();
  try {
    const { withLibraryChapterHistory } =
      await import("../src/main/libraryStore/libraryChapterHistory");
    const path = join(f.env.libraryDir, "participant-test.json");
    const plan = await f.preview({
      kind: "text",
      edits: [{ blockId: "a", translatedText: "native participant" }],
    });
    const result = await withLibraryChapterHistory(
      async (transaction, chapter) => {
        expect(chapter.pages[0].blocks[0].translatedText).toBe(
          "native participant",
        );
        await transaction.stageJsonReplacement(path, { saved: true });
      },
      () => f.action(plan.batchId, "apply"),
    );
    expect(result.result.status).toBe("completed");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ saved: true });
    expect((await f.snapshot()).pages[0].blocks[0].translatedText).toBe(
      "native participant",
    );
  } finally {
    await f.close();
  }
});
it("refuses a native page save when its history participant fails and does not affect unrelated writes", async () => {
  const f = await soundEffectFixture();
  try {
    const { withLibraryChapterHistory } =
      await import("../src/main/libraryStore/libraryChapterHistory");
    const before = await readFile(f.chapterPath);
    const plan = await f.preview({
      kind: "text",
      edits: [{ blockId: "a", translatedText: "not saved" }],
    });
    const result = await withLibraryChapterHistory(
      async () => {
        throw new Error("retention storage failed");
      },
      () => f.action(plan.batchId, "apply"),
    );
    expect(result.result.status).toBe("failed");
    expect(await readFile(f.chapterPath)).toEqual(before);
    const next = await f.preview({
      kind: "text",
      edits: [{ blockId: "a", translatedText: "normal write" }],
    });
    expect((await f.action(next.batchId, "apply")).result.status).toBe(
      "completed",
    );
  } finally {
    await f.close();
  }
});
