import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { letteringAppFixture } from "./mcpLetteringApp.fixture";
import { parseRichText } from "../src/shared/richTextMarkup";
import { createConditionalLiteralMatcher } from "../src/shared/conditionalTextPattern";

const geometry = {
  kind: "layout",
  mode: "geometry",
  allowAssetDownloads: true,
};
function requireBatch(
  result: Awaited<
    ReturnType<Awaited<ReturnType<typeof letteringAppFixture>>["prepare"]>
  >,
) {
  expect(result.job.status).toBe("completed");
  if (!result.batchId) throw new Error(JSON.stringify(result.job));
  return result.batchId;
}

it("runs native geometry patching only, publishes after cleanup, then applies and exactly undoes", async () => {
  const f = await letteringAppFixture();
  const originalFile = await readFile(f.chapterPath);
  const before = await f.library.openChapter("chapter");
  try {
    const result = await f.prepare(geometry),
      batchId = requireBatch(result);
    expect(f.runtime.create).toHaveBeenCalledOnce();
    expect(f.runPage).toHaveBeenCalledTimes(2);
    expect(f.runtime.dispose).toHaveBeenCalledOnce();
    expect(await readFile(f.chapterPath)).toEqual(originalFile);
    expect(f.app.jobs.all).toEqual([]);
    expect(f.app.jobs.pageHandoffs.activities).toEqual([]);
    expect((await f.action(batchId, "apply")).status).toBe("completed");
    const after = await f.library.openChapter("chapter");
    expect(after.pages[0].blocks[0].bubbleLayout?.origin).toBe("detected");
    expect(after.pages[0].blocks[0].fontSizePx).toBe(
      before.pages[0].blocks[0].fontSizePx,
    );
    expect(after.pages[0].blocks[0].translatedText).toBe(
      before.pages[0].blocks[0].translatedText,
    );
    expect(after.pages[0].blocks[1]).toEqual(before.pages[0].blocks[1]);
    expect((await f.action(batchId, "undo")).status).toBe("completed");
    const undone = await f.library.openChapter("chapter");
    expect(undone.pages.map((page) => page.blocks)).toEqual(
      before.pages.map((page) => page.blocks),
    );
    expect((await f.action(batchId, "redo")).status).toBe("completed");
    for (const page of before.pages)
      expect(await readFile(page.imagePath)).toEqual(f.bytes);
    expect(f.errors).toEqual([]);
  } finally {
    await f.close();
  }
});

it("wraps with the app's natural layout and never starts a model", async () => {
  const f = await letteringAppFixture();
  const before = await f.library.openChapter("chapter");
  try {
    const result = await f.prepare({ kind: "layout", mode: "wrap" });
    const id = requireBatch(result);
    const plan = await f.invoke("carrot_get_lettering_batch", { batchId: id });
    expect(f.runPage).not.toHaveBeenCalled();
    expect(f.runtime.create).not.toHaveBeenCalled();
    expect(f.runtime.dispose).not.toHaveBeenCalled();
    if (plan.canApply)
      expect((await f.action(id, "apply")).status).toBe("completed");
    const after = await f.library.openChapter("chapter");
    expect(
      parseRichText(after.pages[0].blocks[0].translatedText).plainText.replace(
        /\s/gu,
        "",
      ),
    ).toBe(
      parseRichText(before.pages[0].blocks[0].translatedText).plainText.replace(
        /\s/gu,
        "",
      ),
    );
    expect(after.pages[0].blocks[0].fontSizePx).toBe(
      before.pages[0].blocks[0].fontSizePx,
    );
  } finally {
    await f.close();
  }
});

