import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import type { ChapterFile } from "../src/main/libraryStore/libraryFiles";
import { workflowFixture } from "./mcpWorkflow.fixture";
import { McpWorkflowRecordSchema } from "../src/main/application/mcpWorkflowPolicy";
import { createPageRevision } from "../src/shared/pageRevision";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

async function duringSourceRead(
  f: Awaited<ReturnType<typeof workflowFixture>>,
  mutate: (chapter: ChapterFile) => void,
  inspect: () => Promise<unknown>,
) {
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  const source = (await f.library.openChapter("chapter")).pages[0].imagePath;
  let changed = false;
  vi.mocked(readFile).mockImplementation(async (...args) => {
    const bytes = await actual.readFile(...args);
    if (!changed && String(args[0]) === source) {
      changed = true;
      const chapter = JSON.parse(
        await actual.readFile(f.chapterPath, "utf8"),
      ) as ChapterFile;
      mutate(chapter);
      await actual.writeFile(f.chapterPath, JSON.stringify(chapter));
    }
    return bytes;
  });
  try {
    await inspect();
    expect(changed).toBe(true);
  } finally {
    vi.mocked(readFile).mockImplementation(actual.readFile);
  }
}

it("rechecks selected page revisions after hashing instead of returning a mixed-time snapshot", async () => {
  const f = await workflowFixture();
  const { verifyWorkflowPages } =
    await import("../src/main/mcp/mcpWorkflowEvidence");
  try {
    const plan = await f.prepare([{ kind: "export-png" }]);
    const record = McpWorkflowRecordSchema.parse(
      await f.storage.record(plan.id),
    );
    await duringSourceRead(
      f,
      (chapter) => {
        chapter.pages[0].blocks[0].translatedText =
          "concurrent native page edit";
      },
      async () => {
        await expect(verifyWorkflowPages(record, () => {})).rejects.toThrow(
          "changed while source evidence",
        );
      },
    );
    expect(f.request).not.toHaveBeenCalled();
    expect(f.render).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it("does not publish a prepared plan when chapter order changes while hashing its sources", async () => {
  const f = await workflowFixture();
  try {
    await duringSourceRead(
      f,
      (chapter) => {
        chapter.pageOrder = [...chapter.pageOrder].reverse();
      },
      async () => {
        await expect(f.prepare([{ kind: "export-png" }])).rejects.toThrow(
          "changed while source evidence",
        );
      },
    );
    expect((await f.storage.index()).entries).toEqual([]);
  } finally {
    await f.close();
  }
});

it("does not broaden selected-page conflict checks to an unrelated page", async () => {
  const f = await workflowFixture();
  const { verifyWorkflowPages } =
    await import("../src/main/mcp/mcpWorkflowEvidence");
  try {
    const chapter = JSON.parse(
      await readFile(f.chapterPath, "utf8"),
    ) as ChapterFile;
    chapter.pages.push({
      ...structuredClone(chapter.pages[0]),
      id: randomUUID(),
    });
    await writeFile(f.chapterPath, JSON.stringify(chapter));
    const prepared = await f.prepare([{ kind: "export-png" }], {
      chapters: [
        {
          chapterId: "chapter",
          pages: chapter.pages.slice(0, 2).map((page) => ({
            pageId: page.id,
            revision: createPageRevision(page),
          })),
        },
      ],
    });
    const record = McpWorkflowRecordSchema.parse(
      await f.storage.record(prepared.id),
    );
    await duringSourceRead(
      f,
      (value) => {
        value.pages[2].blocks[0].translatedText = "unselected page edit";
      },
      async () => {
        expect(await verifyWorkflowPages(record, () => {})).toBeUndefined();
      },
    );
  } finally {
    await f.close();
  }
});
