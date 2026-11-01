import { randomUUID } from "node:crypto";
import { ok } from "node:assert";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { retentionFixture } from "./mcpRetention.fixture";
import {
  MCP_RETENTION_BYTES,
  MCP_RETENTION_CLEANUP_BATCH,
} from "../src/main/mcp/mcpRetentionRecords";
import { createPageRevision } from "../src/shared/pageRevision";
import {
  compositeBound,
  compositeReserved,
  compositeOutcome,
  newCompositeRecord,
} from "./mcpCompositeRepository.fixture";

type Fixture = Awaited<ReturnType<typeof retentionFixture>>;
async function fillHistory(f: Fixture) {
  const index = await f.storage.index();
  const first = index.entries.find((entry) => entry.kind === "change");
  ok(first);
  first.bytes = MCP_RETENTION_BYTES;
  await writeFile(
    await f.storage.path(),
    JSON.stringify(await f.codec.seal(index)),
  );
  return first.id;
}
async function publish(
  f: Fixture,
  operation: Parameters<
    typeof import("../src/main/libraryStore/libraryTransaction").runLibraryTransaction
  >[1],
) {
  const { withLibraryMutation } = await import("../src/main/library/lock");
  const { runLibraryTransaction } =
    await import("../src/main/libraryStore/libraryTransaction");
  return withLibraryMutation(() =>
    runLibraryTransaction("test-retention-policy", operation),
  );
}

