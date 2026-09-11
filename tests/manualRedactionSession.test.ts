import { describe, expect, it } from "vitest";
import {
  DEFAULT_REDACTION_PREFERENCES,
  DEFAULT_REDACTION_VIEW,
  type RedactionWorkspace,
} from "../src/shared/imageRedactionWorkspace";
import {
  createRedactionSession,
  editRedactionDocuments,
  restoreRedactionEdit,
  canRestoreRedactionEdit,
  nextUnreviewedPage,
  redactionProgress,
  selectRedactionRange,
} from "../src/renderer/src/components/imageRedaction/redactionSession";

import {
  changeRedactionPreferences,
  changeRedactionView,
  decideAndAdvanceRedaction,
  filteredRedactionPages,
} from "../src/renderer/src/components/imageRedaction/redactionWorkspaceModel";

function fixture(count = 3) {
  const workspace: RedactionWorkspace = {
    sessionId: "11111111-1111-4111-8111-111111111111",
    revision: 0,
    pages: Array.from({ length: count }, (_, index) => ({
      id: String(index),
      name: String(index),
      imagePath: `page-${index}.png`,
      width: 100,
      height: 100,
      fingerprint: "a".repeat(64),
      strokes: [],
      decision: "unreviewed",
    })),
    view: DEFAULT_REDACTION_VIEW,
    preferences: DEFAULT_REDACTION_PREFERENCES,
    presets: [],
  };
  return createRedactionSession(workspace);
}

describe("manual redaction session", () => {
  it("requires an explicit decision and does not infer review from an empty mask", () => {
    const state = fixture(100);
    expect(redactionProgress(state.documents)).toEqual({
      reviewed: 0,
      unreviewed: 100,
    });
    const next = editRedactionDocuments(state, [
      { ...state.documents["0"], decision: "reviewed" },
    ]);
    expect(nextUnreviewedPage(next, "0")).toBe("1");
    expect(redactionProgress(next.documents).reviewed).toBe(1);
  });
  it("keeps per-page undo and redo independent across navigation", () => {
    let state = fixture();
    state = editRedactionDocuments(state, [
      { ...state.documents["0"], decision: "reviewed" },
    ]);
    state = editRedactionDocuments(state, [
      { ...state.documents["1"], decision: "reviewed" },
    ]);
    state = restoreRedactionEdit(state, "undo", "0");
    expect(state.documents["0"].decision).toBe("unreviewed");
    expect(state.documents["1"].decision).toBe("reviewed");
    state = restoreRedactionEdit(state, "redo", "0");
    expect(state.documents["0"].decision).toBe("reviewed");
  });
  it("undoes a batch atomically without overwriting later edits", () => {
    let state = fixture();
    state = editRedactionDocuments(
      state,
      Object.values(state.documents).map((document) => ({
        ...document,
        decision: "reviewed",
      })),
      true,
    );
    state = editRedactionDocuments(state, [
      { ...state.documents["1"], decision: "unreviewed" },
    ]);
    expect(canRestoreRedactionEdit(state, "undo", "0", true)).toBe(false);
    state = restoreRedactionEdit(state, "undo", "1");
    state = restoreRedactionEdit(state, "undo", "0", true);
    expect(redactionProgress(state.documents).unreviewed).toBe(3);
    state = restoreRedactionEdit(state, "redo", "0", true);
    expect(redactionProgress(state.documents).reviewed).toBe(3);
  });
  it("does not wrap confirmation into a send action on the last page", () => {
    let state = fixture(1);
    state = editRedactionDocuments(state, [
      { ...state.documents["0"], decision: "reviewed" },
    ]);
    expect(nextUnreviewedPage(state, "0")).toBeUndefined();
    expect(redactionProgress(state.documents).reviewed).toBe(1);
  });
  it("rejects foreign and changed page revisions", () => {
    const state = fixture();
    expect(() =>
      editRedactionDocuments(state, [
        { ...state.documents["0"], id: "foreign" },
      ]),
    ).toThrow();
    expect(() =>
      editRedactionDocuments(state, [
        { ...state.documents["0"], fingerprint: "b".repeat(64) },
      ]),
    ).toThrow();
  });
  it("ignores unchanged decisions", () => {
    const state = fixture();
    expect(editRedactionDocuments(state, [state.documents["0"]])).toBe(state);
  });
  it("uses visible order for range selection and preserves explicit selections", () => {
    expect(
      selectRedactionRange(["a", "c", "e"], ["b"], "e", "a", true, false),
    ).toEqual(["b", "a", "c", "e"]);
    expect(
      selectRedactionRange(["a", "b"], ["a"], "a", "a", false, true),
    ).toEqual([]);
    expect(
      selectRedactionRange(["a", "b"], ["a"], "a", "b", false, true),
    ).toEqual(["a", "b"]);
  });
});

