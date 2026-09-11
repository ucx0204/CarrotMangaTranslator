import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanupRedactionDraftObjects,
  maintainRedactionDraftObjects,
} from "../src/main/imageRedactionWorkspaceCleanup";
import { redactionWorkspaceIndexSchema } from "../src/main/imageRedactionWorkspaceIndex";
import {
  REDACTION_INDEX_FILE,
  REDACTION_OBJECT_DIRECTORY,
} from "../src/main/imageRedactionWorkspaceObjects";
import { updateRedactionWorkspaceStore } from "../src/main/imageRedactionWorkspaceStore";

const roots: string[] = [];
const now = Date.now();
const old = new Date(now - 48 * 60 * 60 * 1000);
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "redaction-cleanup-"));
  roots.push(root);
  await updateRedactionWorkspaceStore(root, async (state) => {
    state.pages["source.png"] = {
      fingerprint: "a".repeat(64),
      strokes: [],
      decision: "reviewed",
      width: 20,
      height: 20,
    };
  });
  const directory = join(root, REDACTION_OBJECT_DIRECTORY);
  const index = redactionWorkspaceIndexSchema.parse(
    JSON.parse(await readFile(join(root, REDACTION_INDEX_FILE), "utf8")),
  );
  return { root, directory, index };
}
async function stale(directory: string, name: string) {
  const path = join(directory, name);
  await writeFile(path, "preserve unless private stale garbage");
  await utimes(path, old, old);
  return path;
}
it("removes only aged unreferenced objects and own temporary files, never masks, backups or originals", async () => {
  const { root, directory, index } = await fixture();
  const garbage = await stale(directory, `${"b".repeat(64)}.json`);
  const temp = await stale(directory, `.manual-redaction-${randomUUID()}.tmp`);
  const preserved = await Promise.all([
    stale(directory, `legacy-${"c".repeat(64)}.json`),
    stale(directory, "user-notes.json"),
    stale(root, "source.png"),
  ]);
  await writeFile(join(directory, `${"d".repeat(64)}.json`), "recent");
  for (const hash of [
    ...Object.values(index.pages),
    index.preferences,
    index.presets,
  ])
    await utimes(join(directory, `${hash}.json`), old, old);
  expect(await cleanupRedactionDraftObjects(root, index, now)).toBe(2);
  await expect(lstat(garbage)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(lstat(temp)).rejects.toMatchObject({ code: "ENOENT" });
  for (const path of preserved)
    expect(await readFile(path, "utf8")).toContain("preserve");
  expect(
    await readFile(join(directory, `${"d".repeat(64)}.json`), "utf8"),
  ).toBe("recent");
  for (const hash of [
    ...Object.values(index.pages),
    index.preferences,
    index.presets,
  ])
    expect((await lstat(join(directory, `${hash}.json`))).isFile()).toBe(true);
});
it("bounds each cleanup pass and does not traverse a directory disguised as an object", async () => {
  const { root, directory, index } = await fixture();
  for (let i = 0; i < 260; i++)
    await stale(directory, `${i.toString(16).padStart(64, "0")}.json`);
  const disguised = join(directory, `${"f".repeat(64)}.json`);
  await mkdir(disguised);
  await stale(disguised, "user.png");
  expect(await cleanupRedactionDraftObjects(root, index, now)).toBe(256);
  expect(await cleanupRedactionDraftObjects(root, index, now)).toBe(4);
  expect(await readFile(join(disguised, "user.png"), "utf8")).toContain(
    "preserve",
  );
});
it.skipIf(process.platform === "win32")(
  "refuses a substituted private directory and never follows a file symlink",
  async () => {
    const { root, directory, index } = await fixture();
    const source = await stale(root, "original.png");
    const link = join(directory, `${"e".repeat(64)}.json`);
    await symlink(source, link);
    expect(await cleanupRedactionDraftObjects(root, index, now)).toBe(0);
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    await rm(directory, { recursive: true });
    await symlink(root, directory);
    await expect(
      cleanupRedactionDraftObjects(root, index, now),
    ).rejects.toThrow();
    expect(await readFile(source, "utf8")).toContain("preserve");
  },
);
it("does not fail an acknowledged save on maintenance errors or retry cleanup for every autosave", async () => {
  const { root, directory, index } = await fixture();
  const otherRoot = await mkdtemp(
    join(tmpdir(), "redaction-maintenance-failure-"),
  );
  roots.push(otherRoot);
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  await expect(
    maintainRedactionDraftObjects(otherRoot, index),
  ).resolves.toBeUndefined();
  expect(warning).toHaveBeenCalledOnce();
  await maintainRedactionDraftObjects(otherRoot, index);
  expect(warning).toHaveBeenCalledOnce();
  await stale(directory, `${"b".repeat(64)}.json`);
  await updateRedactionWorkspaceStore(root, async () => {});
  expect(await readdir(directory)).toContain(`${"b".repeat(64)}.json`);
});
