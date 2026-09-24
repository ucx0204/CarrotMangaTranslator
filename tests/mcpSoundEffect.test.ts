import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { soundEffectFixture } from "./mcpSoundEffect.fixture";
import { captureSoundEffectPage } from "../src/shared/soundEffectPageSnapshot";

it("reads stored candidates and sound blocks without writes, image disclosure or engine activity", async () => {
  const f = await soundEffectFixture();
  try {
    const before = await readFile(f.chapterPath);
    const first = await f.query({ limit: 1 });
    expect(first.total).toBe(2);
    expect(first.items[0]).toMatchObject({
      id: "candidate",
      kind: "candidate",
      state: "pending",
      sourceRect: { x: 75, y: 65, w: 15, h: 20 },
    });
    expect(first.generation.runtimeChecked).toBe(false);
    const second = await f.query({
      offset: 1,
      limit: 1,
      reviewRevision: first.reviewRevision,
    });
    expect(second.items[0]).toMatchObject({
      kind: "block",
      sourceText: "\u30c9\u30f3",
      translatedText: "\ucfe5",
      imageState: "none",
    });
    expect(JSON.stringify(first)).not.toMatch(
      /dataUrl|imagePath|inpaintedImagePath/,
    );
    expect(await readFile(f.chapterPath)).toEqual(before);
    expect(f.startClient).not.toHaveBeenCalled();
    expect(f.acquireEngine).not.toHaveBeenCalled();
    await expect(f.query({ offset: 1 })).rejects.toThrow();
    await expect(
      f.query({ reviewRevision: "page-v1:0000000000000000" }),
    ).rejects.toThrow("changed");
  } finally {
    await f.close();
  }
});
it("preserves detector evidence while excluding/restoring and exactly recovering review state", async () => {
  const f = await soundEffectFixture();
  try {
    const before = (await f.snapshot()).pages[0];
    const plan = await f.preview({
      kind: "review",
      decisions: [{ regionId: "candidate", action: "exclude" }],
      additions: [],
    });
    expect((await f.snapshot()).pages[0]).toEqual(before);
    expect((await f.action(plan.batchId, "apply")).result.status).toBe(
      "completed",
    );
    const after = (await f.snapshot()).pages[0];
    expect(after.soundEffectReview?.regions).toEqual(
      before.soundEffectReview?.regions,
    );
    expect(after.blocks).toEqual(before.blocks);
    expect((await f.query()).items[0].state).toBe("excluded");
    expect((await f.action(plan.batchId, "undo")).result.status).toBe(
      "completed",
    );
    expect(captureSoundEffectPage((await f.snapshot()).pages[0])).toEqual(
      captureSoundEffectPage(before),
    );
    expect((await f.action(plan.batchId, "redo")).result.status).toBe(
      "completed",
    );
    const restore = await f.preview({
      kind: "review",
      decisions: [{ regionId: "candidate", action: "restore" }],
      additions: [],
    });
    expect((await f.action(restore.batchId, "apply")).result.status).toBe(
      "completed",
    );
    expect((await f.query()).items[0].state).toBe("pending");
    expect(f.startClient).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});
it("materializes only approved pending candidate text and exactly restores blocks and the resolution ledger", async () => {
  const f = await soundEffectFixture();
  try {
    const before = (await f.snapshot()).pages[0],
      source = await readFile(before.imagePath);
    const plan = await f.preview({
      kind: "materialize",
      entries: [
        {
          regionId: "candidate",
          sourceText: "\u30c9\u30ab",
          translatedText: "\ucf85",
          allowOverlap: false,
        },
      ],
    });
    expect((await f.action(plan.batchId, "apply")).result.status).toBe(
      "completed",
    );
    const after = (await f.snapshot()).pages[0];
    expect(after.blocks.slice(0, before.blocks.length)).toEqual(before.blocks);
    expect(after.blocks.at(-1)).toMatchObject({
      textRole: "sound",
      sourceText: "\u30c9\u30ab",
      translatedText: "\ucf85",
    });
    expect(after.soundEffectReview?.resolvedRegions).toHaveLength(1);
    expect((await f.action(plan.batchId, "undo")).result.status).toBe(
      "completed",
    );
    expect(captureSoundEffectPage((await f.snapshot()).pages[0])).toEqual(
      captureSoundEffectPage(before),
    );
    expect((await f.action(plan.batchId, "redo")).result.status).toBe(
      "completed",
    );
    expect((await f.snapshot()).pages[0].blocks).toEqual(after.blocks);
    expect(await readFile(before.imagePath)).toEqual(source);
    expect(f.startClient).not.toHaveBeenCalled();
    expect(f.acquireEngine).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});
it("changes sound text only, rejects dialogue and refuses review-only conflicts invisible to normal page revision", async () => {
  const f = await soundEffectFixture();
  try {
    const page = (await f.snapshot()).pages[0];
    await expect(
      f.preview({
        kind: "text",
        edits: [{ blockId: page.blocks[1].id, translatedText: "wrong" }],
      }),
    ).rejects.toThrow("sound-effect");
    const plan = await f.preview({
      kind: "text",
      edits: [{ blockId: page.blocks[0].id, translatedText: "\ucfe5!" }],
    });
    const data = JSON.parse(await readFile(f.chapterPath, "utf8"));
    data.pages[0].soundEffectReview.dismissedRegionIds = ["candidate"];
    await writeFile(f.chapterPath, JSON.stringify(data));
    expect((await f.action(plan.batchId, "apply")).result.status).toBe(
      "failed",
    );
    expect((await f.snapshot()).pages[0].blocks).toEqual(page.blocks);
    const next = await f.preview(plan.request.command);
    const actionId = randomUUID();
    expect(
      (await f.action(next.batchId, "apply", actionId)).result.status,
    ).toBe("completed");
    expect((await f.action(next.batchId, "undo")).result.status).toBe(
      "completed",
    );
    expect(
      (await f.action(next.batchId, "apply", actionId)).receipt.historical,
    ).toBe(true);
    expect((await f.snapshot()).pages[0].blocks).toEqual(page.blocks);
  } finally {
    await f.close();
  }
});
it("adds and edits only manual/override geometry while retaining immutable recognized candidates", async () => {
  const f = await soundEffectFixture();
  try {
    const before = (await f.snapshot()).pages[0];
    const plan = await f.preview({
      kind: "review",
      decisions: [
        {
          regionId: "candidate",
          action: "include",
          sourceRect: { x: 70, y: 60, w: 18, h: 23 },
        },
      ],
      additions: [{ key: "extra", sourceRect: { x: 5, y: 70, w: 15, h: 20 } }],
    });
    expect((await f.action(plan.batchId, "apply")).result.status).toBe(
      "completed",
    );
    const after = (await f.snapshot()).pages[0];
    expect(after.soundEffectReview?.regions).toEqual(
      before.soundEffectReview?.regions,
    );
    expect(after.soundEffectReview?.manualRegions[0].id).toMatch(/^manual-/);
    const items = (await f.query()).items;
    expect(items.find((item) => item.id === "candidate")?.sourceText).toBe("");
    expect(items.find((item) => item.id === "candidate")?.sourceRect).toEqual({
      x: 70,
      y: 60,
      w: 18,
      h: 23,
    });
    expect((await f.action(plan.batchId, "undo")).result.status).toBe(
      "completed",
    );
    expect(captureSoundEffectPage((await f.snapshot()).pages[0])).toEqual(
      captureSoundEffectPage(before),
    );
  } finally {
    await f.close();
  }
});
