import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { hashStableValue } from "../src/shared/blockFingerprint";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { pageOrganizationFixture } from "./mcpLibraryPageOrder.fixture";
import { createDeferred } from "./inpaintingSelectionJobFixtures";
import { McpLibraryOrganizationRecordSchema } from "../src/main/application/mcpLibraryOrganizationState";

it("does not mistake a newly created empty memory file for the earlier missing state", async () => {
  const f = await pageOrganizationFixture();
  try {
    const saved = await f.apply(await f.command(f.intent));
    await f.writeMemory({ ...f.memory, pages: [] });
    const memory = await readFile(f.memoryPath);
    expect(await f.inspectChange(saved.id)).toMatchObject({ canUndo: false });
    await expect(f.recover(saved.id, "undo")).rejects.toMatchObject({
      code: "revision_conflict",
    });
    expect(await readFile(f.memoryPath)).toEqual(memory);
    expect((await f.library.openChapter(f.chapter.id)).pageOrder).toEqual(
      f.intent.pageIds,
    );
  } finally {
    await f.close();
  }
});

it.each(["null", "malformed", "foreign", "directory"] as const)(
  "rejects %s saved memory without changing any page",
  async (kind) => {
    const f = await pageOrganizationFixture();
    try {
      const before = await readFile(f.chapterPath);
      if (kind === "directory") await mkdir(f.memoryPath);
      else if (kind === "foreign")
        await f.writeMemory({ ...f.memory, chapterId: "foreign" });
      else await writeFile(f.memoryPath, kind === "null" ? "null" : "{");
      await expect(f.preview(f.intent)).rejects.toThrow();
      expect(await readFile(f.chapterPath)).toEqual(before);
    } finally {
      await f.close();
    }
  },
);

it("honors the existing work-context activity rather than racing memory reconciliation", async () => {
  const f = await pageOrganizationFixture();
  const entered = createDeferred<void>(),
    release = createDeferred<void>();
  let blocking: Promise<unknown> | undefined;
  try {
    const { withLibraryContentEdit } = await import("../src/main/library/lock");
    const input = await f.command(f.intent);
    blocking = withLibraryContentEdit(
      [{ kind: "work-context", scope: f.intent.workId, access: "write" }],
      async () => {
        entered.resolve();
        await release.promise;
      },
    );
    await entered.promise;
    await expect(f.apply(input)).rejects.toThrow();
    expect(f.app.jobs.gate.activities).toHaveLength(1);
    release.resolve();
    await blocking;
    expect(await f.apply(input)).toMatchObject({ status: "saved" });
    expect(f.app.jobs.gate.activities).toEqual([]);
  } finally {
    release.resolve();
    await blocking;
    await f.close();
  }
});

it("validates stored order, record inventory, memory presence and chapter identity instead of accepting forged recovery", async () => {
  const f = await pageOrganizationFixture();
  try {
    await f.writeMemory();
    const saved = await f.apply(await f.command(f.intent));
    const record = McpLibraryOrganizationRecordSchema.parse(
      await f.storage.record(saved.id),
    );
    const base = record.after.fields.pageOrdering;
    if (!base?.memory) throw new Error("Missing fixture memory");
    for (const patch of [
      { order: [f.chapter.pageOrder[0], f.chapter.pageOrder[0]] },
      { order: [...base.order].reverse() },
      { records: ["unknown", "page"] },
      { memory: null },
      { memory: { ...base.memory, workId: "foreign" } },
      { memory: { ...base.memory, chapterId: "foreign" } },
      { memory: { ...base.memory, pages: "invalid" } },
      { status: "invented" },
    ])
      expect(
        McpLibraryOrganizationRecordSchema.safeParse({
          ...record,
          after: {
            ...record.after,
            fields: {
              ...record.after.fields,
              pageOrdering: { ...base, ...patch },
            },
          },
        }).success,
      ).toBe(false);
    expect(
      McpLibraryOrganizationRecordSchema.safeParse({
        ...record,
        before: {
          ...record.before,
          fields: { ...record.before.fields, pageOrdering: undefined },
        },
      }).success,
    ).toBe(false);
  } finally {
    await f.close();
  }
});

it("rejects an incomplete stored page inventory instead of silently normalizing it in a remote command", async () => {
  const f = await pageOrganizationFixture();
  try {
    const chapter = JSON.parse(await readFile(f.chapterPath, "utf8"));
    chapter.pageOrder = [chapter.pageOrder[0]];
    await writeFile(f.chapterPath, JSON.stringify(chapter));
    const before = await readFile(f.chapterPath);
    await expect(f.preview(f.intent)).rejects.toMatchObject({
      code: "invalid_edit",
    });
    expect(await readFile(f.chapterPath)).toEqual(before);
  } finally {
    await f.close();
  }
});

it("rejects an exchanged recovery identity after initial lookup without changing page order or memory", async () => {
  const f = await pageOrganizationFixture();
  try {
    await f.writeMemory();
    const saved = await f.apply(await f.command(f.intent));
    const record = McpLibraryOrganizationRecordSchema.parse(
      await f.storage.record(saved.id),
    );
    const altered = structuredClone(record);
    altered.input.planFingerprint = "0123456789abcdef";
    altered.signature = hashStableValue(altered.input);
    const encoded = JSON.stringify(
      await f.codec.seal(McpLibraryOrganizationRecordSchema.parse(altered)),
    );
    const path = await f.storage.path(saved.id);
    const original = await readFile(path);
    const chapter = await readFile(f.chapterPath),
      memory = await readFile(f.memoryPath);
    const { McpLibraryOrganizationApplication } =
      await import("../src/main/mcp/mcpLibraryOrganizationApplication");
    const { McpLibraryOrganizationRepository } =
      await import("../src/main/mcp/mcpLibraryOrganizationRepository");
    const service = new McpLibraryOrganizationApplication(
      new McpLibraryOrganizationRepository(f.storage),
    );
    let checks = 0;
    await expect(
      service.recover(
        "import-owner",
        {
          id: saved.id,
          snapshot: saved.snapshot,
          requestId: randomUUID(),
        },
        "undo",
        () => {
          // An out-of-process metadata replacement between read admission and write admission.
          if (++checks === 2) writeFileSync(path, encoded);
        },
      ),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    expect(checks).toBeGreaterThanOrEqual(3);
    expect(await readFile(f.chapterPath)).toEqual(chapter);
    expect(await readFile(f.memoryPath)).toEqual(memory);
    expect(f.app.jobs.gate.activities).toEqual([]);
    await writeFile(path, original);
    expect((await f.inspectChange(saved.id)).canUndo).toBe(true);
  } finally {
    await f.close();
  }
});
