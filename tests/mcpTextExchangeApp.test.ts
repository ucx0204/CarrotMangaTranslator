import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { textExchangeAppFixture } from "./mcpTextExchange.fixture";
import { retentionFixture } from "./mcpRetention.fixture";
import {
  buildReviewRows,
  serializeReviewRows,
} from "../src/shared/reviewTable";
import { mcpContextRevision } from "../src/shared/mcpContextEditing";
import { mcpFileUploadOutputs } from "../src/shared/mcpFileUploads";
import { mcpTextExchangeOutputs } from "../src/shared/mcpTextExchange";
import { capturePageRecovery } from "../src/shared/pageRecoverySnapshot";
import type { LibraryChapter } from "../src/shared/libraryTypes";
import type { TranslationBlock } from "../src/shared/textTypes";

it.each(["txt", "csv", "tsv"] as const)(
  "keeps the %s upload leased through real page handoff and terminal batch completion",
  async (format) => {
    const f = await textExchangeAppFixture();
    const pause = f.pauseWritable("page");
    try {
      const before = await f.snapshot();
      const sourceBytes = await readFile(before.pages[0].imagePath);
      const chapterBytes = await readFile(f.chapterPath);
      const { preview, uploaded } = await f.prepareImport(format);
      expect(preview.application).toBe("page-by-page");
      expect(preview.totalChanges).toBe(2);
      expect(await readFile(f.chapterPath)).toEqual(chapterBytes);
      expect(f.handoffPages).toEqual([]);
      const accepted = await f.apply(preview.batchId);
      await pause.reached;
      expect(f.handoffPages).toEqual(["page"]);
      expect(f.operations.status(accepted.jobId, f.owner).status).toBe(
        "running",
      );
      expect(() =>
        f.uploads.discard(f.owner, uploaded.uploadId, f.guard),
      ).toThrow("Upload is in use");
      expect(await readFile(f.chapterPath)).toEqual(chapterBytes);
      pause.release();
      expect((await f.done(accepted.jobId)).status).toBe("completed");
      const view = await f.inspect(preview.batchId);
      expect(view.pages.map((page) => page.result)).toEqual(["saved", "saved"]);
      const after = await f.snapshot();
      for (const [index, page] of after.pages.entries()) {
        const block = page.blocks.find((item) => item.id === "a");
        const original = before.pages[index].blocks.find(
          (item) => item.id === "a",
        );
        if (!block || !original)
          throw new Error("Expected the reviewed fixture block.");
        expect(protectedFields(block)).toEqual(protectedFields(original));
        expect(page.blocks.find((item) => item.id === "b")).toEqual(
          before.pages[index].blocks.find((item) => item.id === "b"),
        );
        expect(page.blockOrder).toEqual(before.pages[index].blockOrder);
        if (format === "txt")
          expect(block).toEqual({ ...original, translatedText: "imported-a" });
        else
          expect(block).toMatchObject({
            sourceText: `source from file: ${page.id}`,
            translatedText: ` =SUM(1,2)\r\n"literal" ${page.id} `,
            reviewStatus: "reviewed",
            reviewNote: ` note\t${page.id} `,
          });
      }
      expect(await readFile(after.pages[0].imagePath)).toEqual(sourceBytes);
      expect(
        await f.uploads.discard(f.owner, uploaded.uploadId, f.guard),
      ).toMatchObject({ discarded: true });
      expect(f.handoffPages).toEqual(["page", "second"]);
      expect(f.app.jobs.all).toEqual([]);
      expect(f.prepare).not.toHaveBeenCalled();
      expect(f.errors).toEqual([]);
    } finally {
      pause.release();
      await f.close();
    }
  },
);

