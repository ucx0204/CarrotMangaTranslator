import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  assertRedactionWorkspaceConfirmation,
  closeRedactionWorkspace,
  openRedactionWorkspaceSession,
  saveRedactionWorkspace,
} from "../src/main/imageRedactionWorkspaceSessions";
import { readRedactionWorkspaceStore } from "../src/main/imageRedactionWorkspaceStore";
import type { ImageRedactionPage } from "../src/shared/imageRedaction";
import type {
  RedactionWorkspace,
  SaveRedactionWorkspace,
} from "../src/shared/imageRedactionWorkspace";

// Only the unused native boundary is replaced; sessions and file transactions are real.
vi.mock("electron", () => ({ nativeImage: {} }));
const roots: string[] = [];
const sessions: string[] = [];
afterEach(async () => {
  for (const id of sessions.splice(0)) await closeRedactionWorkspace(id);
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function peer(root: string, pages: ImageRedactionPage[]) {
  const id = randomUUID();
  sessions.push(id);
  return openRedactionWorkspaceSession(pages, id, root);
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "redaction-concurrency-"));
  roots.push(root);
  const pages: ImageRedactionPage[] = [];
  for (const id of ["a", "b"]) {
    const imagePath = join(root, `${id}.png`);
    await writeFile(imagePath, id);
    pages.push({
      id,
      name: id,
      imagePath,
      width: 20,
      height: 20,
      fingerprint: createHash("sha256").update(id).digest("hex"),
      strokes: [],
    });
  }
  return { root, pages };
}
function request(workspace: RedactionWorkspace): SaveRedactionWorkspace {
  return {
    sessionId: workspace.sessionId,
    expectedRevision: workspace.revision,
    changes: workspace.pages.map(({ id, fingerprint, strokes }) => ({
      id,
      fingerprint,
      strokes,
      decision: "reviewed",
    })),
    view: workspace.view,
    preferences: workspace.preferences,
    presets: workspace.presets,
  };
}
function confirmation(workspace: RedactionWorkspace, revision: number) {
  return {
    jobId: randomUUID(),
    sessionId: workspace.sessionId,
    workspaceRevision: revision,
    pages: workspace.pages.map(({ id, fingerprint, strokes }) => ({
      id,
      fingerprint,
      strokes,
    })),
  };
}

it("saves disjoint sessions without overwriting untouched settings or blocking their approval", async () => {
  const { root, pages } = await fixture();
  const a = await peer(root, [pages[0]]);
  const b = await peer(root, [pages[1]]);
  const revisionA = await saveRedactionWorkspace({
    ...request(a),
    preferences: { ...a.preferences, tool: "brush" },
  });
  const revisionB = await saveRedactionWorkspace(request(b));
  expect([revisionA, revisionB]).toEqual([1, 2]);
  const disk = await readRedactionWorkspaceStore(root);
  expect(Object.keys(disk.pages)).toHaveLength(2);
  expect(disk.preferences.tool).toBe("brush");
  await expect(
    assertRedactionWorkspaceConfirmation(confirmation(a, revisionA)),
  ).resolves.toBeUndefined();
  await expect(
    assertRedactionWorkspaceConfirmation(confirmation(b, revisionB)),
  ).resolves.toBeUndefined();
});

it("rejects overlapping writes and does not adopt an unseen page after a view-only save", async () => {
  const { root, pages } = await fixture();
  const a = await peer(root, [pages[0]]);
  const b = await peer(root, [pages[0]]);
  await saveRedactionWorkspace(request(a));
  await expect(saveRedactionWorkspace(request(b))).rejects.toThrow(
    "다른 가리기 창",
  );
  const revision = await saveRedactionWorkspace({
    ...request(b),
    changes: [],
    view: { ...b.view, filter: "masked" },
  });
  await expect(
    saveRedactionWorkspace({ ...request(b), expectedRevision: revision }),
  ).rejects.toThrow("다른 가리기 창");
  const disk = await readRedactionWorkspaceStore(root);
  expect(disk.pages[pages[0].imagePath].decision).toBe("reviewed");
});

it("keeps settings collisions atomic and allows retry without overwriting the other session's settings", async () => {
  const { root, pages } = await fixture();
  const a = await peer(root, [pages[0]]);
  const b = await peer(root, [pages[1]]);
  await saveRedactionWorkspace({
    ...request(a),
    preferences: { ...a.preferences, tool: "brush" },
  });
  await expect(
    saveRedactionWorkspace({
      ...request(b),
      preferences: { ...b.preferences, tool: "erase" },
    }),
  ).rejects.toThrow("다른 가리기 창");
  const disk = await readRedactionWorkspaceStore(root);
  expect(disk.pages[pages[1].imagePath]).toBeUndefined();
  await saveRedactionWorkspace(request(b));
  expect((await readRedactionWorkspaceStore(root)).preferences.tool).toBe(
    "brush",
  );
});

it("checks only changed views but never approves a page changed by another session", async () => {
  const { root, pages } = await fixture();
  const a = await peer(root, [pages[0]]);
  const first = await saveRedactionWorkspace(request(a));
  const b = await peer(root, [pages[0]]);
  await saveRedactionWorkspace({
    ...request(a),
    expectedRevision: first,
    changes: request(a).changes.map((page) => ({
      ...page,
      decision: "unreviewed" as const,
    })),
    view: { ...a.view, filter: "masked" },
  });
  await expect(
    saveRedactionWorkspace({
      ...request(b),
      changes: [],
      view: { ...b.view, filter: "reviewed" },
    }),
  ).rejects.toThrow("다른 가리기 창");
  const revision = await saveRedactionWorkspace({ ...request(b), changes: [] });
  await expect(
    assertRedactionWorkspaceConfirmation(confirmation(b, revision)),
  ).rejects.toThrow("다른 가리기 창");
});