it("applies glow and a literal rich-text style rule through the real page transaction", async () => {
  const f = await letteringAppFixture();
  const before = await f.library.openChapter("chapter");
  try {
    const first = await f.prepare({
      kind: "format",
      advanced: {
        textGlow: { enabled: true, color: "#fedcba", blurPx: 6, opacity: 0.8 },
      },
    });
    expect((await f.action(requireBatch(first), "apply")).status).toBe(
      "completed",
    );
    const text = before.pages[0].blocks[0].translatedText;
    const scheme = {
      name: "Emphasis",
      match: { mode: "allBlocks" },
      actions: [
        {
          id: "emphasis",
          enabled: true,
          type: "styleText",
          scope: "pattern",
          matcher: createConditionalLiteralMatcher(text),
          styleMode: "overwrite",
          patch: { bold: true },
        },
      ],
    };
    const second = await f.prepare({
      kind: "rule",
      schemeJson: JSON.stringify(scheme),
    });
    const id = requireBatch(second);
    const plan = await f.invoke("carrot_get_lettering_batch", { batchId: id });
    if (plan.canApply)
      expect((await f.action(id, "apply")).status).toBe("completed");
    const after = await f.library.openChapter("chapter");
    expect(
      parseRichText(after.pages[0].blocks[0].translatedText).plainText,
    ).toBe(parseRichText(text).plainText);
    expect(after.pages[0].blocks[0].textGlow?.blurPx).toBe(6);
    expect(f.runPage).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it("rejects missing geometry permission before model creation or downloads", async () => {
  const f = await letteringAppFixture();
  const before = await readFile(f.chapterPath);
  try {
    const result = await f.prepare({ ...geometry, allowAssetDownloads: false });
    expect(result.job.status).toBe("failed");
    expect(result.job.error?.code).toBe("invalid_edit");
    expect(result.batchId).toBeUndefined();
    expect(f.runtime.create).not.toHaveBeenCalled();
    expect(await readFile(f.chapterPath)).toEqual(before);
  } finally {
    await f.close();
  }
});

it("rejects changed original bytes before forward save but permits exact undo with an unusable source", async () => {
  const f = await letteringAppFixture();
  const before = await readFile(f.chapterPath);
  try {
    const first = await f.prepare(geometry),
      id = requireBatch(first);
    const bytes = Buffer.from(f.bytes);
    bytes[bytes.length - 5] ^= 1;
    await writeFile(f.chapter.pages[0].imagePath, bytes);
    expect((await f.action(id, "apply")).status).toBe("failed");
    expect(await readFile(f.chapterPath)).toEqual(before);
    await writeFile(f.chapter.pages[0].imagePath, f.bytes);
    const second = await f.prepare(geometry),
      next = requireBatch(second);
    expect((await f.action(next, "apply")).status).toBe("completed");
    await writeFile(f.chapter.pages[0].imagePath, "not an image");
    expect((await f.action(next, "undo")).status).toBe("completed");
    expect((await f.action(next, "redo")).status).toBe("failed");
  } finally {
    await f.close();
  }
});

it("waits for model cleanup on cancellation and never exposes a cancelled plan", async () => {
  const f = await letteringAppFixture();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let enterCleanup!: () => void;
  const cleanupStarted = new Promise<void>((resolve) => {
    enterCleanup = resolve;
  });
  f.runtime.dispose.mockImplementationOnce(() => {
    enterCleanup();
    return pending;
  });
  try {
    const receipt = await f.invoke(
      "carrot_prepare_lettering_batch",
      await f.request(geometry),
    );
    const id = String(receipt.jobId);
    const completed = f.settleJob(id);
    await Promise.race([
      cleanupStarted,
      completed.then((job) => {
        throw new Error(
          `Lettering job settled before model cleanup: ${JSON.stringify(job)}`,
        );
      }),
    ]);
    expect(f.runtime.dispose).toHaveBeenCalledOnce();
    await f.operations.cancel(id, f.owner);
    expect(f.operations.status(id, f.owner).status).toBe("running");
    expect(f.app.jobs.all).toHaveLength(1);
    release();
    const result = await completed;
    expect(result.status).toBe("cancelled");
    expect(result.result).toBeUndefined();
    expect(f.app.jobs.all).toEqual([]);
    expect(f.app.jobs.pageHandoffs.activities).toEqual([]);
  } finally {
    release();
    await f.close();
  }
});

it("preserves both inference and cleanup failure and does not offer a successful plan", async () => {
  const f = await letteringAppFixture();
  f.runPage.mockRejectedValueOnce(new Error("detector failed"));
  f.runtime.dispose.mockRejectedValueOnce(new Error("cleanup failed"));
  try {
    const result = await f.prepare(geometry);
    expect(result.job.status).toBe("failed");
    expect(result.batchId).toBeUndefined();
    expect(f.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          errors: expect.arrayContaining([
            expect.objectContaining({ message: "detector failed" }),
            expect.objectContaining({ message: "cleanup failed" }),
          ]),
        }),
      ]),
    );
    expect(f.notifySaved).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it("rejects other-owner plans, duplicate conflicts and later user edits", async () => {
  const f = await letteringAppFixture();
  try {
    const result = await f.prepare({
        kind: "format",
        fields: { italic: true },
      }),
      id = requireBatch(result);
    const replay = await f.invoke(
      "carrot_prepare_lettering_batch",
      result.input,
    );
    expect(replay.jobId).toBe(result.job.jobId);
    await expect(
      f.invoke("carrot_get_lettering_batch", { batchId: id }, "another"),
    ).rejects.toThrow();
    await expect(
      f.invoke("carrot_prepare_lettering_batch", {
        ...result.input,
        reason: "changed",
      }),
    ).rejects.toThrow();
    const changed = JSON.parse(await readFile(f.chapterPath, "utf8"));
    changed.pages[0].blocks[0].translatedText = "user edit";
    await writeFile(f.chapterPath, JSON.stringify(changed));
    expect((await f.action(id, "apply")).status).toBe("failed");
    await expect(
      f.invoke("carrot_get_lettering_batch", { batchId: randomUUID() }),
    ).rejects.toThrow();
  } finally {
    await f.close();
  }
});

it("restores only durable receipts and never rehydrates a session plan or re-executes its job", async () => {
  const f = await letteringAppFixture();
  try {
    const prepared = await f.prepare({
      kind: "format",
      fields: { italic: true },
    });
    requireBatch(prepared);
    await f.operations.close();
    const { McpOperationService } =
      await import("../src/main/application/mcpOperationService");
    const restored = new McpOperationService(
      (error) => f.errors.push(error),
      Date.now,
      f.persistence,
    );
    try {
      await restored.ready();
      const receipt = restored.status(prepared.job.jobId, f.owner);
      expect(receipt.status).toBe("completed");
      expect(receipt.result?.letteringPlan).toBeUndefined();
      expect(receipt.result?.proposalExpired).toBe(true);
      expect(f.notifySaved).not.toHaveBeenCalled();
    } finally {
      await restored.close();
    }
  } finally {
    await f.close();
  }
});

it("fails unavailable font requests rather than silently substituting and requires fresh preparation for retry", async () => {
  const f = await letteringAppFixture();
  const before = await readFile(f.chapterPath);
  try {
    const result = await f.prepare({
      kind: "format",
      fields: { fontFamily: "missing-lettering-font" },
    });
    expect(result.job.status).toBe("failed");
    expect(result.job.error?.code).toBe("invalid_edit");
    expect(() =>
      f.operations.retryTarget(
        result.job.jobId,
        f.owner,
        result.input.pages[0].revision,
      ),
    ).toThrow("single-page retry");
    expect(result.batchId).toBeUndefined();
    expect(await readFile(f.chapterPath)).toEqual(before);
    expect(f.runtime.create).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it("preserves manual bubble geometry and explicit line breaks by default", async () => {
  const f = await letteringAppFixture();
  const stored = JSON.parse(await readFile(f.chapterPath, "utf8"));
  const manual = {
    version: 1,
    direction: "horizontal",
    origin: "manual",
    confidence: 1,
    insetRatio: 0,
    regions: [
      { spans: [{ blockStart: 0, blockEnd: 1, inlineStart: 0, inlineEnd: 1 }] },
    ],
  };
  stored.pages[0].blocks[0].bubbleLayout = manual;
  stored.pages[0].blocks[0].translatedText = "Keep these\nexplicit breaks";
  stored.pages[1].blocks[0].translatedText = "Keep these\nexplicit breaks";
  await writeFile(f.chapterPath, JSON.stringify(stored));
  const before = await f.library.openChapter("chapter");
  try {
    const result = await f.prepare(geometry),
      id = requireBatch(result);
    const inspected = await f.invoke("carrot_get_lettering_batch", {
      batchId: id,
    });
    expect(inspected.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pageId: "page",
          excludedReason: "manual_layout_preserved",
        }),
      ]),
    );
    expect(f.runPage).toHaveBeenCalledOnce();
    expect((await f.action(id, "apply")).status).toBe("completed");
    const after = await f.library.openChapter("chapter");
    expect(after.pages[0].blocks).toEqual(before.pages[0].blocks);
    const wrap = await f.prepare({ kind: "layout", mode: "wrap" }),
      wrapId = requireBatch(wrap);
    expect(
      (await f.invoke("carrot_get_lettering_batch", { batchId: wrapId }))
        .canApply,
    ).toBe(false);
    expect(
      (await f.library.openChapter("chapter")).pages[1].blocks[0]
        .translatedText,
    ).toBe("Keep these\nexplicit breaks");
  } finally {
    await f.close();
  }
});
