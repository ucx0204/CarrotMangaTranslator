import { expect, it } from "vitest";
import {
  DEFAULT_REDACTION_PREFERENCES,
  DEFAULT_REDACTION_VIEW,
} from "../src/shared/imageRedactionWorkspace";
import { createRedactionSession } from "../src/renderer/src/components/imageRedaction/redactionSession";
import { changeRedactionStrokes } from "../src/renderer/src/components/imageRedaction/redactionWorkspaceModel";

function reviewedPage() {
  return createRedactionSession({
    sessionId: "11111111-1111-4111-8111-111111111111",
    revision: 0,
    pages: [
      {
        id: "a",
        name: "a",
        imagePath: "a.png",
        width: 20,
        height: 20,
        fingerprint: "a".repeat(64),
        decision: "reviewed",
        strokes: [
          {
            shape: "rectangle",
            size: 1,
            points: [
              { x: 1, y: 1 },
              { x: 8, y: 8 },
            ],
          },
        ],
      },
    ],
    view: { ...DEFAULT_REDACTION_VIEW, currentId: "a" },
    preferences: DEFAULT_REDACTION_PREFERENCES,
    presets: [],
  });
}

it("treats an unchanged selection or transform as no edit, history entry or save", () => {
  const state = reviewedPage();
  expect(changeRedactionStrokes(state, "a", state.documents.a.strokes)).toBe(
    state,
  );
  expect(
    changeRedactionStrokes(
      state,
      "a",
      structuredClone(state.documents.a.strokes),
    ),
  ).toBe(state);
  expect(state.documents.a.decision).toBe("reviewed");
  expect(state.undo).toHaveLength(0);
  expect(state.generation).toBe(0);
});

it("still invalidates review for actual geometry and erase-operation changes", () => {
  const state = reviewedPage();
  const moved = structuredClone(state.documents.a.strokes);
  moved[0].points[0].x++;
  const changed = changeRedactionStrokes(state, "a", moved);
  expect(changed.documents.a.decision).toBe("unreviewed");
  expect(changed.undo).toHaveLength(1);
  expect(
    changeRedactionStrokes(state, "a", [
      { ...state.documents.a.strokes[0], operation: "restore" },
    ]).documents.a.decision,
  ).toBe("unreviewed");
  expect(() => changeRedactionStrokes(state, "foreign", [])).toThrow();
});
