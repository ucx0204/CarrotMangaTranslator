import { randomUUID } from "node:crypto";
import type { McpStructurePreview } from "../src/shared/mcpBlockStructure";
import { createPageRevision } from "../src/shared/pageRevision";
import { McpStructureService } from "../src/main/application/mcpStructureService";
import { editingFixture } from "./mcpEditing.fixture";

export function structureFixture() {
  const f = editingFixture();
  for (const block of f.chapter.pages[0].blocks)
    delete block.generatedLettering;
  let now = 1000;
  const service = new McpStructureService(f.service, () => now);
  const request: McpStructurePreview = {
    chapterId: "chapter",
    pageId: "page",
    revision: createPageRevision(f.chapter.pages[0]),
    requestId: randomUUID(),
    reason: "AI inferred the unwanted text object from the page",
    operation: { kind: "delete", blockId: "a" },
  };
  return {
    ...f,
    request,
    structure: service,
    owner: "test-owner",
    guard: () => {},
    tick: (ms: number) => {
      now += ms;
    },
    part: {
      sourceText: "source",
      translatedText: "original-a",
      sourceRect: { x: 10, y: 20, w: 90, h: 120 },
      renderRect: { x: 15, y: 25, w: 80, h: 110 },
    },
  };
}
