import { nativeImage } from "electron";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  openRedactionWorkspaceSession,
  closeRedactionWorkspace,
  saveRedactionWorkspace,
} from "../src/main/imageRedactionWorkspaceSessions";
import { getRedactionWorkspacePreview } from "../src/main/imageRedactionWorkspacePreview";

// Only the Electron image-decoder boundary is replaced; sessions, fingerprints,
// immutable snapshots, temporary files and workspace persistence are real.
vi.mock("electron", () => ({
  nativeImage: { createFromBuffer: vi.fn(), createFromPath: vi.fn() },
}));
const roots: string[] = [],
  sessions: string[] = [];
const empty = { isEmpty: () => true } as Electron.NativeImage;
const decoded = {
  isEmpty: () => false,
  getSize: () => ({ width: 20, height: 20 }),
  toDataURL: () => "data:image/png;base64,fixture",
} as Electron.NativeImage;
beforeEach(() => {
  vi.mocked(nativeImage.createFromBuffer).mockReset().mockReturnValue(empty);
  vi.mocked(nativeImage.createFromPath).mockReset().mockReturnValue(empty);
});
afterEach(async () => {
  for (const id of sessions.splice(0)) await closeRedactionWorkspace(id);
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "redaction-composition-"));
  roots.push(root);
  const path = join(root, "original.jpg"),
    bytes = Buffer.from("source bytes");
  await writeFile(path, bytes);
  const page = {
    id: "page",
    name: "original.jpg",
    imagePath: path,
    fingerprint: createHash("sha256").update(bytes).digest("hex"),
    width: 20,
    height: 20,
    strokes: [],
  };
  const id = randomUUID();
  sessions.push(id);
  const workspace = await openRedactionWorkspaceSession([page], id, root);
  const request = { sessionId: id, pageId: page.id, maxEdge: 320 as const };
  return { root, path, bytes, page, workspace, request };
}
it("uses the supplied decoder with frozen source bytes and the session cancellation signal", async () => {
  const f = await fixture();
  const decode = vi.fn(async (path: string, signal?: AbortSignal) => {
    expect(path).not.toBe(f.path);
    expect(await readFile(path)).toEqual(f.bytes);
    expect(signal?.aborted).toBe(false);
    vi.mocked(nativeImage.createFromBuffer).mockReturnValue(decoded);
    return Buffer.from("decoded bytes");
  });
  expect(await getRedactionWorkspacePreview(f.request, decode)).toBe(
    decoded.toDataURL(),
  );
  expect(decode).toHaveBeenCalledOnce();
  await expect(readFile(decode.mock.calls[0][0])).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(await readFile(f.path)).toEqual(f.bytes);
  await expect(getRedactionWorkspacePreview(f.request, decode)).resolves.toBe(
    decoded.toDataURL(),
  );
  expect(decode).toHaveBeenCalledOnce();
});
it("rejects replaced source bytes before decoding or returning a cached preview", async () => {
  const f = await fixture();
  vi.mocked(nativeImage.createFromBuffer).mockReturnValue(decoded);
  const decode = vi.fn(async () => null);
  await getRedactionWorkspacePreview(f.request, decode);
  await writeFile(f.path, "replacement");
  await expect(getRedactionWorkspacePreview(f.request, decode)).rejects.toThrow(
    "변경",
  );
  expect(decode).not.toHaveBeenCalled();
});
it("aborts a decoder when the owning session closes and does not return its late image", async () => {
  const f = await fixture();
  const decode = vi.fn(async (_path: string, signal?: AbortSignal) => {
    await closeRedactionWorkspace(f.workspace.sessionId);
    expect(signal?.aborted).toBe(true);
    vi.mocked(nativeImage.createFromBuffer).mockReturnValue(decoded);
    return Buffer.from("late image");
  });
  await expect(
    getRedactionWorkspacePreview(f.request, decode),
  ).rejects.toThrow();
  expect(decode).toHaveBeenCalledOnce();
});
it("stores and reopens decisions only in the supplied data root", async () => {
  const f = await fixture();
  await saveRedactionWorkspace({
    sessionId: f.workspace.sessionId,
    expectedRevision: 0,
    changes: [
      {
        id: f.page.id,
        fingerprint: f.page.fingerprint,
        strokes: f.page.strokes,
        decision: "reviewed",
      },
    ],
    view: f.workspace.view,
    preferences: f.workspace.preferences,
    presets: [],
  });
  const other = await mkdtemp(join(tmpdir(), "redaction-separate-root-"));
  roots.push(other);
  const id = randomUUID();
  sessions.push(id);
  const isolated = await openRedactionWorkspaceSession([f.page], id, other);
  expect(isolated.pages[0].decision).toBe("unreviewed");
  expect(isolated.revision).toBe(0);
  expect(await readFile(f.path)).toEqual(f.bytes);
});
