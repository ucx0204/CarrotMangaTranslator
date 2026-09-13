import { expect, it } from "vitest";
import {
  DEFAULT_REDACTION_PREFERENCES,
  DEFAULT_REDACTION_VIEW,
} from "../src/shared/imageRedactionWorkspace";
import { runRedactionCommand } from "../src/renderer/src/components/imageRedaction/redactionCommand";
import { createRedactionSession } from "../src/renderer/src/components/imageRedaction/redactionSession";
import { decideRedactionPages } from "../src/renderer/src/components/imageRedaction/redactionWorkspaceModel";

function fixture() {
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
        strokes: [],
        decision: "unreviewed",
      },
    ],
    view: { ...DEFAULT_REDACTION_VIEW, currentId: "a" },
    preferences: DEFAULT_REDACTION_PREFERENCES,
    presets: [],
  });
}
it("returns an explicit failure without committing a partially valid batch", () => {
  const state = fixture();
  const result = runRedactionCommand(state, (current) =>
    decideRedactionPages(current, ["a", "foreign"], "reviewed"),
  );
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toBeInstanceOf(Error);
  expect(state.documents.a.decision).toBe("unreviewed");
  expect(state.generation).toBe(0);
});
it("acknowledges successful and no-op commands without a storage dependency", () => {
  const state = fixture();
  expect(runRedactionCommand(state, (current) => current)).toEqual({
    ok: true,
    state,
  });
  const result = runRedactionCommand(state, (current) =>
    decideRedactionPages(current, ["a"], "reviewed"),
  );
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.state.documents.a.decision).toBe("reviewed");
  expect(state.documents.a.decision).toBe("unreviewed");
});