it.each(["cancel", "failure"] as const)(
  "preserves page one after a native second-page %s and releases the upload only when settled",
  async (mode) => {
    const f = await textExchangeAppFixture();
    const pause = f.pauseWritable("second");
    try {
      const before = await f.snapshot();
      const { preview, uploaded } = await f.prepareImport();
      const accepted = await f.apply(preview.batchId);
      await pause.reached;
      expect((await f.snapshot()).pages[0].blocks[0].sourceText).toBe(
        "source from file: page",
      );
      expect(() =>
        f.uploads.discard(f.owner, uploaded.uploadId, f.guard),
      ).toThrow("Upload is in use");
      if (mode === "cancel") await f.operations.cancel(accepted.jobId, f.owner);
      else
        f.assertWritable.mockImplementation(async () => {
          throw new Error("Renderer refused page write");
        });
      pause.release();
      const done = await f.done(accepted.jobId);
      expect(done.status).toBe(mode === "cancel" ? "cancelled" : "partial");
      const view = await f.inspect(preview.batchId);
      expect(view.status).toBe("partial");
      expect(view.cancellationRequested).toBe(mode === "cancel");
      expect(view.pages[0].result).toBe("saved");
      expect(view.pages[1].result).toBe(
        mode === "cancel" ? "cancelled" : "failed",
      );
      const after = await f.snapshot();
      expect(after.pages[1]).toEqual(before.pages[1]);
      expect(after.pages[0].blocks[0].translatedText).toContain("literal");
      expect(protectedFields(after.pages[0].blocks[0])).toEqual(
        protectedFields(before.pages[0].blocks[0]),
      );
      expect(
        await f.uploads.discard(f.owner, uploaded.uploadId, f.guard),
      ).toMatchObject({ discarded: true });
      expect(f.app.jobs.all).toEqual([]);
    } finally {
      pause.release();
      await f.close();
    }
  },
);

it("rejects a saved-name change after preview before any page handoff or write", async () => {
  const f = await textExchangeAppFixture();
  try {
    const { preview } = await f.prepareImport();
    const stored: LibraryChapter = JSON.parse(
      await readFile(f.chapterPath, "utf8"),
    );
    stored.pages[0].name = "renamed-after-review.png";
    await writeFile(f.chapterPath, JSON.stringify(stored));
    const before = await readFile(f.chapterPath);
    const accepted = await f.apply(preview.batchId);
    expect(await f.done(accepted.jobId)).toMatchObject({
      status: "failed",
      error: { code: "revision_conflict" },
    });
    expect(await readFile(f.chapterPath)).toEqual(before);
    expect(f.handoffPages).toEqual([]);
    expect(
      (await f.inspect(preview.batchId)).pages.map((page) => page.result),
    ).toEqual(["not_started", "not_started"]);
  } finally {
    await f.close();
  }
});

it("keeps actual saved page outcomes when uploaded bytes fail the completion check", async () => {
  const f = await textExchangeAppFixture();
  const pause = f.pauseWritable("page");
  try {
    const { preview, uploaded } = await f.prepareImport();
    const accepted = await f.apply(preview.batchId);
    await pause.reached;
    await f.uploads.withFile(
      f.owner,
      uploaded.uploadId,
      f.guard,
      async (asset) => {
        const changed = Buffer.from(uploaded.bytes);
        changed[changed.length - 1] ^= 1;
        await writeFile(asset.path, changed);
      },
    );
    pause.release();
    const done = await f.done(accepted.jobId);
    expect(done.status).toBe("partial");
    expect(done.result).toMatchObject({
      status: "partial",
      completionCheck: { status: "failed" },
    });
    const view = await f.inspect(preview.batchId);
    expect(view.status).toBe("completed");
    expect(view.pages.map((page) => page.result)).toEqual(["saved", "saved"]);
    expect(
      (await f.snapshot()).pages.map((page) => page.blocks[0].sourceText),
    ).toEqual(["source from file: page", "source from file: second"]);
    expect(
      await f.uploads.discard(f.owner, uploaded.uploadId, f.guard),
    ).toMatchObject({ discarded: true });
  } finally {
    pause.release();
    await f.close();
  }
});

