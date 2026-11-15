import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { imageEditingFixture } from "./mcpImageEditing.fixture";

it("preserves saved images and undo at the reference limit, which waiting cannot clear", async () => {
  const realNow = Date.now.bind(Date);
  let elapsed = 0;
  const clock = vi
    .spyOn(Date, "now")
    .mockImplementation(() => realNow() + elapsed);
  const f = await imageEditingFixture();
  const command = (index: number) => ({
    kind: "paint" as const,
    color: index % 2 ? "#ffffff" : "#000000",
    geometry: {
      kind: "rectangle" as const,
      start: { x: 10, y: 10 },
      end: { x: 20, y: 20 },
    },
    protectedAreas: [],
  });
  try {
    let lastId = "";
    for (let i = 0; i < 64; i++) {
      if (i && i % 30 === 0) elapsed += 31 * 60_000;
      const plan = await f.preview(command(i));
      expect((await f.action(plan.batchId, "apply")).result.status).toBe(
        "completed",
      );
      lastId = plan.batchId;
    }
    const saved = await readFile(f.chapterPath);
    const plan = await f.preview(command(64));
    const failed = (await f.action(plan.batchId, "apply")).result;
    expect(failed.status).toBe("failed");
    expect(failed.pages[0].errorCode).toBe("image_recovery_limit");
    expect(failed.pages[0].errorMessage).toContain("Waiting will not release");
    expect(await readFile(f.chapterPath)).toEqual(saved);
    expect((await f.action(lastId, "undo")).result.status).toBe("completed");
    expect((await f.action(lastId, "redo")).result.status).toBe("completed");
    elapsed += 31 * 60_000;
    const afterWaiting = await f.preview(command(64));
    expect(
      (await f.action(afterWaiting.batchId, "apply")).result.pages[0].errorCode,
    ).toBe("image_recovery_limit");
    expect((await f.snapshot()).pages[0].imagePath).toBeDefined();
    expect(f.acquireEngine).not.toHaveBeenCalled();
  } finally {
    await f.close();
    clock.mockRestore();
  }
}, 60_000);
