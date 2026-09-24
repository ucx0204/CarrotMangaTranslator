import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { retentionFixture } from "./mcpRetention.fixture";
import { capturePageRecovery } from "../src/shared/pageRecoverySnapshot";
import { createPageRevision } from "../src/shared/pageRevision";
import { mcpContextRevision } from "../src/shared/mcpContextEditing";
import { mcpImageUploadOutputs } from "../src/shared/mcpImageUploads";
import { mcpExternalImageOutputs } from "../src/shared/mcpExternalImages";

it("recovers external image lettering and optional block state after upload and session disposal", async () => {
  const f = await retentionFixture();
  try {
    const saved = await f.library.readWorkContextForEdit("chapter");
    const page = saved.chapter.pages[0];
    const before = capturePageRecovery(page);
    const bytes = await readFile(page.imagePath);
    const binding = {
      chapterId: "chapter",
      pageId: page.id,
      revision: createPageRevision(page),
      contextRevision: mcpContextRevision(saved),
    };
    const upload = mcpImageUploadOutputs.carrot_begin_image_upload.parse(
      (
        await f.invoke("carrot_begin_image_upload", {
          ...binding,
          requestId: randomUUID(),
          purpose: "image",
          mimeType: "image/png",
          width: page.width,
          height: page.height,
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        })
      ).structuredContent,
    );
    await f.invoke("carrot_write_image_upload", {
      uploadId: upload.uploadId,
      offset: 0,
      data: bytes.toString("base64"),
    });
    await f.invoke("carrot_finish_image_upload", { uploadId: upload.uploadId });
    const plan = mcpExternalImageOutputs.carrot_preview_external_image.parse(
      (
        await f.invoke("carrot_preview_external_image", {
          ...binding,
          requestId: randomUUID(),
          reason: "Retain generated lettering independently of uploads",
          command: {
            kind: "lettering",
            imageUploadId: upload.uploadId,
            blockId: page.blocks[0].id,
          },
        })
      ).structuredContent,
    );
    await f.invoke("carrot_apply_external_image", {
      batchId: plan.batchId,
      requestId: randomUUID(),
    });
    await vi.waitFor(async () => {
      const state = mcpExternalImageOutputs.carrot_get_external_image.parse(
        (await f.invoke("carrot_get_external_image", { batchId: plan.batchId }))
          .structuredContent,
      );
      expect(state.status).toBe("completed");
    });
    const after = capturePageRecovery((await f.snapshot()).pages[0]);
    expect(after.blocks[0].generatedLettering).toBeDefined();
    const id = (await f.list()).items[0].id;
    await f.invoke("carrot_discard_image_upload", {
      uploadId: upload.uploadId,
    });
    await f.restart();
    await f.recover(id, "undo");
    expect(capturePageRecovery((await f.snapshot()).pages[0])).toEqual(before);
    await f.restart();
    await f.recover(id, "redo");
    expect(capturePageRecovery((await f.snapshot()).pages[0])).toEqual(after);
    expect(await readFile(page.imagePath)).toEqual(bytes);
    expect(f.acquireEngine).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});
