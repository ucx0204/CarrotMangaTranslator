import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { RedactionWorkspaceApplicationService } from "../src/main/application/redactionWorkspaceService";
import type { RedactionWorkspacePorts } from "../src/main/application/redactionWorkspacePorts";
import {
  DEFAULT_REDACTION_PREFERENCES,
  DEFAULT_REDACTION_VIEW,
} from "../src/shared/imageRedactionWorkspace";

function ports(): RedactionWorkspacePorts {
  return {
    readDraft: vi.fn(async () => ({
      revision: 0,
      pages: {},
      views: {},
      preferences: DEFAULT_REDACTION_PREFERENCES,
      presets: [],
    })),
    readApproved: vi.fn(async () => ({ pages: {} })),
    updateDraft: vi.fn(async () => {
      throw new Error("disk unavailable");
    }),
    fingerprint: vi.fn(async () => "a".repeat(64)),
    reportCleanupError: vi.fn(),
  };
}
const page = {
  id: "a",
  name: "a",
  imagePath: "a.png",
  width: 20,
  height: 20,
  fingerprint: "a".repeat(64),
  strokes: [],
};
it("keeps session ownership independent between service instances without Electron", async () => {
  const dependencies = ports();
  const a = new RedactionWorkspaceApplicationService(dependencies);
  const b = new RedactionWorkspaceApplicationService(ports());
  const id = randomUUID();
  const [one, two] = await Promise.all([
    a.open([page], id, "root"),
    a.open([page], id, "root"),
  ]);
  expect(two).toBe(one);
  expect(dependencies.readDraft).toHaveBeenCalledOnce();
  expect(dependencies.readDraft).toHaveBeenCalledWith("root", {
    paths: [resolve(page.imagePath)],
    scopeKey: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  expect(() => b.getPage(id, "a")).toThrow();
  const { signal } = a.getPage(id, "a");
  expect(await a.close(id)).toBe(true);
  expect(signal.aborted).toBe(true);
  expect(await a.close(id)).toBe(false);
});
it("does not acknowledge a failed write and still allows closing the session", async () => {
  const service = new RedactionWorkspaceApplicationService(ports());
  const id = randomUUID();
  const workspace = await service.open([page], id, "root");
  await expect(
    service.save({
      sessionId: id,
      expectedRevision: 0,
      changes: [],
      view: { ...DEFAULT_REDACTION_VIEW, currentId: "a" },
      preferences: DEFAULT_REDACTION_PREFERENCES,
      presets: [],
    }),
  ).rejects.toThrow("disk unavailable");
  expect(await service.open([page], id, "root")).toBe(workspace);
  expect(await service.close(id)).toBe(true);
});
it("reports initialization failures during close without leaking a session", async () => {
  const dependencies = ports();
  const error = new Error("read failed");
  dependencies.readDraft = vi.fn(async () => {
    throw error;
  });
  const service = new RedactionWorkspaceApplicationService(dependencies);
  const id = randomUUID();
  const opening = service.open([page], id, "root");
  const close = service.close(id);
  await expect(opening).rejects.toBe(error);
  expect(await close).toBe(false);
  expect(dependencies.reportCleanupError).toHaveBeenCalledWith(
    expect.any(String),
    error,
  );
  expect(() => service.getPage(id, "a")).toThrow();
});
