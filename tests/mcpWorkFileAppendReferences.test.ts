import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import type { LibraryChapter } from "../src/shared/libraryTypes";
import { McpWorkFileCreateSchema } from "../src/shared/mcpWorkFileImport";
import { workFileAppendFixture } from "./mcpWorkFileAppend.fixture";
import { migrationFixture } from "./mcpContextMigration.fixture";

const Zip = createRequire(import.meta.url)("adm-zip") as new (
  bytes: Buffer,
) => {
  readAsText: (path: string) => string;
  getEntries: () => Array<{ entryName: string; getData: () => Buffer }>;
  addFile: (path: string, bytes: Buffer) => void;
  updateFile: (path: string, bytes: Buffer) => void;
  toBuffer: () => Buffer;
};

async function referencedInput(
  f: Awaited<ReturnType<typeof workFileAppendFixture>>,
  multi = false,
) {
  const guide = migrationFixture().graph.styleGuide;
  const zip = new Zip(f.packageBytes);
  const path = "chapters/chapter/chapter.json";
  const chapter: LibraryChapter = JSON.parse(zip.readAsText(path));
  chapter.pages[0].blocks[0].speakerId = guide.characters[0].id;
  chapter.pages[0].blocks[0].glossaryEntryIds = [guide.glossary[0].id];
  zip.updateFile(path, Buffer.from(JSON.stringify(chapter)));
  zip.updateFile("style-guide.json", Buffer.from(JSON.stringify(guide)));
  if (multi) addUnreferencedChapter(zip, chapter);
  const uploaded = await f.upload(zip.toBuffer());
  const source = await f.review(uploaded.uploadId);
  return {
    guide,
    input: {
      uploadId: source.uploadId,
      snapshot: source.snapshot,
      chapters: source.chapters.map((item) => ({
        packageChapterId: item.packageChapterId,
        title: item.title,
      })),
      target: {
        workId: "work",
        contextPolicy: "preserve-destination" as const,
      },
    },
  };
}
function addUnreferencedChapter(
  zip: InstanceType<typeof Zip>,
  chapter: LibraryChapter,
) {
  const other = structuredClone(chapter);
  other.id = "other";
  for (const page of other.pages) {
    page.imagePath = page.imagePath.replace(
      "chapters/chapter/",
      "chapters/other/",
    );
    page.inpaintedImagePath = page.inpaintedImagePath?.replace(
      "chapters/chapter/",
      "chapters/other/",
    );
    for (const block of page.blocks) {
      delete block.speakerId;
      delete block.glossaryEntryIds;
    }
  }
  for (const entry of zip.getEntries())
    if (
      entry.entryName.startsWith("chapters/chapter/") &&
      !entry.entryName.endsWith("chapter.json")
    )
      zip.addFile(
        entry.entryName.replace("chapters/chapter/", "chapters/other/"),
        entry.getData(),
      );
  zip.addFile(
    "chapters/other/chapter.json",
    Buffer.from(JSON.stringify(other)),
  );
  const manifest = JSON.parse(zip.readAsText("manifest.json"));
  manifest.chapterOrder.push("other");
  zip.updateFile("manifest.json", Buffer.from(JSON.stringify(manifest)));
}

it.each([false, true])(
  "maps only incoming references without merging catalogs (multiple chapters=%s)",
  async (multi) => {
    const f = await workFileAppendFixture();
    try {
      const { guide, input } = await referencedInput(f, multi);
      await writeFile(f.guidePath, JSON.stringify(guide));
      expect((await f.inspectAppend(input)).eligible).toBe(true);
      const destination = {
        ...guide,
        glossary: [
          {
            ...guide.glossary[0],
            id: "destination-term",
            target: "Explicit new meaning",
          },
        ],
        characters: [
          {
            ...guide.characters[0],
            id: "destination-character",
            targetName: "Target name",
          },
        ],
      };
      await writeFile(f.guidePath, JSON.stringify(destination));
      const unresolved = await f.inspectAppend(input);
      expect(unresolved.eligible).toBe(false);
      expect(unresolved.referenceIssues).toHaveLength(2);
      const mapped = {
        ...input,
        target: {
          ...input.target,
          references: [
            {
              kind: "glossary" as const,
              sourceId: guide.glossary[0].id,
              targetId: "destination-term",
            },
            {
              kind: "character" as const,
              sourceId: guide.characters[0].id,
              targetId: "destination-character",
            },
          ],
        },
      };
      const review = await f.inspectAppend(mapped);
      expect(review).toMatchObject({
        eligible: true,
        referenceIssues: [],
        mappedReferences: 2,
      });
      const before = await f.capture();
      const receipt = await f.createWorkFile(
        McpWorkFileCreateSchema.parse({
          ...mapped,
          target: review.target,
          requestId: randomUUID(),
          allowNativePreparation: true,
          acknowledgeV1Limitations: true,
        }),
      );
      expect(receipt.chapterIds).toHaveLength(multi ? 2 : 1);
      const added = await f.library.openChapter(receipt.chapterIds[0]);
      expect(added.pages[0].blocks[0]).toMatchObject({
        speakerId: "destination-character",
        glossaryEntryIds: ["destination-term"],
      });
      expect(await readFile(f.guidePath)).toEqual(before.guide);
      expect(await readFile(f.chapterPath)).toEqual(before.chapter);
    } finally {
      await f.close();
    }
  },
);

it("rejects duplicate mappings and reports unused mappings rather than silently accepting them", async () => {
  const f = await workFileAppendFixture();
  try {
    const { input } = await f.prepareAppend();
    const mapping = {
      kind: "character" as const,
      sourceId: "unused",
      targetId: "unused-target",
    };
    const review = await f.inspectAppend({
      ...input,
      target: { ...input.target, references: [mapping] },
    });
    expect(review).toMatchObject({
      eligible: false,
      referenceIssues: [
        { kind: "character", sourceId: "unused", reason: "unused-mapping" },
      ],
    });
    await expect(
      f.inspectAppend({
        ...input,
        target: { ...input.target, references: [mapping, mapping] },
      }),
    ).rejects.toThrow();
    expect(f.validateShare).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});