it("shares active record protection across connections and rotates only after the lease ends", async () => {
  const f = await retentionFixture();
  try {
    await f.edit("protected history");
    const id = await fillHistory(f);
    const original = await readFile(await f.storage.path(id));
    await f.storage.withRecordLease(id, async () => {
      await f.edit("another connection saves at the target");
      expect(await readFile(await f.storage.path(id))).toEqual(original);
      expect(
        (await f.storage.index()).entries.find((entry) => entry.id === id)
          ?.reclaimedAt,
      ).toBeUndefined();
      await expect(
        f.invoke("carrot_discard_retained", { id, confirm: true }),
      ).rejects.toMatchObject({ code: "editor_busy" });
    });
    await f.edit("after lease settles");
    expect(await f.inspect(id)).toMatchObject({
      state: "reclaimed",
      canUndo: false,
    });
    await expect(f.storage.owned("unrelated-owner", id)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(f.storage.owned(f.owner, id)).rejects.toMatchObject({
      code: "history_reclaimed",
    });
  } finally {
    await f.close();
  }
});

it("keeps outputs and removed-original recovery outside the ordinary history budget", async () => {
  const f = await retentionFixture();
  try {
    await f.paint();
    const page = (await f.snapshot()).pages[0];
    const original = await readFile(page.imagePath);
    ok(page.inpaintedImagePath);
    const current = await readFile(page.inpaintedImagePath);
    const id = await fillHistory(f);
    const protectedPaths: string[] = [];
    await publish(f, async (transaction) => {
      const index = await f.storage.index();
      for (const kind of [
        "output",
        "context",
        "chapter-deletion",
        "work-deletion",
        "page-deletion",
      ] as const) {
        const recordId = randomUUID();
        const directory = await f.storage.create(transaction, recordId);
        await f.storage.writeRecord(directory.stagingDirectory, {
          id: recordId,
          owner: f.owner,
          evidence: kind,
        });
        await writeFile(
          join(directory.stagingDirectory, "preserved.bin"),
          current,
        );
        protectedPaths.push(join(directory.finalDirectory, "preserved.bin"));
        index.entries.push({
          ...index.entries[0],
          id: recordId,
          kind,
          mimeType: kind === "output" ? "image/png" : null,
          sha256: kind === "output" ? "0".repeat(64) : null,
          bytes: MCP_RETENTION_BYTES,
        });
      }
      await f.storage.stageIndex(transaction, index);
    });
    // Essential payloads alone exceed the former global quota and must not rotate anything.
    expect(
      (await f.storage.index()).entries.find((entry) => entry.id === id)
        ?.reclaimedAt,
    ).toBeUndefined();
    await f.edit("save with large protected records");
    expect(await f.inspect(id)).toMatchObject({ state: "reclaimed" });
    for (const path of protectedPaths)
      expect(await readFile(path)).toEqual(current);
    expect(await readFile(page.imagePath)).toEqual(original);
    expect(await readFile(page.inpaintedImagePath)).toEqual(current);
  } finally {
    await f.close();
  }
});

it("protects newly staged workflow references and reconstructs their protection after restart", async () => {
  const f = await retentionFixture();
  try {
    await f.edit("referenced saved change");
    const changeId = (await f.list()).items[0].id;
    const page = (await f.snapshot()).pages[0];
    const prepared = await f.invoke("carrot_prepare_workflow", {
      requestId: randomUUID(),
      reason: "Protect native recovery evidence",
      chapters: [
        {
          chapterId: "chapter",
          pages: [{ pageId: page.id, revision: createPageRevision(page) }],
        },
      ],
      stages: [{ kind: "export-png" }],
    });
    const id = (prepared.structuredContent as { id: string }).id;
    const { McpWorkflowRecordSchema } =
      await import("../src/main/application/mcpWorkflowPolicy");
    const record = McpWorkflowRecordSchema.parse(await f.storage.record(id));
    record.steps[0].changeId = changeId;
    await fillHistory(f);
    await f.storage.withRecordLease(changeId, () =>
      f.edit("creates budget pressure while reference is leased"),
    );
    await publish(f, (transaction) =>
      f.storage.stageRecord(transaction, id, record),
    );
    await f.restart();
    await f.edit("later edit must preserve workflow evidence");
    expect(await f.inspect(changeId)).toMatchObject({ state: "retained" });
    expect(
      McpWorkflowRecordSchema.parse(await f.storage.record(id)).steps[0]
        .changeId,
    ).toBe(changeId);
  } finally {
    await f.close();
  }
});

it("preserves unknown files and corrupt history instead of treating them as disposable", async () => {
  const f = await retentionFixture();
  try {
    await f.edit("keep uncertain history");
    const id = await fillHistory(f);
    const path = join(f.env.libraryDir, ".mcp-retained", id, "user-notes.txt");
    await writeFile(path, "must survive");
    await f.edit("new save despite protected unknown file");
    expect(await readFile(path, "utf8")).toBe("must survive");
    expect(await f.inspect(id)).toMatchObject({ state: "retained" });
    await writeFile(await f.storage.path(id), "corrupt encrypted history");
    await f.edit("new save does not delete corrupt old history");
    expect(await readFile(await f.storage.path(id), "utf8")).toBe(
      "corrupt encrypted history",
    );
  } finally {
    await f.close();
  }
});

it("follows an unexpired composite through an older child and its recovery changes regardless of index order", async () => {
  const f = await retentionFixture();
  try {
    await f.edit("older child evidence");
    const changeId = (await f.list()).items[0].id;
    const page = (await f.snapshot()).pages[0];
    const prepared = await f.invoke("carrot_prepare_workflow", {
      requestId: randomUUID(),
      reason: "Transitive retained evidence",
      chapters: [
        {
          chapterId: "chapter",
          pages: [{ pageId: page.id, revision: createPageRevision(page) }],
        },
      ],
      stages: [{ kind: "export-png" }],
    });
    const childId = (prepared.structuredContent as { id: string }).id;
    const { McpWorkflowRecordSchema } =
      await import("../src/main/application/mcpWorkflowPolicy");
    const child = McpWorkflowRecordSchema.parse(
      await f.storage.record(childId),
    );
    child.steps[0].changeId = changeId;
    await publish(f, (transaction) =>
      f.storage.stageRecord(transaction, childId, child),
    );
    const parent = compositeReserved(
      compositeBound({ ...newCompositeRecord(), owner: f.owner }),
    );
    parent.phases[0].child = {
      ...compositeOutcome(parent).receipt,
      id: childId,
    };
    const { parseCompositeRecord } =
      await import("../src/main/application/mcpCompositeWorkflowRecord");
    await publish(f, (transaction) =>
      f.storage.stageMetadataRecord(
        transaction,
        {
          id: parent.id,
          owner: parent.owner,
          kind: "composite-workflow",
          operation: "carrot_prepare_composite",
          requestId: parent.plan.requestId,
          createdAt: parent.createdAt,
          expiresAt: parent.expiresAt,
          pageCount: 1,
        },
        parseCompositeRecord(parent),
      ),
    );
    const index = await f.storage.index();
    for (const entry of index.entries)
      if ([childId, changeId].includes(entry.id)) entry.expiresAt = 1;
    await writeFile(
      await f.storage.path(),
      JSON.stringify(await f.codec.seal(index)),
    );
    const bytes = await readFile(await f.storage.path(changeId));
    await f.restart();
    await f.edit("new save retains the referenced older chain");
    expect(await readFile(await f.storage.path(changeId))).toEqual(bytes);
    expect((await f.storage.index()).entries.map((entry) => entry.id)).toEqual(
      expect.arrayContaining([childId, changeId, parent.id]),
    );
  } finally {
    await f.close();
  }
});

for (const point of [
  "after-retire-step",
  "before-commit-point",
  "after-commit-point",
] as const) {
  it(`publishes rotation and the new recoverable page together through ${point}`, async () => {
    const f = await retentionFixture();
    const tx = await import("../src/main/libraryStore/libraryTransaction");
    const recovery =
      await import("../src/main/libraryStore/libraryTransactionRecovery");
    let restore = () => {};
    try {
      await f.edit("old saved page");
      const id = await fillHistory(f);
      const oldRecord = await readFile(await f.storage.path(id));
      restore = tx.setLibraryTransactionCrashInjectorForTests((position) => {
        if (position === point)
          throw new tx.SimulatedLibraryTransactionCrash(position);
      });
      await expect(f.edit("new atomic page")).rejects.toThrow();
      restore();
      await recovery.recoverLibraryTransactions();
      await f.restart();
      if (point === "after-commit-point") {
        expect(await f.inspect(id)).toMatchObject({ state: "reclaimed" });
        const latest = (await f.list()).items.find(
          (entry) => entry.state === "retained",
        );
        ok(latest);
        expect((await f.snapshot()).pages[0].blocks[0].translatedText).toBe(
          "new atomic page",
        );
        await f.recover(latest.id, "undo");
      } else {
        expect(await readFile(await f.storage.path(id))).toEqual(oldRecord);
        expect((await f.list()).total).toBe(1);
      }
      expect((await f.snapshot()).pages[0].blocks[0].translatedText).toBe(
        "old saved page",
      );
    } finally {
      restore();
      await f.close();
    }
  });
}

it("rolls back rotation on actual disk-full errors and reports storage separately from history", async () => {
  const f = await retentionFixture();
  const tx = await import("../src/main/libraryStore/libraryTransaction");
  const { mcpToolError } = await import("../src/main/mcp/mcpToolResult");
  let restore = () => {};
  try {
    await f.edit("last good save");
    const id = await fillHistory(f);
    const before = await readFile(f.chapterPath);
    restore = tx.setLibraryTransactionCrashInjectorForTests((point) => {
      if (point === "before-commit-point")
        throw Object.assign(new Error("synthetic disk-full"), {
          code: "ENOSPC",
        });
    });
    const error = await f
      .edit("must roll back")
      .catch((failure: unknown) => failure);
    expect(mcpToolError(error).structuredContent).toMatchObject({
      error: "storage_full",
      retryable: false,
    });
    restore();
    expect(await readFile(f.chapterPath)).toEqual(before);
    await access(await f.storage.path(id));
    expect(await f.inspect(id)).toMatchObject({ state: "retained" });
  } finally {
    restore();
    await f.close();
  }
});

it("bounds rotation work per commit and continues cleanup on later saves", async () => {
  let now = Date.now();
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  const f = await retentionFixture();
  try {
    await f.edit("history before a large released backlog");
    const index = await f.storage.index();
    const first = index.entries[0];
    const source = (await f.storage.record(first.id)) as Record<
      string,
      unknown
    >;
    first.bytes = MCP_RETENTION_BYTES;
    for (let i = 1; i <= MCP_RETENTION_CLEANUP_BATCH; i++) {
      const id = randomUUID();
      const path = join(f.env.libraryDir, ".mcp-retained", id);
      await mkdir(path);
      await writeFile(
        join(path, "record.json"),
        JSON.stringify(await f.codec.seal({ ...source, id })),
      );
      index.entries.push({ ...first, id, createdAt: first.createdAt + i });
    }
    await writeFile(
      await f.storage.path(),
      JSON.stringify(await f.codec.seal(index)),
    );
    // The synthetic backlog must precede new saves even on a fast filesystem.
    now += MCP_RETENTION_CLEANUP_BATCH + 1;
    await f.edit("first bounded cleanup");
    expect(
      (await f.storage.index()).entries.filter(
        (entry) => entry.reclaimedAt !== undefined,
      ),
    ).toHaveLength(MCP_RETENTION_CLEANUP_BATCH);
    now += 1;
    await f.edit("next cleanup makes more progress");
    expect(
      (await f.storage.index()).entries.filter(
        (entry) => entry.reclaimedAt !== undefined,
      ),
    ).toHaveLength(MCP_RETENTION_CLEANUP_BATCH + 1);
  } finally {
    try {
      await f.close();
    } finally {
      clock.mockRestore();
    }
  }
});
