import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { nativeOutputSyncFixture } from "./mcpNativeOutputSync.fixture";

describe("MCP output-sync admission and settlement authority", () => {
  it("requires explicit scopes, acknowledgement and exact reviewed page order before starting a job", async () => {
    const f = await nativeOutputSyncFixture();
    try {
      f.selection.pageIds.push(f.secondPageId);
      const request = f.request(await f.preflight());
      const start = vi.spyOn(f.current().operations, "start");
      await expect(
        f.invoke("carrot_sync_output", request, {
          principalId: f.owner,
          assertAuthorized: () => undefined,
        }),
      ).rejects.toThrow();
      await expect(
        f.invoke("carrot_sync_output", request, {
          principalId: f.owner,
          assertAuthorized: () => undefined,
          assertScopes: () => undefined,
        }),
      ).rejects.toThrow();
      await expect(
        f.invoke("carrot_sync_output", {
          ...request,
          acknowledgeSavedTextMirror: false,
        }),
      ).rejects.toThrow();
      await expect(
        f.invoke("carrot_sync_output", {
          ...request,
          destinationPath: f.output,
        }),
      ).rejects.toThrow();
      await expect(
        f.invoke("carrot_sync_output", {
          ...request,
          pageIds: [...request.pageIds].reverse(),
        }),
      ).rejects.toMatchObject({ code: "revision_conflict" });
      expect(start).not.toHaveBeenCalled();
      expect(f.renderPage).not.toHaveBeenCalled();
      const read = f.auth();
      await f.invoke(
        "carrot_get_output_destination",
        { chapterId: f.chapter.id },
        read,
      );
      expect(read.assertScopes).toHaveBeenCalledWith(["carrot.read"]);
      const images = f.auth();
      await f.invoke("carrot_preflight_output_sync", f.selection, images);
      expect(images.assertScopes).toHaveBeenCalledWith([
        "carrot.read",
        "carrot.images",
      ]);
      f.preferences.allowImages = false;
      await f.restart();
      expect(
        f
          .current()
          .session.tools.map((tool) => tool.name)
          .sort(),
      ).toEqual(["carrot_get_output_destination", "carrot_get_output_sync"]);
    } finally {
      await f.close();
    }
  });

  it("rechecks image redaction after durable intent admission and before the external OS attempt", async () => {
    const f = await nativeOutputSyncFixture();
    try {
      const request = f.request(await f.preflight());
      const stage = f.current().storage.stageRecord.bind(f.current().storage);
      let redacted = false;
      vi.spyOn(f.current().storage, "stageRecord").mockImplementation(
        async (...args) => {
          await stage(...args);
          if (!redacted) {
            redacted = true;
            await f.redaction(true);
          }
        },
      );
      const start = await f.start(request);
      expect(await f.wait(start.jobId)).toMatchObject({ status: "failed" });
      const view = await f.receipt(request.requestId);
      expect(view.receipt).toMatchObject({
        publishedBytes: 0,
        reportedPublishedBytes: 0,
        publicationUnconfirmed: 1,
        errorCode: "receipt_failed",
      });
      const privateInput = await f
        .current()
        .repository.inspectEvidenceInput(
          f.owner,
          view.receipt.id,
          () => undefined,
        );
      expect(privateInput.targets).toHaveLength(1);
      const target = privateInput.targets[0]?.relativePath;
      if (!target) throw new Error("Expected admitted result allocation");
      await expect(readFile(join(f.output, target))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(view.evidence?.files[0]?.currentState).toBe("missing");
      expect(f.renderPage).toHaveBeenCalledTimes(1);
      expect(f.current().repository.isActive(view.receipt.id)).toBe(false);
    } finally {
      await f.redaction(false);
      await f.close();
    }
  });

  it("settles an admitted physical effect after authorization is revoked and permits no subsequent write", async () => {
    const f = await nativeOutputSyncFixture();
    try {
      const request = f.request(await f.preflight());
      const stage = f.current().storage.stageRecord.bind(f.current().storage);
      let calls = 0;
      vi.spyOn(f.current().storage, "stageRecord").mockImplementation(
        async (...args) => {
          if (++calls === 2) f.revoke();
          return stage(...args);
        },
      );
      const start = await f.start(request);
      expect(await f.wait(start.jobId)).toMatchObject({
        status: "partial",
        result: { status: "partial" },
      });
      const receipt = await f
        .current()
        .repository.inspect(
          f.owner,
          { requestId: request.requestId },
          () => undefined,
        );
      expect(receipt).toMatchObject({
        status: "partial",
        publicationUnconfirmed: 0,
        publishedBytes: Buffer.byteLength(`native-output:${f.selectedPageId}`),
        metadata: "pending",
        mirror: "pending",
      });
      expect(
        receipt.files.filter((file) => file.state === "published"),
      ).toHaveLength(1);
      expect(
        receipt.files.find(
          (file) => file.fileId === `result:${f.selectedPageId}:publish`,
        )?.state,
      ).toBe("published");
      expect(
        (
          await f
            .current()
            .repository.inspectEvidenceInput(
              f.owner,
              receipt.id,
              () => undefined,
            )
        ).targets,
      ).toHaveLength(1);
      await expect(f.receipt(request.requestId)).rejects.toThrow(
        "authorization revoked",
      );
      expect(f.renderPage).toHaveBeenCalledTimes(1);
      expect(f.rendererClose).toHaveBeenCalledTimes(1);
    } finally {
      await f.close();
    }
  });
});