it("retains four-field native CSV edits for restart Undo/Redo and replays the settled job without its upload", async () => {
  const f = await retentionFixture({ durableJobs: true });
  try {
    const saved = await f.library.readWorkContextForEdit("chapter");
    const before = capturePageRecovery(saved.chapter.pages[0]);
    const image = await readFile(saved.chapter.pages[0].imagePath);
    const source = mcpTextExchangeOutputs.carrot_preflight_text_export.parse(
      (
        await f.invoke("carrot_preflight_text_export", {
          chapterId: "chapter",
          pageIds: ["page"],
          options: { format: "csv", includeBom: true },
        })
      ).structuredContent,
    );
    const rows = buildReviewRows(
      saved.chapter,
      source.binding.direction,
      new Set(["page"]),
    );
    const row = rows.find((item) => item.block_id === "a");
    if (!row) throw new Error("Expected the reviewed fixture row.");
    Object.assign(row, {
      source_text: "edited source",
      translated_text: ' =literal,"quoted"\r\ntranslation ',
      review_status: "reviewed",
      review_note: " note\twith spaces ",
    });
    const uploaded = await uploadRetainedText(
      f,
      serializeReviewRows(rows, "csv", true),
    );
    const plan = mcpTextExchangeOutputs.carrot_preview_text_file_import.parse(
      (
        await f.invoke("carrot_preview_text_file_import", {
          source: source.binding,
          uploadId: uploaded.uploadId,
          sha256: uploaded.sha256,
          contextRevision: mcpContextRevision(saved),
          requestId: randomUUID(),
          reason: "Review four text fields",
          selection: [{ pageId: "page", blockIds: ["a"] }],
          updateSourceText: true,
          requireSourceMatch: false,
        })
      ).structuredContent,
    );
    expect(capturePageRecovery((await f.snapshot()).pages[0])).toEqual(before);
    const action = {
      batchId: plan.batchId,
      requestId: randomUUID(),
      acknowledgePageByPage: true,
    };
    const done = await applyRetainedText(f, action);
    expect(done.status).toBe("completed");
    expect(done.persistence).toBe("durable");
    const afterPage = (await f.snapshot()).pages[0];
    const after = capturePageRecovery(afterPage);
    expect(afterPage.blocks[0]).toMatchObject({
      sourceText: row.source_text,
      translatedText: row.translated_text,
      reviewStatus: row.review_status,
      reviewNote: row.review_note,
    });
    expect(protectedFields(afterPage.blocks[0])).toEqual(
      protectedFields(saved.chapter.pages[0].blocks[0]),
    );
    const changes = await f.list();
    expect(changes.total).toBe(1);
    const id = changes.items[0].id;
    await f.invoke("carrot_discard_file_upload", {
      uploadId: uploaded.uploadId,
    });
    await f.restart();
    const replay = await applyRetainedText(f, action);
    expect(replay.jobId).toBe(done.jobId);
    expect(replay.persistence).toBe("durable");
    expect(replay.status).toBe("completed");
    expect(replay.result).toEqual(done.result);
    expect((await f.list()).total).toBe(1);
    expect((await f.recover(id, "undo")).status).toBe("saved");
    expect(capturePageRecovery((await f.snapshot()).pages[0])).toEqual(before);
    await f.restart();
    expect((await f.recover(id, "redo")).status).toBe("saved");
    expect(capturePageRecovery((await f.snapshot()).pages[0])).toEqual(after);
    expect(await readFile(afterPage.imagePath)).toEqual(image);
    expect(f.acquireEngine).not.toHaveBeenCalled();
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.app.jobs.all).toEqual([]);
  } finally {
    await f.close();
  }
});

function protectedFields(block: TranslationBlock) {
  const {
    sourceText: _source,
    translatedText: _translation,
    reviewStatus: _status,
    reviewNote: _note,
    ...protectedValue
  } = block;
  return protectedValue;
}

async function uploadRetainedText(
  f: Awaited<ReturnType<typeof retentionFixture>>,
  content: string,
) {
  const bytes = Buffer.from(content, "utf8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const uploaded = mcpFileUploadOutputs.carrot_begin_file_upload.parse(
    (
      await f.invoke("carrot_begin_file_upload", {
        requestId: randomUUID(),
        filename: "review.csv",
        bytes: bytes.length,
        sha256,
      })
    ).structuredContent,
  );
  await f.invoke("carrot_write_file_upload", {
    uploadId: uploaded.uploadId,
    offset: 0,
    data: bytes.toString("base64"),
  });
  await f.invoke("carrot_finish_file_upload", { uploadId: uploaded.uploadId });
  return { uploadId: uploaded.uploadId, sha256 };
}

async function applyRetainedText(
  f: Awaited<ReturnType<typeof retentionFixture>>,
  action: object,
) {
  const { mcpJobReceiptOutput } =
    await import("../src/main/mcp/mcpJobOutputSchema");
  const accepted = mcpJobReceiptOutput.parse(
    (await f.invoke("carrot_apply_text_file_import", action)).structuredContent,
  );
  const inspect = async () =>
    mcpJobReceiptOutput.parse(
      (await f.invoke("carrot_get_job", { jobId: accepted.jobId }))
        .structuredContent,
    );
  // The full-session fixture exposes only transport tools. Match its existing
  // explicit bounded native wait; direct application tests await done promises.
  await vi.waitFor(
    async () => {
      expect((await inspect()).status).not.toBe("running");
    },
    { timeout: 10000 },
  );
  return inspect();
}
