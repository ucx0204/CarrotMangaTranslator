import { randomUUID } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import { imageEditingFixture, brushCommand } from "./mcpImageEditing.fixture";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve: () => resolve() };
}

it("holds the real page/model lease through cancellation cleanup and never saves a cancelled result", async () => {
  const f = await imageEditingFixture(),
    entered = deferred(),
    cleanup = deferred();
  f.inpaint.mockImplementation(
    async (_bitmap, _width, _height, _mask, _windows, options) => {
      entered.resolve();
      await new Promise<void>((resolve) => {
        if (options?.signal?.aborted) resolve();
        else
          options?.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
      });
    },
  );
  f.release.mockImplementation(async () => cleanup.promise);
  try {
    const before = await readFile(f.chapterPath),
      plan = await f.preview(brushCommand()),
      requestId = randomUUID();
    await f.invoke("carrot_apply_image_edit", {
      batchId: plan.batchId,
      requestId,
    });
    await entered.promise;
    await expect(
      f.invoke("carrot_cancel_image_edit", {
        batchId: plan.batchId,
        requestId: randomUUID(),
      }),
    ).rejects.toThrow(/currently inspected/);
    await f.invoke("carrot_cancel_image_edit", {
      batchId: plan.batchId,
      requestId,
    });
    await vi.waitFor(() => expect(f.release).toHaveBeenCalledOnce());
    expect((await f.inspect(plan.batchId)).status).toBe("running");
    expect(f.app.jobs.all).toHaveLength(1);
    expect(await readFile(f.chapterPath)).toEqual(before);
    cleanup.resolve();
    expect((await f.done(plan.batchId)).status).toBe("cancelled");
    expect(await readFile(f.chapterPath)).toEqual(before);
    expect(f.app.jobs.all).toEqual([]);
  } finally {
    cleanup.resolve();
    await f.close();
  }
});

it("keeps an acknowledged save undoable when UI notification fails", async () => {
  const f = await imageEditingFixture();
  try {
    const before = (await f.snapshot()).pages[0];
    const plan = await f.preview(brushCommand());
    f.editing.notifySaved.mockImplementationOnce(() => {
      throw new Error("fixture UI unavailable");
    });
    const result = (await f.action(plan.batchId, "apply")).result;
    expect(result.status).toBe("partial");
    expect(result.canUndo).toBe(true);
    expect(result.pages[0].result).toBe("saved");
    expect((await f.action(plan.batchId, "undo")).result.status).toBe(
      "completed",
    );
    expect((await f.snapshot()).pages[0].inpaintedImagePath).toBe(
      before.inpaintedImagePath,
    );
    expect(f.inpaint).toHaveBeenCalledOnce();
  } finally {
    await f.close();
  }
});

it("reports partial mask completion without rerunning the model and restores that saved result", async () => {
  const f = await imageEditingFixture();
  f.inpaint.mockImplementation(async (bitmap, width) => {
    for (let y = 31; y <= 39; y++)
      for (let x = 21; x <= 29; x++) {
        const i = (y * width + x) * 4;
        bitmap[i] = 80;
        bitmap[i + 1] = 90;
        bitmap[i + 2] = 100;
      }
  });
  try {
    const command = brushCommand();
    if (command.kind !== "erase-mask") throw new Error("Expected drawn mask");
    command.protectedAreas = [];
    command.strokes.push({ points: [{ x: 75, y: 75 }], radiusPx: 8 });
    const plan = await f.preview(command),
      result = (await f.action(plan.batchId, "apply")).result;
    expect(result.status).toBe("partial");
    expect(result.pages[0].result).toBe("saved");
    expect(result.changes[0].outcome).toMatchObject({
      componentsChanged: 1,
      componentsIncomplete: 1,
    });
    expect((await f.action(plan.batchId, "undo")).result.status).toBe(
      "completed",
    );
    expect(f.inpaint).toHaveBeenCalledOnce();
  } finally {
    await f.close();
  }
});

it("does not publish a no-op and records actual zero-change outcomes", async () => {
  const f = await imageEditingFixture();
  f.inpaint.mockImplementation(async () => {});
  try {
    const before = await readFile(f.chapterPath),
      plan = await f.preview(brushCommand());
    const result = (await f.action(plan.batchId, "apply")).result;
    expect(result.status).toBe("failed");
    expect(result.changes[0].outcome).toMatchObject({
      changedPixels: 0,
      componentsChanged: 0,
      componentsIncomplete: 1,
    });
    expect(result.canUndo).toBe(false);
    expect(await readFile(f.chapterPath)).toEqual(before);
    expect(f.inpaint).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledOnce();
  } finally {
    await f.close();
  }
});

it.each(["cleanup", "original"] as const)(
  "discards only unpublished artifacts after %s failure",
  async (kind) => {
    const f = await imageEditingFixture();
    try {
      const before = await readFile(f.chapterPath),
        plan = await f.preview(brushCommand());
      if (kind === "cleanup")
        f.release.mockRejectedValueOnce(new Error("fixture cleanup failure"));
      else
        f.release.mockImplementationOnce(async () => {
          const page = (await f.snapshot()).pages[0];
          await writeFile(
            page.imagePath,
            Buffer.concat([f.bytes, Buffer.from("external edit")]),
          );
        });
      expect((await f.action(plan.batchId, "apply")).result.status).toBe(
        "failed",
      );
      expect(await readFile(f.chapterPath)).toEqual(before);
      expect(await readdir(join(dirname(f.chapterPath), "inpainted"))).toEqual(
        [],
      );
      expect(await readdir(join(dirname(f.chapterPath), "mask"))).toEqual([]);
      expect(f.release).toHaveBeenCalledOnce();
      expect(f.app.jobs.all).toEqual([]);
    } finally {
      await f.close();
    }
  },
);

it("rejects tampered recovery artifacts without overwriting the current page", async () => {
  const f = await imageEditingFixture();
  try {
    const plan = await f.preview(brushCommand());
    await f.action(plan.batchId, "apply");
    const page = (await f.snapshot()).pages[0];
    if (!page.inpaintMaskPath) throw new Error("Expected mask");
    await writeFile(
      page.inpaintMaskPath,
      Buffer.concat([
        await readFile(page.inpaintMaskPath),
        Buffer.from("tamper"),
      ]),
    );
    const before = await readFile(f.chapterPath);
    expect((await f.action(plan.batchId, "undo")).result.status).toBe("failed");
    expect(await readFile(f.chapterPath)).toEqual(before);
  } finally {
    await f.close();
  }
});
