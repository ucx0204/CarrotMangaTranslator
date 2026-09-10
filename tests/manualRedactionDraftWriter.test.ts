import { expect, it, vi } from "vitest";
import {
  DEFAULT_REDACTION_PREFERENCES,
  DEFAULT_REDACTION_VIEW,
  type SaveRedactionWorkspace,
} from "../src/shared/imageRedactionWorkspace";
import {
  createRedactionSession,
  editRedactionDocuments,
} from "../src/renderer/src/components/imageRedaction/redactionSession";
import { RedactionDraftWriter } from "../src/renderer/src/components/imageRedaction/redactionDraftWriter";

function fixture() {
  return createRedactionSession({
    sessionId: "11111111-1111-4111-8111-111111111111",
    revision: 4,
    pages: [
      {
        id: "a",
        name: "a",
        imagePath: "a.png",
        width: 10,
        height: 10,
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
it("coalesces saves and flushes newer edits with the acknowledged revision", async () => {
  let current = fixture();
  const requests: SaveRedactionWorkspace[] = [];
  let release: (revision: number) => void = () => {};
  const writer = new RedactionDraftWriter(current, {
    read: () => current,
    persist: async (request) => {
      requests.push(request);
      if (requests.length === 1)
        return new Promise<number>((resolve) => {
          release = resolve;
        });
      return 6;
    },
    notify: vi.fn(),
  });
  current = editRedactionDocuments(current, [
    { ...current.documents.a, decision: "reviewed" },
  ]);
  const first = writer.flush();
  expect(writer.flush()).toBe(first);
  current = editRedactionDocuments(current, [
    { ...current.documents.a, decision: "deferred" },
  ]);
  release(5);
  await expect(first).resolves.toBe(6);
  expect(requests.map((request) => request.expectedRevision)).toEqual([4, 5]);
  expect(requests[1].changes[0].decision).toBe("deferred");
  await writer.flush();
  expect(requests).toHaveLength(2);
});
it("retains failed input and revision for an explicit retry rather than acknowledging it", async () => {
  let current = fixture();
  const persist = vi.fn<(request: SaveRedactionWorkspace) => Promise<number>>();
  persist.mockRejectedValueOnce(new Error("disk full")).mockResolvedValue(5);
  const notify = vi.fn();
  const writer = new RedactionDraftWriter(current, {
    read: () => current,
    persist,
    notify,
  });
  current = editRedactionDocuments(current, [
    { ...current.documents.a, decision: "reviewed" },
  ]);
  await expect(writer.flush()).rejects.toThrow("disk full");
  expect(current.documents.a.decision).toBe("reviewed");
  await expect(writer.flush()).resolves.toBe(5);
  expect(
    persist.mock.calls.map(([request]) => request.expectedRevision),
  ).toEqual([4, 4]);
  expect(notify).toHaveBeenLastCalledWith({ kind: "saved" });
});
