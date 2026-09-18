import { readFile, writeFile } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { letteringAppFixture } from "./mcpLetteringApp.fixture";

const styles = [
  { kind: "format", fields: { italic: true } },
  {
    kind: "rule",
    schemeJson: JSON.stringify({
      name: "Italic",
      match: { mode: "allBlocks" },
      actions: [
        {
          id: "italic",
          enabled: true,
          type: "setFields",
          changes: [{ field: "italic", operation: "set", value: true }],
        },
      ],
    }),
  },
];
it.each(styles)(
  "refuses stale non-current pages before a $kind batch makes any save",
  async (command) => {
    const f = await letteringAppFixture();
    try {
      const result = await f.prepare(command);
      expect(result.job.status).toBe("completed");
      if (!result.batchId) throw new Error("Missing prepared plan");
      const edited = JSON.parse(await readFile(f.chapterPath, "utf8"));
      edited.pages[1].blocks[0].translatedText = "Later manual edit";
      await writeFile(f.chapterPath, JSON.stringify(edited));
      const before = await readFile(f.chapterPath);
      expect((await f.action(result.batchId, "apply")).status).toBe("failed");
      expect(await readFile(f.chapterPath)).toEqual(before);
      expect(f.notifySaved).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  },
);

it("checks all wrap dependencies even though wrapping requires neither files nor models", async () => {
  const f = await letteringAppFixture();
  try {
    const { captureMcpLetteringBinding } =
      await import("../src/main/mcp/mcpLetteringEvidence");
    const request = await f.request({ kind: "layout", mode: "wrap" });
    const saved = await f.library.readWorkContextForEdit("chapter");
    saved.chapter.pages[1].blocks[0].translatedText = "Changed dependency";
    await expect(
      captureMcpLetteringBinding(saved, request, () => {}),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    expect(f.runPage).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it("keeps the acknowledged first save and permits its undo when another selected page changes", async () => {
  const f = await letteringAppFixture();
  const before = await f.library.openChapter("chapter");
  f.notifySaved.mockImplementationOnce(() => {
    const edited = JSON.parse(readFileSync(f.chapterPath, "utf8"));
    edited.pages[1].blocks[0].translatedText = "Independent user edit";
    writeFileSync(f.chapterPath, JSON.stringify(edited));
  });
  try {
    const result = await f.prepare(styles[0]);
    if (!result.batchId) throw new Error("Missing prepared plan");
    const applied = await f.action(result.batchId, "apply");
    expect(applied.status).toBe("partial");
    expect(
      (await f.library.openChapter("chapter")).pages[0].blocks[0].italic,
    ).toBe(true);
    expect((await f.action(result.batchId, "undo")).status).toBe("completed");
    const undone = await f.library.openChapter("chapter");
    expect(undone.pages[0].blocks).toEqual(before.pages[0].blocks);
    expect(undone.pages[1].blocks[0].translatedText).toBe(
      "Independent user edit",
    );
  } finally {
    await f.close();
  }
});
