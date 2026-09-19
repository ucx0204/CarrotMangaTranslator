import { readFile, writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { soundEffectFixture } from "./mcpSoundEffect.fixture";
import { captureSoundEffectPage } from "../src/shared/soundEffectPageSnapshot";
import type { McpSoundEffectPrepare } from "../src/shared/mcpSoundEffects";

function command(
  f: Awaited<ReturnType<typeof soundEffectFixture>>,
  blockIds: string[],
): McpSoundEffectPrepare["command"] {
  return {
    kind: "generate",
    blockIds,
    expectedProvider: "codex",
    expectedModel: f.settings.codex.imageModel,
    allowExternalProcessing: true,
    replaceExisting: false,
    allowRenderAdjustment: true,
    invertColors: false,
  };
}
it("uses native foreground generation without erasure, stores only the reviewed layer and replays exact history without another model", async () => {
  const f = await soundEffectFixture();
  try {
    const before = (await f.snapshot()).pages[0],
      original = await readFile(before.imagePath);
    const plan = await f.preview(command(f, [before.blocks[0].id]));
    const stored = f.service.readOwnedPlan(f.owner, plan.batchId, () => {});
    expect(stored.generationCalls).toBe(1);
    expect(stored.failedItems).toBe(0);
    expect(stored.after.blocks[0].generatedLettering?.dataUrl).toMatch(
      /^data:image\/png;base64,/,
    );
    expect(captureSoundEffectPage((await f.snapshot()).pages[0])).toEqual(
      captureSoundEffectPage(before),
    );
    expect(f.dispose).toHaveBeenCalledTimes(1);
    expect((await f.action(plan.batchId, "apply")).result.status).toBe(
      "completed",
    );
    const after = (await f.snapshot()).pages[0];
    expect(after.blocks[0].sourceText).toBe(before.blocks[0].sourceText);
    expect(after.blocks[0].translatedText).toBe(
      before.blocks[0].translatedText,
    );
    expect(after.blocks[0].bbox).toEqual(before.blocks[0].bbox);
    expect(after.blocks.slice(1)).toEqual(before.blocks.slice(1));
    expect(after.inpaintedImagePath).toBe(before.inpaintedImagePath);
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
    expect(f.turn).toHaveBeenCalledTimes(1);
    expect(f.acquireEngine).not.toHaveBeenCalled();
    expect(f.prepare).not.toHaveBeenCalled();
    expect(await readFile(before.imagePath)).toEqual(original);
  } finally {
    await f.close();
  }
});
it("requires external consent and the exact supported configured controller before starting a client", async () => {
  const f = await soundEffectFixture();
  try {
    const before = await readFile(f.chapterPath),
      page = (await f.snapshot()).pages[0];
    const input = command(f, [page.blocks[0].id]);
    if (input.kind !== "generate")
      throw new Error("Expected generation test input");
    await expect(
      f.preview({ ...input, allowExternalProcessing: false }),
    ).rejects.toThrow("allowExternalProcessing");
    await expect(
      f.preview({ ...input, expectedModel: "different-controller" }),
    ).rejects.toThrow("match");
    await expect(
      f.preview({ ...input, blockIds: [page.blocks[1].id] }),
    ).rejects.toThrow("not dialogue");
    const redaction = await import("../src/main/imageRedactionStore");
    await redaction.setImageRedactionEnabled(true, f.env.root);
    await expect(f.preview(input)).rejects.toThrow("redaction");
    expect(f.startClient).not.toHaveBeenCalled();
    expect(await readFile(f.chapterPath)).toEqual(before);
  } finally {
    await f.close();
  }
});
it("keeps successful generation separate from failed blocks and never parallelizes selected native calls", async () => {
  const f = await soundEffectFixture();
  try {
    const raw = JSON.parse(await readFile(f.chapterPath, "utf8"));
    raw.pages[0].blocks[1].textRole = "sound";
    raw.pages[0].blocks[1].sourceText = "BOOM";
    raw.pages[0].blocks[1].translatedText = "BANG";
    await writeFile(f.chapterPath, JSON.stringify(raw));
    const before = (await f.snapshot()).pages[0];
    f.turn.mockRejectedValueOnce(new Error("synthetic provider failure"));
    const plan = await f.preview(
      command(
        f,
        before.blocks.map((block) => block.id),
      ),
    );
    const evidence = f.service.readOwnedPlan(f.owner, plan.batchId, () => {});
    expect(evidence.generationCalls).toBe(2);
    expect(evidence.failedItems).toBe(1);
    expect(evidence.after.blocks[0].generatedLettering).toBeUndefined();
    expect(evidence.after.blocks[1].generatedLettering).toBeDefined();
    expect(f.startClient).toHaveBeenCalledTimes(1);
    expect(f.turn).toHaveBeenCalledTimes(2);
    expect(f.dispose).toHaveBeenCalledTimes(1);
    expect((await f.action(plan.batchId, "apply")).result.status).toBe(
      "completed",
    );
    expect((await f.snapshot()).pages[0].blocks[0]).toEqual(before.blocks[0]);
  } finally {
    await f.close();
  }
});
it("does not publish a candidate after source mutation during the remote call", async () => {
  const f = await soundEffectFixture();
  try {
    const before = await readFile(f.chapterPath),
      page = (await f.snapshot()).pages[0];
    f.turn.mockImplementationOnce(async () => {
      await writeFile(page.imagePath, Buffer.from("changed-original"));
      throw new Error("synthetic failure after source changed");
    });
    await expect(f.preview(command(f, [page.blocks[0].id]))).rejects.toThrow(
      "changed",
    );
    expect(f.dispose).toHaveBeenCalledTimes(1);
    expect(await readFile(f.chapterPath)).toEqual(before);
    expect(f.editing.notifySaved).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});
it("waits for the active call and cleanup on cancellation without saving or publishing a plan", async () => {
  const f = await soundEffectFixture();
  let release: (() => void) | undefined;
  try {
    const page = (await f.snapshot()).pages[0],
      original = await readFile(f.chapterPath);
    let entered: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.turn.mockImplementationOnce(async () => {
      entered?.();
      await hold;
      throw new Error("call stopped after cancellation");
    });
    const execution = f.preview(command(f, [page.blocks[0].id]));
    const assertion = expect(execution).rejects.toThrow();
    await started;
    f.lifetime.abort();
    expect(f.dispose).not.toHaveBeenCalled();
    if (!release) throw new Error("Expected a pending model transport");
    release();
    await assertion;
    expect(f.dispose).toHaveBeenCalledTimes(1);
    expect(await readFile(f.chapterPath)).toEqual(original);
  } finally {
    release?.();
    await f.close();
  }
});
it("blocks further generation in this session after client cleanup failure", async () => {
  const f = await soundEffectFixture();
  try {
    const page = (await f.snapshot()).pages[0],
      original = await readFile(f.chapterPath);
    f.dispose.mockRejectedValueOnce(
      new Error("synthetic client cleanup failure"),
    );
    await expect(f.preview(command(f, [page.blocks[0].id]))).rejects.toThrow(
      "cleanup failed",
    );
    await expect(f.preview(command(f, [page.blocks[0].id]))).rejects.toThrow(
      "previous image client",
    );
    expect(f.startClient).toHaveBeenCalledTimes(1);
    expect(await readFile(f.chapterPath)).toEqual(original);
  } finally {
    await f.close();
  }
});
