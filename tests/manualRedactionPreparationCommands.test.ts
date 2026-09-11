import { beforeAll, expect, it, vi } from "vitest";
import type { ChapterSnapshot } from "../src/shared/libraryTypes";
import { appI18n, initializeAppI18n } from "../src/renderer/src/appI18n";
import {
  buildRedactionPreparationCommands,
  redactionPreparationTarget,
} from "../src/renderer/src/lib/redactionPreparation";

beforeAll(() => initializeAppI18n("ko"));
function chapter(): ChapterSnapshot {
  return {
    id: "chapter",
    workId: "work",
    title: "Chapter",
    sourceKind: "images",
    status: "idle",
    pageOrder: ["a"],
    createdAt: "",
    updatedAt: "",
    pages: [
      {
        id: "a",
        name: "a.png",
        imagePath: "a.png",
        dataUrl: "",
        width: 100,
        height: 100,
        blocks: [],
        analysisStatus: "idle",
        createdAt: "",
        updatedAt: "",
      },
    ],
  };
}
it("uses explicit existing page, chapter and work scopes without creating a job", () => {
  const open = vi.fn();
  const commands = buildRedactionPreparationCommands(
    chapter(),
    false,
    { currentPageId: "a", open },
    appI18n.getFixedT("ko", "components"),
  );
  for (const command of Object.values(commands)) {
    expect(command.paletteVisible).toBe(true);
    command.run();
  }
  expect(open.mock.calls.map(([request]) => request)).toEqual([
    { kind: "chapter", chapterId: "chapter", pageIds: ["a"] },
    { kind: "chapter", chapterId: "chapter" },
    { kind: "work", workId: "work" },
  ]);
  expect(commands["prepare-redaction-page"].label).toBe("이 페이지 가리기");
});
it("rejects stale page selections and does not require the current chapter to populate the work scope", () => {
  expect(redactionPreparationTarget("page", chapter(), "foreign")).toBeNull();
  expect(redactionPreparationTarget("page", chapter(), null)).toBeNull();
  expect(redactionPreparationTarget("work", null, "a")).toBeNull();
  const empty = { ...chapter(), pages: [] };
  expect(redactionPreparationTarget("chapter", empty, null)).toBeNull();
  expect(redactionPreparationTarget("work", empty, null)).toEqual({
    kind: "work",
    workId: "work",
  });
});
it("blocks both palette and direct commands while busy or without a launcher", () => {
  const open = vi.fn();
  const t = appI18n.getFixedT("ko", "components");
  const busy = buildRedactionPreparationCommands(
    chapter(),
    true,
    { currentPageId: "a", open },
    t,
  );
  const absent = buildRedactionPreparationCommands(
    chapter(),
    false,
    undefined,
    t,
  );
  for (const command of [...Object.values(busy), ...Object.values(absent)]) {
    expect(command.paletteVisible).toBe(false);
    expect(() => command.run()).not.toThrow();
  }
  expect(open).not.toHaveBeenCalled();
});
