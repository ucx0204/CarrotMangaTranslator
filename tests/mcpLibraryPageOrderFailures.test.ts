import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { pageOrganizationFixture } from "./mcpLibraryPageOrder.fixture";
import { McpLibraryOrganizationRecordSchema } from "../src/main/application/mcpLibraryOrganizationState";

it("rejects memory edits during review or after apply and never forces an older memory onto new content", async () => {
  const f = await pageOrganizationFixture();
  try {
    await f.writeMemory();
    const stale = await f.command(f.intent);
    f.memory.pages[0].summary = "Later manual summary";
    await f.writeMemory();
    await expect(f.apply(stale)).rejects.toMatchObject({
      code: "revision_conflict",
    });
    const saved = await f.apply(await f.command(f.intent));
    const after = await readFile(f.chapterPath);
    const changed = await f.readMemory();
    changed.pages[0].visualSummary = "Later scene description";
    await f.writeMemory(changed);
    const memory = await readFile(f.memoryPath);
    expect(await f.inspectChange(saved.id)).toMatchObject({
      canUndo: false,
      canRedo: false,
    });
    await expect(f.recover(saved.id, "undo")).rejects.toMatchObject({
      code: "revision_conflict",
    });
    expect(await readFile(f.chapterPath)).toEqual(after);
    expect(await readFile(f.memoryPath)).toEqual(memory);
  } finally {
    await f.close();
  }
});

it.each([
  "encryption",
  "revocation",
  "expiry",
  "session-stop",
  "external-memory",
] as const)(
  "publishes neither page order nor reconciled memory when late %s prevents commit",
  async (failure) => {
    const f = await pageOrganizationFixture();
    let authorized = true;
    try {
      await f.writeMemory();
      const work = await readFile(f.workPath),
        chapter = await readFile(f.chapterPath);
      let memory = await readFile(f.memoryPath);
      const entries = (await f.storage.index()).entries;
      const input = await f.command(f.intent);
      const seal = f.codec.seal.bind(f.codec);
      let injected = false;
      vi.spyOn(f.codec, "seal").mockImplementation(async (value) => {
        const encoded = await seal(value);
        const parsed = McpLibraryOrganizationRecordSchema.safeParse(value);
        if (!injected && parsed.success) {
          injected = true;
          if (failure === "encryption")
            throw new Error("Late encryption failure");
          if (failure === "revocation") authorized = false;
          if (failure === "expiry") f.clock(parsed.data.expiresAt);
          if (failure === "session-stop") f.organization().stop();
          if (failure === "external-memory") {
            f.memory.pages[0].summary = "Concurrent external edit";
            await f.writeMemory();
            memory = await readFile(f.memoryPath);
          }
        }
        return encoded;
      });
      await expect(
        f.call(
          "carrot_apply_library_change",
          input,
          f.auth("import-owner", () => {
            if (!authorized) throw new Error("Revoked test grant");
          }),
        ),
      ).rejects.toThrow();
      vi.restoreAllMocks();
      expect(injected).toBe(true);
      expect(await readFile(f.workPath)).toEqual(work);
      expect(await readFile(f.chapterPath)).toEqual(chapter);
      expect(await readFile(f.memoryPath)).toEqual(memory);
      expect((await f.storage.index()).entries).toEqual(entries);
      expect(f.app.jobs.gate.activities).toEqual([]);
    } finally {
      vi.restoreAllMocks();
      await f.close();
    }
  },
);

it("refuses corrupted memory recovery in both advisory lookup and actual Undo", async () => {
  const f = await pageOrganizationFixture();
  try {
    await f.writeMemory();
    const saved = await f.apply(await f.command(f.intent));
    const record = McpLibraryOrganizationRecordSchema.parse(
      await f.storage.record(saved.id),
    );
    const altered = structuredClone(record);
    if (!altered.before.fields.pageOrdering?.memory)
      throw new Error("Missing fixture memory");
    altered.before.fields.pageOrdering.memory.pages[0].summary =
      "Forged old summary";
    await writeFile(
      await f.storage.path(saved.id),
      JSON.stringify(await f.codec.seal(altered)),
    );
    const chapter = await readFile(f.chapterPath),
      memory = await readFile(f.memoryPath);
    await expect(f.inspectChange(saved.id)).rejects.toThrow();
    await expect(
      f.call("carrot_undo_library_change", {
        id: saved.id,
        snapshot: saved.snapshot,
        requestId: randomUUID(),
      }),
    ).rejects.toThrow();
    expect(await readFile(f.chapterPath)).toEqual(chapter);
    expect(await readFile(f.memoryPath)).toEqual(memory);
    await writeFile(
      await f.storage.path(saved.id),
      JSON.stringify(await f.codec.seal(record)),
    );
    expect((await f.inspectChange(saved.id)).canUndo).toBe(true);
  } finally {
    await f.close();
  }
});
