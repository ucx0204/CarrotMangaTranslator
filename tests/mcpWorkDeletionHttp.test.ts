import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { workDeletionFixture } from "./mcpWorkDeletion.fixture";
import { organizationHttpFixture } from "./mcpOrganizationHttp.fixture";
import { WorkDeletionRecordSchema } from "../src/main/application/mcpWorkDeletionState";

it("keeps read-only review separate from approved whole-work deletion, recovery and disposal", async () => {
  const f = await organizationHttpFixture(await workDeletionFixture());
  try {
    const result = await f.http(
      "carrot_preview_work_deletion",
      { workId: "work" },
      f.read,
    );
    expect(result.result.isError).toBe(false);
    const input = {
      workId: "work",
      snapshot: result.result.structuredContent.snapshot,
      requestId: randomUUID(),
      confirm: "delete-work-with-seven-day-recovery",
    };
    expect(
      (await f.http("carrot_delete_work", input, f.read)).error.message,
    ).toBe("Unknown tool");
    for (const patch of [
      { confirm: true },
      { path: "C:/private" },
      { chapterId: "chapter" },
    ])
      expect(
        (await f.http("carrot_delete_work", { ...input, ...patch })).error.code,
      ).toBe(-32602);
    await f.assertWorkOriginal();
    const saved = (await f.http("carrot_delete_work", input)).result
      .structuredContent;
    expect(saved.status).toBe("saved");
    expect(
      (await f.http("carrot_get_work_deletion", { id: saved.id }, f.other))
        .result.isError,
    ).toBe(true);
    expect(
      (await f.http("carrot_list_work_deletions", {}, f.other)).result
        .structuredContent.total,
    ).toBe(0);
    const view = (await f.http("carrot_get_work_deletion", { id: saved.id }))
      .result.structuredContent;
    expect(view.canUndo).toBe(true);
    expect(JSON.stringify(view)).not.toMatch(
      /imagePath|sourceText|PRIVATE|"parts"|large\.bin/,
    );
    const undo = {
      id: saved.id,
      snapshot: view.snapshot,
      requestId: randomUUID(),
      confirm: true,
    };
    expect(
      (await f.http("carrot_undo_work_deletion", undo, f.read)).error.message,
    ).toBe("Unknown tool");
    expect(
      (await f.http("carrot_undo_work_deletion", undo)).result.isError,
    ).toBe(false);
    await f.assertWorkOriginal();
    expect(
      (await f.http("carrot_delete_work", input)).result.structuredContent
        .historical,
    ).toBe(true);
    expect(
      (
        await f.http("carrot_discard_work_deletion", {
          id: saved.id,
          confirm: true,
        })
      ).result.structuredContent.workChanges,
    ).toBe(0);
    await f.assertWorkOriginal();
    f.revoke();
    expect(
      (await f.http("carrot_preview_work_deletion", { workId: "work" })).error,
    ).toBeDefined();
  } finally {
    await f.close();
  }
});

it("late OAuth revocation aborts both native work deletion and retained publication", async () => {
  const f = await organizationHttpFixture(await workDeletionFixture());
  try {
    const review = (
      await f.http("carrot_preview_work_deletion", { workId: "work" })
    ).result.structuredContent;
    const seal = f.codec.seal.bind(f.codec);
    let revoked = false;
    vi.spyOn(f.codec, "seal").mockImplementation(async (value) => {
      const result = await seal(value);
      if (!revoked && WorkDeletionRecordSchema.safeParse(value).success) {
        revoked = true;
        f.revoke();
      }
      return result;
    });
    const result = await f.http("carrot_delete_work", {
      workId: "work",
      snapshot: review.snapshot,
      requestId: randomUUID(),
      confirm: "delete-work-with-seven-day-recovery",
    });
    expect(result.result?.isError || Boolean(result.error)).toBe(true);
    vi.restoreAllMocks();
    expect(revoked).toBe(true);
    await f.assertWorkOriginal();
    expect((await f.storage.index()).entries).toEqual([]);
    expect(f.notify).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
    await f.close();
  }
});
