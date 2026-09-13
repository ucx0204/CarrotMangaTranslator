import { expect, it } from "vitest";
import {
  DEFAULT_REDACTION_PREFERENCES,
  DEFAULT_REDACTION_VIEW,
} from "../src/shared/imageRedactionWorkspace";
import {
  createRedactionSession,
  editRedactionDocuments,
} from "../src/renderer/src/components/imageRedaction/redactionSession";
import { summarizeRedactionWorkspace } from "../src/renderer/src/components/imageRedaction/redactionWorkspacePresentation";

it("describes current review and mask state rather than the opening snapshot", () => {
  const initial = createRedactionSession({
    sessionId: "11111111-1111-4111-8111-111111111111",
    revision: 0,
    pages: ["a", "b"].map((id) => ({
      id,
      name: id,
      imagePath: `${id}.png`,
      width: 20,
      height: 20,
      fingerprint: "a".repeat(64),
      strokes: [],
      decision: "unreviewed",
    })),
    view: { ...DEFAULT_REDACTION_VIEW, currentId: "b" },
    preferences: DEFAULT_REDACTION_PREFERENCES,
    presets: [],
  });
  const edited = editRedactionDocuments(initial, [
    {
      ...initial.documents.a,
      decision: "reviewed",
      strokes: [{ shape: "round", size: 4, points: [{ x: 5, y: 5 }] }],
    },
  ]);
  expect(summarizeRedactionWorkspace(initial)).toEqual({
    reviewed: 0,
    unreviewed: 2,
    total: 2,
    hasPreviousMask: false,
  });
  expect(summarizeRedactionWorkspace(edited)).toEqual({
    reviewed: 1,
    unreviewed: 1,
    total: 2,
    hasPreviousMask: true,
  });
  const removed = editRedactionDocuments(edited, [
    { ...edited.documents.a, strokes: [] },
  ]);
  expect(summarizeRedactionWorkspace(removed).hasPreviousMask).toBe(false);
  expect(
    summarizeRedactionWorkspace({
      ...edited,
      workspace: {
        ...edited.workspace,
        view: { ...edited.workspace.view, currentId: "a" },
      },
    }).hasPreviousMask,
  ).toBe(false);
});
