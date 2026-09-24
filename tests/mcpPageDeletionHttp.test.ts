import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { pageDeletionFixture } from "./mcpPageDeletion.fixture";
import { organizationHttpFixture } from "./mcpOrganizationHttp.fixture";
import { PageDeletionRecordSchema } from "../src/main/application/mcpPageDeletionState";

it("separates page deletion read scopes from explicit removal and recovery and returns no raw archived content", async () => {
  const f = await organizationHttpFixture(await pageDeletionFixture());
  try {
    const review = await f.http(
      "carrot_preview_page_deletion",
      f.pageTarget,
      f.read,
    );
    expect(review.result.isError).toBe(false);
    const input = {
      ...f.pageTarget,
      snapshot: review.result.structuredContent.snapshot,
      requestId: randomUUID(),
      confirm: "delete-page-with-seven-day-recovery",
    };
    expect(
      (await f.http("carrot_delete_page", input, f.read)).error.message,
    ).toBe("Unknown tool");
    for (const patch of [
      { confirm: true },
      { path: "C:/private" },
      { pageId: "../page" },
    ])
      expect(
        (await f.http("carrot_delete_page", { ...input, ...patch })).error.code,
      ).toBe(-32602);
    await f.assertPageOriginal();
    const saved = (await f.http("carrot_delete_page", input)).result
      .structuredContent;
    expect(saved.status).toBe("saved");
    expect(
      (await f.http("carrot_get_page_deletion", { id: saved.id }, f.other))
        .result.isError,
    ).toBe(true);
    const view = (await f.http("carrot_get_page_deletion", { id: saved.id }))
      .result.structuredContent;
    expect(view.canUndo).toBe(true);
    expect(JSON.stringify(view)).not.toMatch(
      /PRIVATE|imagePath|sourceText|dataUrl|"parts"|original\.bin/,
    );
    const action = {
      id: saved.id,
      snapshot: view.snapshot,
      requestId: randomUUID(),
      confirm: true,
    };
    expect(
      (await f.http("carrot_undo_page_deletion", action, f.read)).error.message,
    ).toBe("Unknown tool");
    expect(
      (await f.http("carrot_undo_page_deletion", action)).result.isError,
    ).toBe(false);
    await f.assertPageOriginal();
    expect(
      (await f.http("carrot_delete_page", input)).result.structuredContent
        .historical,
    ).toBe(true);
    expect(
      (
        await f.http("carrot_discard_page_deletion", {
          id: saved.id,
          confirm: true,
        })
      ).result.structuredContent.pageChanges,
    ).toBe(0);
    await f.assertPageOriginal();
    f.revoke();
    expect(
      (await f.http("carrot_preview_page_deletion", f.pageTarget)).error,
    ).toBeDefined();
  } finally {
    await f.close();
  }
});

it("revoking the actual OAuth connection during sealing rolls back page, memory and recovery together", async () => {
  const f = await organizationHttpFixture(await pageDeletionFixture());
  try {
    const view = (await f.http("carrot_preview_page_deletion", f.pageTarget))
      .result.structuredContent;
    const seal = f.codec.seal.bind(f.codec);
    let revoked = false;
    vi.spyOn(f.codec, "seal").mockImplementation(async (value) => {
      const result = await seal(value);
      if (!revoked && PageDeletionRecordSchema.safeParse(value).success) {
        revoked = true;
        f.revoke();
      }
      return result;
    });
    const result = await f.http("carrot_delete_page", {
      ...f.pageTarget,
      snapshot: view.snapshot,
      requestId: randomUUID(),
      confirm: "delete-page-with-seven-day-recovery",
    });
    expect(result.result?.isError || Boolean(result.error)).toBe(true);
    vi.restoreAllMocks();
    expect(revoked).toBe(true);
    await f.assertPageOriginal();
    expect((await f.storage.index()).entries).toEqual([]);
    expect(f.notify).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
    await f.close();
  }
});