it("restores a legacy overview draft in continuous editing without changing its masks or reviews", () => {
  const initial = fixture(4);
  const workspace = {
    ...initial.workspace,
    view: {
      ...initial.workspace.view,
      mode: "grid" as const,
      currentId: "2",
      selectedIds: ["1", "2"],
      gridOffset: 200,
    },
  };
  const next = createRedactionSession(workspace);
  expect(next.workspace.view).toEqual({ ...workspace.view, mode: "edit" });
  expect(next.documents).toEqual(initial.documents);
  expect(workspace.view.mode).toBe("grid");
});

it("preserves a page's redo when a different page is edited", () => {
  let state = fixture();
  state = editRedactionDocuments(state, [
    { ...state.documents["0"], decision: "reviewed" },
  ]);
  state = restoreRedactionEdit(state, "undo", "0");
  state = editRedactionDocuments(state, [
    { ...state.documents["1"], decision: "reviewed" },
  ]);
  expect(canRestoreRedactionEdit(state, "redo", "0")).toBe(true);
  state = restoreRedactionEdit(state, "redo", "0");
  expect(state.documents["0"].decision).toBe("reviewed");
  expect(state.documents["1"].decision).toBe("reviewed");
});

it("invalidates the whole overlapping batch redo but preserves unrelated history", () => {
  let state = fixture();
  state = editRedactionDocuments(
    state,
    ["0", "1"].map((id) => ({
      ...state.documents[id],
      decision: "reviewed" as const,
    })),
    true,
  );
  state = restoreRedactionEdit(state, "undo", "0", true);
  state = editRedactionDocuments(state, [
    { ...state.documents["2"], decision: "reviewed" },
  ]);
  expect(canRestoreRedactionEdit(state, "redo", "0", true)).toBe(true);
  state = editRedactionDocuments(state, [
    { ...state.documents["1"], decision: "reviewed" },
  ]);
  expect(canRestoreRedactionEdit(state, "redo", "0", true)).toBe(false);
  expect(state.documents["0"].decision).toBe("unreviewed");
});

// Exercise state transitions directly rather than driving a DOM/key/viewport matrix.
it("keeps preferences when confirming and advancing to the next unreviewed page", () => {
  let state = changeRedactionView(fixture(2), { currentId: "0" });
  state = changeRedactionPreferences(state, { tool: "brush" });
  state = decideAndAdvanceRedaction(state, "reviewed");
  expect(state.workspace.view.currentId).toBe("1");
  expect(state.workspace.preferences.tool).toBe("brush");
  expect(
    filteredRedactionPages(
      state.workspace.pages,
      state.documents,
      "unreviewed",
      new Set(),
    ),
  ).toEqual(["1"]);
  state = decideAndAdvanceRedaction(state, "reviewed");
  expect(state.workspace.view.currentId).toBe("1");
  expect(redactionProgress(state.documents)).toEqual({
    reviewed: 2,
    unreviewed: 0,
  });
});
