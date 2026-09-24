import { vi } from "vitest";
import { editingChapter } from "./mcpEditing.fixture";
import { McpContextReferenceService } from "../src/main/application/mcpContextReferenceService";
import { McpContextMigrationPreviewService } from "../src/main/application/mcpContextMigrationPreviewService";
import { McpContextMigrationPreviewSchema } from "../src/shared/mcpContextMigration";
import {
  McpContextReferencesSchema,
  type McpContextReferenceSnapshot,
} from "../src/shared/mcpContextReferences";
import type {
  CharacterProfile,
  GlossaryEntry,
} from "../src/shared/workContextTypes";

export function migrationFixture() {
  const glossary: GlossaryEntry[] = ["old", "keep", "manual", "__proto__"].map(
    (id) => ({
      id,
      source: id,
      target: `target ${id}`,
      category: "term",
      enabled: true,
      origin: id === "manual" ? "manual" : "ai",
      createdAt: "initial",
      updatedAt: "initial",
    }),
  );
  const characters: CharacterProfile[] = [
    "old-character",
    "keep-character",
  ].map((id) => ({
    id,
    displayName: id,
    sourceNames: [id],
    targetName: id,
    speechStyle: "neutral",
    origin: "ai",
    enabled: true,
    createdAt: "initial",
    updatedAt: "initial",
  }));
  const first = editingChapter();
  const second = { ...structuredClone(first), id: "chapter-two" };
  for (const chapter of [first, second]) {
    chapter.pages[0].blocks[0].speakerId = "old-character";
    chapter.pages[0].blocks[0].glossaryEntryIds = [
      "old",
      "keep",
      "old",
      "__proto__",
    ];
  }
  const graph: McpContextReferenceSnapshot = {
    workId: "work",
    workTitle: "PRIVATE title",
    styleGuide: {
      schemaVersion: 1,
      workId: "work",
      glossary,
      characters,
      rules: {
        honorifics: "adapt",
        sfxMode: "translate",
        defaultTone: "natural_korean",
      },
      createdAt: "initial",
      updatedAt: "initial",
    },
    chapters: [first, second].map((chapter) => ({
      chapter,
      storyMemory: {
        schemaVersion: 1,
        workId: "work",
        chapterId: chapter.id,
        updatedAt: "initial",
        pages: ["page", "orphan"].map((pageId, pageIndex) => ({
          pageId,
          pageIndex,
          pageName: "PRIVATE name",
          summary: "PRIVATE story",
          sourceDigest: "PRIVATE source",
          translatedDigest: "PRIVATE target",
          characterIds: ["old-character"],
          glossaryEntryIds: ["old"],
          updatedAt: "initial",
        })),
      },
    })),
  };
  const read = vi.fn(async () => graph);
  const references = new McpContextReferenceService(read);
  const service = new McpContextMigrationPreviewService(read);
  const input = async (
    command: unknown,
    extra: Record<string, unknown> = {},
  ) => {
    const reference = await references.inspect(
      McpContextReferencesSchema.parse({ chapterId: "chapter" }),
      () => {},
    );
    return McpContextMigrationPreviewSchema.parse({
      chapterId: "chapter",
      referenceSnapshot: reference.snapshot,
      command,
      ...extra,
    });
  };
  return { graph, read, references, service, input };
}
