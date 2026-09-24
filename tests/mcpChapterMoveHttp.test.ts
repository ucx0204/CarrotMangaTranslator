import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { chapterMoveFixture } from "./mcpChapterMove.fixture";
import { organizationHttpFixture } from "./mcpOrganizationHttp.fixture";
import { ChapterMoveRecordSchema } from "../src/main/application/mcpChapterMoveState";

it("exposes movement review to read-only grants but requires explicit approved publication and recovery", async () => {
  const f = await organizationHttpFixture(await chapterMoveFixture());
  try {
    const review = (
      await f.http("carrot_preview_chapter_move", { intent: f.intent }, f.read)
    ).result.structuredContent;
    expect(review.eligible).toBe(true);
    const input = {
      intent: f.intent,
      snapshot: review.snapshot,
      planFingerprint: review.planFingerprint,
      requestId: randomUUID(),
      confirm: "move-chapter-between-existing-works",
    };
    expect(
      (await f.http("carrot_move_chapter", input, f.read)).error.message,
    ).toBe("Unknown tool");
    expect(
      (await f.http("carrot_move_chapter", { ...input, confirm: true })).error
        .code,
    ).toBe(-32602);
    expect(
      (await f.http("carrot_move_chapter", { ...input, path: "C:/private" }))
        .error.code,
    ).toBe(-32602);
    const saved = (await f.http("carrot_move_chapter", input)).result
      .structuredContent;
    expect(saved.status).toBe("saved");
    expect(
      (await f.http("carrot_get_chapter_move", { id: saved.id }, f.other))
        .result.isError,
    ).toBe(true);
    expect(
      (await f.http("carrot_list_chapter_moves", {}, f.other)).result
        .structuredContent.total,
    ).toBe(0);
    const view = (await f.http("carrot_get_chapter_move", { id: saved.id }))
      .result.structuredContent;
    expect(view.canUndo).toBe(true);
    expect(JSON.stringify(view)).not.toMatch(
      /imagePath|dataUrl|sourceText|PRIVATE|large\.bin|"parts"/,
    );
    const action = {
      id: saved.id,
      snapshot: view.snapshot,
      requestId: randomUUID(),
      confirm: true,
    };
    expect(
      (await f.http("carrot_undo_chapter_move", action, f.read)).error.message,
    ).toBe("Unknown tool");
    expect(
      (await f.http("carrot_undo_chapter_move", action)).result.isError,
    ).toBe(false);
    await f.assertMoveRestored();
    expect(
      (await f.http("carrot_move_chapter", input)).result.structuredContent
        .historical,
    ).toBe(true);
    await f.assertMoveRestored();
    f.revoke();
    expect(
      (await f.http("carrot_get_chapter_move", { id: saved.id })).error,
    ).toBeDefined();
  } finally {
    await f.close();
  }
});

it("rolls back movement when the HTTP connection is revoked during encrypted publication", async () => {
  const f = await organizationHttpFixture(await chapterMoveFixture());
  try {
    const review = (
      await f.http("carrot_preview_chapter_move", { intent: f.intent })
    ).result.structuredContent;
    const seal = f.codec.seal.bind(f.codec);
    let revoked = false;
    vi.spyOn(f.codec, "seal").mockImplementation(async (value) => {
      const result = await seal(value);
      if (!revoked && ChapterMoveRecordSchema.safeParse(value).success) {
        revoked = true;
        f.revoke();
      }
      return result;
    });
    const result = await f.http("carrot_move_chapter", {
      intent: f.intent,
      snapshot: review.snapshot,
      planFingerprint: review.planFingerprint,
      requestId: randomUUID(),
      confirm: "move-chapter-between-existing-works",
    });
    expect(result.result?.isError || Boolean(result.error)).toBe(true);
    vi.restoreAllMocks();
    expect(revoked).toBe(true);
    await f.assertMoveRestored();
    expect((await f.storage.index()).entries).toEqual([]);
  } finally {
    vi.restoreAllMocks();
    await f.close();
  }
});
