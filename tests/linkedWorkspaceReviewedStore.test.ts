import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { LinkedWorkspaceStore } from "../src/main/linkedWorkspace/linkedWorkspaceStore";
import {
  DEFAULT_RASTER_EXPORT_SETTINGS,
  type LinkedWorkspaceRecordV1,
} from "../src/shared/linkedWorkspaceTypes";

function record(rootPath: string): LinkedWorkspaceRecordV1 {
  return {
    id: randomUUID(),
    workId: randomUUID(),
    chapterId: randomUUID(),
    rootPath,
    enabled: true,
    output: { ...DEFAULT_RASTER_EXPORT_SETTINGS, destinationMode: "fixed" },
    pageRelativePaths: {},
    publishedRevisions: {},
    publishedMirrorRevisions: {},
    sourceFingerprints: {},
    artifacts: {},
    createdAt: "2026-09-23T00:00:00.000Z",
    updatedAt: "2026-09-23T00:00:00.000Z",
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "linked-reviewed-store-"));
  const store = new LinkedWorkspaceStore(root);
  const selected = record(join(root, "selected"));
  const unrelated = record(join(root, "unrelated"));
  await store.replaceRecord(selected);
  await store.replaceRecord(unrelated);
  await store.replaceQueueItems([]);
  const registryPath = join(root, "linked-workspaces.json");
  const queuePath = join(root, "linked-sync-queue.json");
  return {
    root,
    store,
    selected,
    unrelated,
    registryPath,
    queuePath,
    close: () => rm(root, { recursive: true, force: true }),
  };
}

it("rejects a changed reviewed connection selection before any registry publication", async () => {
  const f = await fixture();
  try {
    const before = await readFile(f.registryPath);
    const publication = {
      prepared: vi.fn(async () => {}),
      committed: vi.fn(async () => {}),
    };
    const selections = [
      { expected: [f.selected, f.selected], next: [f.selected, f.selected] },
      { expected: [f.selected], next: [] },
      { expected: [f.selected], next: [f.selected, f.unrelated] },
      { expected: [f.selected], next: [f.unrelated] },
    ];
    for (const selection of selections) {
      await expect(
        f.store.replaceReviewedRecords(
          selection.expected,
          selection.next,
          publication,
        ),
      ).rejects.toThrow("Reviewed registry selection changed.");
      expect(await readFile(f.registryPath)).toEqual(before);
    }
    expect(publication.prepared).not.toHaveBeenCalled();
    expect(publication.committed).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it("rejects stale or missing reviewed metadata and allows a later current commit without touching other connections", async () => {
  const f = await fixture();
  try {
    const current = { ...f.selected, enabled: false };
    await f.store.replaceRecord(current);
    const before = await readFile(f.registryPath);
    const queue = await readFile(f.queuePath);
    const prepared = vi.fn(async () => {});
    await expect(
      f.store.replaceReviewedRecords([f.selected], [f.selected], { prepared }),
    ).rejects.toThrow("Reviewed registry changed.");
    const missing = record(join(f.root, "missing"));
    await expect(
      f.store.replaceReviewedRecords([missing], [missing], { prepared }),
    ).rejects.toThrow("Reviewed registry changed.");
    expect(prepared).not.toHaveBeenCalled();
    expect(await readFile(f.registryPath)).toEqual(before);

    const next = { ...current, updatedAt: "2026-09-23T00:01:00.000Z" };
    const events: string[] = [];
    await f.store.replaceReviewedRecords([current], [next], {
      prepared: async (temporary, target) => {
        expect(target).toBe(f.registryPath);
        expect(await readFile(target)).toEqual(before);
        expect(JSON.parse(await readFile(temporary, "utf8")).records).toEqual([
          f.unrelated,
          next,
        ]);
        events.push("prepared");
      },
      committed: async () => {
        expect((await f.store.readRegistry()).records).toEqual([
          f.unrelated,
          next,
        ]);
        events.push("committed");
      },
    });
    expect(events).toEqual(["prepared", "committed"]);
    expect(await readFile(f.queuePath)).toEqual(queue);
  } finally {
    await f.close();
  }
});

it("preserves the registry when its publication guard fails and clears the staged file before a retry", async () => {
  const f = await fixture();
  try {
    const before = await readFile(f.registryPath);
    const next = { ...f.selected, enabled: false };
    const denied = new Error("reviewed publication no longer authorized");
    const committed = vi.fn(async () => {});
    await expect(
      f.store.replaceReviewedRecords([f.selected], [next], {
        beforeAttempt: async () => {
          throw denied;
        },
        committed,
      }),
    ).rejects.toBe(denied);
    expect(committed).not.toHaveBeenCalled();
    expect(await readFile(f.registryPath)).toEqual(before);
    expect((await readdir(f.root)).sort()).toEqual([
      "linked-sync-queue.json",
      "linked-workspaces.json",
    ]);
    await f.store.replaceReviewedRecords([f.selected], [next], {});
    expect((await f.store.readRegistry()).records).toEqual([next, f.unrelated]);
  } finally {
    await f.close();
  }
});
