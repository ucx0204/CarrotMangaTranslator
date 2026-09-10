import { afterEach, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openRedactionWorkspaceSession, saveRedactionWorkspace, closeRedactionWorkspace, assertRedactionWorkspaceConfirmation, getRedactionWorkspacePage } from "../src/main/imageRedactionWorkspaceSessions";
import { imageFingerprint } from "../src/main/imageRedactionContext";
import { readRedactionWorkspaceStore } from "../src/main/imageRedactionWorkspaceStore";
import type { RedactionWorkspace, SaveRedactionWorkspace } from "../src/shared/imageRedactionWorkspace";

const roots: string[] = [], sessions: string[] = [];
afterEach(async () => {
  for (const id of sessions.splice(0)) await closeRedactionWorkspace(id);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "manual-redaction-workspace-")); roots.push(root);
  const path = join(root, "page.png"); await writeFile(path, "unchanged image bytes");
  const id = randomUUID(); sessions.push(id);
  const page = { id: "page", name: "page", imagePath: path, width: 20, height: 20, fingerprint: await imageFingerprint(path), strokes: [] };
  const workspace = await openRedactionWorkspaceSession([page], id, root);
  return { root, path, page, workspace };
}
function request(workspace: RedactionWorkspace): SaveRedactionWorkspace {
  return { sessionId: workspace.sessionId, expectedRevision: workspace.revision,
    changes: workspace.pages.map(({ id, fingerprint, strokes }) => ({ id, fingerprint, strokes, decision: "reviewed" })),
    view: workspace.view, preferences: workspace.preferences, presets: workspace.presets };
}
function confirmation(workspace: RedactionWorkspace, revision: number) {
  return { jobId: randomUUID(), sessionId: workspace.sessionId, workspaceRevision: revision,
    pages: workspace.pages.map(({ id, fingerprint, strokes }) => ({ id, fingerprint, strokes })) };
}
it("persists drafts and resumes review without touching the original or approving a job", async () => {
  const f = await fixture(); const original = await readFile(f.path);
  const revision = await saveRedactionWorkspace(request(f.workspace));
  expect(revision).toBe(1);
  await expect(readFile(join(f.root, "image-redactions.json"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(f.path)).toEqual(original);
  await closeRedactionWorkspace(f.workspace.sessionId);
  const nextId = randomUUID(); sessions.push(nextId);
  const resumed = await openRedactionWorkspaceSession([f.page], nextId, f.root);
  expect(resumed.pages[0].decision).toBe("reviewed");
  expect(resumed.view.currentId).toBe("page");
});
it("requires current saved decisions and an identical final snapshot", async () => {
  const f = await fixture();
  await expect(assertRedactionWorkspaceConfirmation(confirmation(f.workspace, 0))).rejects.toThrow();
  const revision = await saveRedactionWorkspace(request(f.workspace));
  await expect(assertRedactionWorkspaceConfirmation(confirmation(f.workspace, revision))).resolves.toBeUndefined();
  const changed = confirmation(f.workspace, revision);
  changed.pages[0].strokes = [{ shape: "rectangle", size: 1, points: [{ x: 1, y: 1 }] }];
  await expect(assertRedactionWorkspaceConfirmation(changed)).rejects.toThrow();
  await expect(assertRedactionWorkspaceConfirmation(confirmation(f.workspace, 0))).rejects.toThrow();
});
it("rejects foreign pages, duplicate changes and stale concurrent saves without losing the stored draft", async () => {
  const f = await fixture(); const save = request(f.workspace);
  await expect(saveRedactionWorkspace({ ...save, changes: [...save.changes, ...save.changes] })).rejects.toThrow();
  await expect(saveRedactionWorkspace({ ...save, view: { ...save.view, selectedIds: ["foreign"] } })).rejects.toThrow();
  const outcomes = await Promise.allSettled([saveRedactionWorkspace(save), saveRedactionWorkspace(save)]);
  expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect((await readRedactionWorkspaceStore(f.root)).revision).toBe(1);
  expect(() => getRedactionWorkspacePage(f.workspace.sessionId, "foreign")).toThrow();
});
it("does not reuse decisions after a source replacement and preserves failed-save input", async () => {
  const f = await fixture(); await saveRedactionWorkspace(request(f.workspace));
  await writeFile(f.path, "replacement bytes");
  const save = { ...request(f.workspace), expectedRevision: 1 };
  await expect(saveRedactionWorkspace(save)).rejects.toThrow();
  expect(save.changes[0].decision).toBe("reviewed");
  await closeRedactionWorkspace(f.workspace.sessionId);
  const id = randomUUID(); sessions.push(id);
  const workspace = await openRedactionWorkspaceSession([{ ...f.page, fingerprint: await imageFingerprint(f.path) }], id, f.root);
  expect(workspace.pages[0].decision).toBe("unreviewed");
});
it("surfaces corrupt storage rather than silently discarding drafts", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "manual-redaction-workspaces.json"), "broken");
  await expect(saveRedactionWorkspace(request(f.workspace))).rejects.toThrow();
  expect(await readFile(join(f.root, "manual-redaction-workspaces.json"), "utf8")).toBe("broken");
});
