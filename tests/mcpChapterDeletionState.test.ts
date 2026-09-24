import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { hashStableValue } from "../src/shared/blockFingerprint";
import {
  ChapterDeletionRecordSchema,
  chapterDeletionApplied,
  chapterDeletionReceipt,
  priorChapterDeletionAction,
} from "../src/main/application/mcpChapterDeletionState";
import {
  McpChapterDeletionApplySchema,
  McpChapterDeletionRecoverySchema,
  McpChapterDeletionTargetSchema,
  mcpChapterDeletionOutputs,
} from "../src/shared/mcpChapterDeletion";
import { chapterDeletionFilesFixture } from "./mcpChapterDeletionFiles.fixture";

it("requires explicit deletion acknowledgement and rejects unreviewed fields and unsafe target IDs", () => {
  const target = { workId: "work", chapterId: "chapter" };
  expect(McpChapterDeletionTargetSchema.parse(target)).toEqual(target);
  const input = {
    ...target,
    requestId: randomUUID(),
    snapshot: "a".repeat(16),
    confirm: "delete-chapter-with-seven-day-recovery",
  };
  expect(McpChapterDeletionApplySchema.parse(input)).toEqual(input);
  for (const patch of [
    { confirm: undefined },
    { confirm: true },
    { path: "C:/private" },
    { chapterId: "../chapter" },
    { workId: "" },
    { snapshot: "stale" },
  ])
    expect(
      McpChapterDeletionApplySchema.safeParse({ ...input, ...patch }).success,
    ).toBe(false);
  const action = {
    id: randomUUID(),
    requestId: randomUUID(),
    snapshot: input.snapshot,
    confirm: true,
  };
  expect(McpChapterDeletionRecoverySchema.parse(action)).toEqual(action);
  expect(
    McpChapterDeletionRecoverySchema.safeParse({ ...action, confirm: false })
      .success,
  ).toBe(false);
});

it("binds the private record to exact work membership, input snapshot, asset inventory and alternating recovery actions", async () => {
  const f = await chapterDeletionFilesFixture();
  try {
    const { record } = await f.retain();
    expect(
      ChapterDeletionRecordSchema.parse(JSON.parse(JSON.stringify(record))),
    ).toEqual(record);
    for (const mutate of [
      (value: typeof record) => {
        value.before.id = "other";
      },
      (value: typeof record) => {
        value.after.title = "Not part of deletion";
      },
      (value: typeof record) => {
        value.before.chapterOrder.push("chapter");
      },
      (value: typeof record) => {
        value.parts.pop();
      },
      (value: typeof record) => {
        value.tree.files[0].sha256 = "0".repeat(64);
      },
      (value: typeof record) => {
        value.signature = "0".repeat(16);
      },
      (value: typeof record) => {
        value.expiresAt = value.createdAt;
      },
      (value: typeof record) => {
        value.actions = [
          {
            requestId: randomUUID(),
            direction: "redo",
            signature: "a".repeat(16),
          },
        ];
      },
    ]) {
      const changed = structuredClone(record);
      mutate(changed);
      expect(ChapterDeletionRecordSchema.safeParse(changed).success).toBe(
        false,
      );
    }
    expect(chapterDeletionApplied(record)).toBe(true);
    const undo = {
      id: record.id,
      requestId: randomUUID(),
      snapshot: chapterDeletionReceipt(record, randomUUID(), "delete").snapshot,
      confirm: true as const,
    };
    const after = {
      ...record,
      actions: [
        {
          requestId: undo.requestId,
          signature: hashStableValue({ input: undo, direction: "undo" }),
          direction: "undo" as const,
        },
      ],
    };
    expect(
      chapterDeletionApplied(ChapterDeletionRecordSchema.parse(after)),
    ).toBe(false);
    expect(priorChapterDeletionAction(after, undo, "undo")).toEqual(
      after.actions[0],
    );
    expect(priorChapterDeletionAction(record, undo, "undo")).toBeUndefined();
    expect(() => priorChapterDeletionAction(after, undo, "redo")).toThrow(
      "another recovery",
    );
    expect(() =>
      priorChapterDeletionAction(
        record,
        { ...undo, requestId: record.input.requestId },
        "undo",
      ),
    ).toThrow("new requestId");
    for (const direction of ["delete", "undo", "redo"] as const) {
      const receipt = chapterDeletionReceipt(
        record,
        randomUUID(),
        direction,
        direction === "redo",
      );
      const schema =
        direction === "delete"
          ? mcpChapterDeletionOutputs.carrot_delete_chapter
          : mcpChapterDeletionOutputs[`carrot_${direction}_chapter_deletion`];
      expect(schema.parse(receipt)).toEqual(receipt);
      expect(receipt.status).toBe(
        direction === "redo" ? "already_applied" : "saved",
      );
    }
  } finally {
    await f.close();
  }
});
