import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { workflowFixture } from "./mcpWorkflow.fixture";

it("rejects output publication if retention expires during the native renderer boundary", async () => {
  let now = Date.now();
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  const f = await workflowFixture();
  try {
    const before = await readFile(f.chapterPath);
    const png = await readFile(
      (await f.library.openChapter("chapter")).pages[0].imagePath,
    );
    f.render.mockImplementation(async () => {
      now += 8 * 24 * 60 * 60_000;
      return png;
    });
    const plan = await f.prepare([{ kind: "export-png" }]);
    await f.run(plan.id);
    await vi.waitFor(() => expect(f.render).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(f.errors.length).toBeGreaterThan(0));
    await expect(f.get(plan.id)).rejects.toThrow();
    expect(
      (await f.storage.index()).entries.filter(
        (entry) => entry.kind === "output",
      ),
    ).toEqual([]);
    expect(await readFile(f.chapterPath)).toEqual(before);
    expect(f.request).not.toHaveBeenCalled();
  } finally {
    await f.close();
    clock.mockRestore();
  }
});

it("recognizes a committed translation despite notification failure and never repeats it on resume", async () => {
  const f = await workflowFixture();
  try {
    const before = await f.library.openChapter("chapter");
    f.editing.notifySaved.mockImplementationOnce(() => {
      throw new Error("Synthetic renderer notification failure after save");
    });
    const prepared = await f.prepare();
    await f.run(prepared.id);
    const stopped = await f.done(prepared.id);
    expect(stopped.status).toBe("failed");
    expect(stopped.steps[0]).toMatchObject({
      status: "completed",
      outcome: "reconciled_native_receipt",
    });
    expect(stopped.steps[0].changeId).toBeTruthy();
    const saved = await f.library.openChapter("chapter");
    expect(saved.pages[0].blocks[0].translatedText).not.toBe(
      before.pages[0].blocks[0].translatedText,
    );
    expect(saved.pages[1].blocks).toEqual(before.pages[1].blocks);
    const alreadyCalled = f.request.mock.calls.length;
    await f.restart();
    await f.run(prepared.id);
    expect((await f.done(prepared.id)).status).toBe("completed");
    expect(f.request.mock.calls.length - alreadyCalled).toBe(
      before.pages[1].blocks.length,
    );
    expect((await f.library.openChapter("chapter")).pages[0].blocks).toEqual(
      saved.pages[0].blocks,
    );
  } finally {
    await f.close();
  }
});
