import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LinkedWorkspaceStore } from "../src/main/linkedWorkspace/linkedWorkspaceStore";
import type {
  LinkedSyncQueueItemV1,
  LinkedWorkspaceRecordV1,
} from "../src/shared/linkedWorkspaceTypes";
import { DEFAULT_RASTER_EXPORT_SETTINGS } from "../src/shared/linkedWorkspaceTypes";

const tempDirs: string[] = [];
const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
const WORK_ID = "22222222-2222-4222-8222-222222222222";
const CHAPTER_ID = "33333333-3333-4333-8333-333333333333";
const PAGE_ID = "44444444-4444-4444-8444-444444444444";

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("LinkedWorkspaceStore", () => {
  it("loads an old data root without rewriting it", async () => {
    const root = await makeTempDir();
    const store = new LinkedWorkspaceStore(root);
    await expect(store.readRegistry()).resolves.toEqual({
      schemaVersion: 1,
      records: [],
    });
    await expect(store.readQueue()).resolves.toEqual({
      schemaVersion: 1,
      items: [],
    });
  });

  it("replaces a chapter connection and round-trips its latest queue item", async () => {
    const root = await makeTempDir();
    const store = new LinkedWorkspaceStore(root);
    const first = makeRecord(CONNECTION_ID, "C:\\first");
    const replacement = makeRecord(
      "55555555-5555-4555-8555-555555555555",
      "C:\\second",
    );
    await store.replaceRecord(first);
    await store.replaceRecord(replacement);
    expect((await store.readRegistry()).records).toEqual([replacement]);

    const item = makeQueueItem(replacement.id);
    await store.replaceQueueItems([item]);
    expect((await store.readQueue()).items).toEqual([item]);
    await expect(store.removeRecord(replacement.id)).resolves.toBe(true);
    expect((await store.readQueue()).items).toEqual([]);
  });

  it("rejects corrupted registry and queue JSON", async () => {
    const root = await makeTempDir();
    await writeFile(join(root, "linked-workspaces.json"), "{broken");
    const store = new LinkedWorkspaceStore(root);
    await expect(store.readRegistry()).rejects.toThrow();

    await writeFile(
      join(root, "linked-workspaces.json"),
      JSON.stringify({ schemaVersion: 1, records: [] }),
    );
    await writeFile(
      join(root, "linked-sync-queue.json"),
      JSON.stringify({ schemaVersion: 1, items: [{ unsafe: true }] }),
    );
    await expect(store.readQueue()).rejects.toThrow();
  });
});

function makeRecord(id: string, rootPath: string): LinkedWorkspaceRecordV1 {
  const timestamp = "2026-08-24T00:00:00.000Z";
  return {
    id,
    workId: WORK_ID,
    chapterId: CHAPTER_ID,
    rootPath,
    enabled: true,
    output: { ...DEFAULT_RASTER_EXPORT_SETTINGS, destinationMode: "fixed" },
    pageRelativePaths: { [PAGE_ID]: "001.png" },
    publishedRevisions: {},
    publishedMirrorRevisions: {},
    sourceFingerprints: {},
    artifacts: {},
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function makeQueueItem(connectionId: string): LinkedSyncQueueItemV1 {
  return {
    connectionId,
    chapterId: CHAPTER_ID,
    pageId: PAGE_ID,
    visualRevision: "page-visual-v1:0123456789abcdef",
    mirrorRevision: "page-v1:0123456789abcdef",
    priority: 10,
    attempts: 0,
    nextRetryAt: 0,
    queuedAt: 0,
  };
}

async function makeTempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "mgt-linked-store-"));
  tempDirs.push(path);
  return path;
}
