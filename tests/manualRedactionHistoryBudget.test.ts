import { expect, it } from "vitest";
import {
  DEFAULT_REDACTION_PREFERENCES,
  DEFAULT_REDACTION_VIEW,
} from "../src/shared/imageRedactionWorkspace";
import {
  canRestoreRedactionEdit,
  createRedactionSession,
  editRedactionDocuments,
  restoreRedactionEdit,
} from "../src/renderer/src/components/imageRedaction/redactionSession";
import {
  createRedactionEdit,
  retainRedactionHistory,
} from "../src/renderer/src/components/imageRedaction/redactionHistory";

function fixture(count: number) {
  return createRedactionSession({
    sessionId: "11111111-1111-4111-8111-111111111111",
    revision: 0,
    pages: Array.from({ length: count }, (_, index) => ({
      id: String(index),
      name: String(index),
      imagePath: `${index}.png`,
      width: 20,
      height: 20,
      fingerprint: "a".repeat(64),
      strokes: [],
      decision: "unreviewed",
    })),
    view: DEFAULT_REDACTION_VIEW,
    preferences: DEFAULT_REDACTION_PREFERENCES,
    presets: [],
  });
}
it("keeps the first page reversible after editing more than 100 other pages", () => {
  let state = fixture(201);
  for (const id of Object.keys(state.documents))
    state = editRedactionDocuments(state, [
      { ...state.documents[id], decision: "reviewed" },
    ]);
  expect(state.undo).toHaveLength(201);
  expect(canRestoreRedactionEdit(state, "undo", "0")).toBe(true);
  state = restoreRedactionEdit(state, "undo", "0");
  expect(state.documents["0"].decision).toBe("unreviewed");
  expect(state.documents["200"].decision).toBe("reviewed");
  expect(canRestoreRedactionEdit(state, "redo", "0")).toBe(true);
});
it("limits one page's history without consuming another page's undo", () => {
  let state = fixture(2);
  state = editRedactionDocuments(state, [
    { ...state.documents["0"], decision: "reviewed" },
  ]);
  for (let index = 0; index < 150; index++)
    state = editRedactionDocuments(state, [
      {
        ...state.documents["1"],
        decision: index % 2 ? "unreviewed" : "reviewed",
      },
    ]);
  expect(state.undo.filter((edit) => edit.after["1"])).toHaveLength(100);
  expect(canRestoreRedactionEdit(state, "undo", "0")).toBe(true);
});
it("bounds estimated payload and never splits an atomic batch to fit it", () => {
  const state = fixture(2);
  const edit = createRedactionEdit(state.documents, state.documents, true);
  const large = { ...edit, estimatedBytes: 20 * 1024 * 1024 };
  expect(retainRedactionHistory([large, large])).toEqual([large]);
  expect(
    retainRedactionHistory([{ ...large, estimatedBytes: 40 * 1024 * 1024 }]),
  ).toEqual([]);
  expect(
    createRedactionEdit(state.documents, state.documents, false).batch,
  ).toBe(true);
});
