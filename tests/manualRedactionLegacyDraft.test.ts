import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  DEFAULT_REDACTION_PREFERENCES,
  DEFAULT_REDACTION_VIEW,
} from "../src/shared/imageRedactionWorkspace";
import {
  readRedactionWorkspaceStore,
  updateRedactionWorkspaceStore,
} from "../src/main/imageRedactionWorkspaceStore";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function legacyDraft(decision = "deferred") {
  const root = await mkdtemp(join(tmpdir(), "redaction-legacy-"));
  roots.push(root);
  const path = join(root, "manual-redaction-workspaces.json");
  const strokes = [
    {
      shape: "rectangle",
      size: 40,
      points: [
        { x: 1, y: 2 },
        { x: 10, y: 20 },
      ],
    },
  ];
  const data = {
    version: 1,
    revision: 7,
    pages: {
      "source.png": {
        fingerprint: "a".repeat(64),
        strokes,
        decision,
        width: 120,
        height: 160,
      },
    },
    views: {
      scope: {
        ...DEFAULT_REDACTION_VIEW,
        currentId: "p1",
        selectedIds: ["p1"],
        filter: "deferred",
        pageViews: { p1: { zoom: 150, x: 0.2, y: 0.4 } },
      },
    },
    preferences: DEFAULT_REDACTION_PREFERENCES,
    presets: [],
  };
  const bytes = JSON.stringify(data);
  await writeFile(path, bytes);
  return { root, path, data, bytes };
}
it("opens a legacy deferred draft as unreviewed without losing masks, position or selection", async () => {
  const f = await legacyDraft();
  const state = await readRedactionWorkspaceStore(f.root);
  expect(state.revision).toBe(7);
  expect(state.pages["source.png"]).toEqual({
    ...f.data.pages["source.png"],
    decision: "unreviewed",
  });
  expect(state.views.scope).toEqual({
    ...f.data.views.scope,
    filter: "unreviewed",
  });
  // Merely opening a draft neither writes the file nor approves an outbound job.
  expect(await readFile(f.path, "utf8")).toBe(f.bytes);
  await expect(
    updateRedactionWorkspaceStore(f.root, async () => {}),
  ).resolves.toBe(8);
  expect(await readRedactionWorkspaceStore(f.root)).toMatchObject({
    revision: 8,
    pages: { "source.png": { decision: "unreviewed" } },
    views: { scope: { filter: "unreviewed" } },
  });
});
it("preserves explicit reviewed decisions", async () => {
  const f = await legacyDraft("reviewed");
  expect(
    (await readRedactionWorkspaceStore(f.root)).pages["source.png"].decision,
  ).toBe("reviewed");
});
it("rejects unknown decisions rather than silently resetting user data", async () => {
  const f = await legacyDraft("corrupt");
  await expect(readRedactionWorkspaceStore(f.root)).rejects.toThrow();
  expect(await readFile(f.path, "utf8")).toBe(f.bytes);
});
