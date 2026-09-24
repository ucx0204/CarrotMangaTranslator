import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { chapterMoveFixture } from "./mcpChapterMove.fixture";
import { migrationFixture } from "./mcpContextMigration.fixture";
import { planChapterMoveReferences } from "../src/main/application/mcpChapterMoveReferences";

it("distinguishes missing, semantically different and unused mappings without changing input catalogs", () => {
  const { graph } = migrationFixture();
  const source = graph.styleGuide;
  const target = structuredClone(source);
  target.workId = "destination";
  target.glossary[0].target = "Different destination meaning";
  target.characters = [];
  const { chapter, storyMemory } = graph.chapters[0];
  const before = structuredClone(graph);
  const plan = planChapterMoveReferences(chapter, storyMemory, source, target, [
    { kind: "glossary", sourceId: "unused", targetId: "keep" },
  ]);
  expect(plan.issues).toEqual(
    expect.arrayContaining([
      { kind: "glossary", sourceId: "old", reason: "different-definition" },
      {
        kind: "character",
        sourceId: "old-character",
        reason: "missing-target",
      },
      { kind: "glossary", sourceId: "unused", reason: "unused-mapping" },
    ]),
  );
  expect(graph).toEqual(before);
  const identical = structuredClone(source);
  identical.workId = "destination";
  for (const item of [...identical.glossary, ...identical.characters])
    item.updatedAt = "newer-copy";
  expect(
    planChapterMoveReferences(chapter, storyMemory, source, identical, [])
      .issues,
  ).toEqual([]);
  identical.characters.push(identical.characters[0]);
  expect(() =>
    planChapterMoveReferences(chapter, storyMemory, source, identical, []),
  ).toThrow(/duplicate/);
});

it("moves reviewed block and orphan-memory references, keeps both catalogs intact and restores original bytes", async () => {
  const f = await chapterMoveFixture();
  try {
    const { graph } = migrationFixture();
    const source = graph.styleGuide;
    const destination = structuredClone(source);
    destination.workId = "destination";
    destination.glossary = [
      { ...source.glossary[0], id: "new-term", target: "Destination term" },
    ];
    destination.characters = [
      {
        ...source.characters[0],
        id: "new-character",
        targetName: "Destination character",
      },
    ];
    const sourcePath = join(
      f.env.libraryDir,
      "works",
      "work",
      "style-guide.json",
    );
    const destinationPath = join(f.destinationRoot, "style-guide.json");
    await writeFile(sourcePath, JSON.stringify(source));
    await writeFile(destinationPath, JSON.stringify(destination));
    const chapter = JSON.parse(await readFile(f.chapterPath, "utf8"));
    chapter.pages[0].blocks[0].speakerId = "old-character";
    chapter.pages[0].blocks[0].glossaryEntryIds = ["old"];
    const chapterBytes = JSON.stringify(chapter);
    await writeFile(f.chapterPath, chapterBytes);
    const memory = structuredClone(graph.chapters[0].storyMemory);
    const memoryPath = join(f.directory, "story-memory.json");
    const memoryBytes = JSON.stringify(memory);
    await writeFile(memoryPath, memoryBytes);
    const initial = await f.previewMove();
    expect(initial.eligible).toBe(false);
    await expect(f.applyMove(await f.commandMove())).rejects.toMatchObject({
      code: "invalid_edit",
    });
    const intent = {
      ...f.intent,
      references: [
        { kind: "glossary" as const, sourceId: "old", targetId: "new-term" },
        {
          kind: "character" as const,
          sourceId: "old-character",
          targetId: "new-character",
        },
      ],
    };
    expect(await f.previewMove(intent)).toMatchObject({
      eligible: true,
      mappedReferences: 6,
      referenceIssues: [],
    });
    const input = await f.commandMove(intent);
    const saved = await f.applyMove(input);
    const moved = await f.library.openChapter("chapter");
    expect(moved.pages[0].blocks[0]).toMatchObject({
      speakerId: "new-character",
      glossaryEntryIds: ["new-term"],
    });
    const movedMemory = JSON.parse(
      await readFile(
        join(f.destinationRoot, "chapters", "chapter", "story-memory.json"),
        "utf8",
      ),
    );
    expect(movedMemory.pages).toHaveLength(memory.pages.length);
    expect(movedMemory.pages[1]).toMatchObject({
      pageId: "orphan",
      characterIds: ["new-character"],
      glossaryEntryIds: ["new-term"],
      summary: "PRIVATE story",
    });
    await f.restart();
    await f.recoverMove(saved.id, "undo");
    expect(await readFile(f.chapterPath, "utf8")).toBe(chapterBytes);
    expect(await readFile(memoryPath, "utf8")).toBe(memoryBytes);
    expect(JSON.parse(await readFile(sourcePath, "utf8"))).toEqual(source);
    expect(JSON.parse(await readFile(destinationPath, "utf8"))).toEqual(
      destination,
    );
    expect(JSON.stringify(initial)).not.toMatch(
      /PRIVATE story|Destination term/,
    );
  } finally {
    await f.close();
  }
});
