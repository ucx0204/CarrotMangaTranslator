import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { nativeOutputSyncFixture } from "./mcpNativeOutputSync.fixture";

describe("MCP native output synchronization", () => {
  it("uses actual app handoff, native writers and encrypted receipts for the complete mirror scope", async () => {
    const f = await nativeOutputSyncFixture();
    try {
      const queue = await f.queue();
      const review = await f.preflight();
      expect(review.mirrorScope).toMatchObject({
        pageCount: 2,
        chapters: [{ chapterId: f.chapter.id, pageIds: f.chapter.pageOrder }],
      });
      const request = f.request(review);
      const start = await f.start(request);
      const completed = await f.wait(start.jobId);
      const view = await f.receipt(request.requestId);
      expect(completed).toMatchObject({
        kind: "outputSync",
        status: "completed",
        result: {
          kind: "output-sync",
          status: "completed",
          outputSync: {
            receiptId: view.receipt.id,
            requestId: request.requestId,
            jobId: start.jobId,
          },
        },
      });
      expect(view.receipt).toMatchObject({
        status: "completed",
        publicationUnconfirmed: 0,
        metadata: "published",
        mirror: "published",
        sourceChecked: false,
      });
      expect(view.receipt.publishedBytes).toBe(
        view.receipt.reportedPublishedBytes,
      );
      expect(view.receipt.publishedBytes).toBeGreaterThan(0);
      expect(f.retained.handoffPages).toEqual(f.chapter.pageOrder);
      expect(f.retained.editing.assertWritable.mock.calls).toEqual([
        [f.chapter.id, f.selectedPageId],
        [f.chapter.id, f.secondPageId],
      ]);
      expect(f.renderPage).toHaveBeenCalledTimes(1);
      expect(f.rendererClose).toHaveBeenCalledTimes(1);
      expect(f.retained.app.jobs.all).toEqual([]);
      expect(await f.queue()).toBe(queue);
      const expected = createHash("sha256")
        .update(`native-output:${f.selectedPageId}`)
        .digest("hex");
      expect(view.evidence).toMatchObject({
        destination: "matched",
        sourceChecked: false,
      });
      expect(
        view.evidence?.files.find(
          (file) => file.fileId === `result:${f.selectedPageId}:publish`,
        ),
      ).toMatchObject({ currentState: "matches_planned", sha256: expected });
      const privateInput = await f
        .current()
        .repository.inspectEvidenceInput(
          f.owner,
          view.receipt.id,
          () => undefined,
        );
      const result = privateInput.targets.find(
        (file) => file.fileId === `result:${f.selectedPageId}:publish`,
      );
      if (!result?.relativePath)
        throw new Error("Expected owned output allocation");
      expect(await readFile(join(f.output, result.relativePath), "utf8")).toBe(
        `native-output:${f.selectedPageId}`,
      );
      const encoded = JSON.stringify({ review, start, completed, view });
      for (const secret of [
        f.output,
        f.retained.env.root,
        "relativePath",
        "data:image",
        "file://",
        "http://",
      ])
        expect(encoded).not.toContain(secret);
      expect(
        await readFile(await f.current().storage.path(view.receipt.id), "utf8"),
      ).not.toContain("relativePath");
      const diagnosis = await f
        .current()
        .session.diagnose(f.owner, view.receipt.id, () => undefined);
      expect(diagnosis).toMatchObject({
        generation: { status: "completed", jobId: start.jobId },
        retention: { source: "not_checked" },
        destinationPublication: { receiptId: view.receipt.id },
      });
      const serialized = JSON.stringify(diagnosis);
      for (const privateField of [
        "Snapshot",
        "relativePath",
        f.output,
        "http://",
        "file://",
      ])
        expect(serialized).not.toContain(privateField);
    } finally {
      await f.close();
    }
  });

  it("returns the original retained job after restart and connection removal without fresh preflight or execution", async () => {
    const f = await nativeOutputSyncFixture();
    try {
      const request = f.request(await f.preflight());
      const original = await f.start(request);
      await f.wait(original.jobId);
      const receipt = (await f.receipt(request.requestId)).receipt;
      await f.restart();
      expect(await f.native.disconnect(request.connectionId)).toBe(true);
      const preflight = vi.spyOn(f.native.reviewedOutput, "preflight");
      const execute = vi.spyOn(f.native.reviewedOutput, "execute");
      const start = vi.spyOn(f.current().operations, "start");
      const historical = await f.start(request);
      expect(historical).toMatchObject({
        jobId: original.jobId,
        requestId: request.requestId,
        status: "completed",
        persistence: "durable",
        result: {
          outputSync: { receiptId: receipt.id, jobId: original.jobId },
        },
      });
      expect(preflight).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
      expect(f.renderPage).toHaveBeenCalledTimes(1);
      const current = await f.receipt(request.requestId);
      expect(current.receipt).toMatchObject({
        id: receipt.id,
        status: "completed",
        historical: true,
      });
      expect(current.evidence?.destination).toBe("unavailable");
      expect(
        current.evidence?.files.every(
          (file) => file.currentState === "unavailable",
        ),
      ).toBe(true);
    } finally {
      await f.close();
    }
  });

  it("returns an active historical receipt with its original job identity and no terminal result", async () => {
    const f = await nativeOutputSyncFixture();
    let finish: (() => Promise<unknown>) | undefined;
    try {
      const review = await f.preflight();
      const request = f.request(review);
      const jobId = randomUUID();
      const admitted = await f
        .current()
        .repository.begin(f.owner, { request, jobId }, review, () => undefined);
      if (!admitted.session)
        throw new Error("Expected new durable receipt session");
      const session = admitted.session;
      finish = () => session.fail("publication_failed", true);
      const preflight = vi.spyOn(f.native.reviewedOutput, "preflight");
      const start = vi.spyOn(f.current().operations, "start");
      const historical = await f.start(request);
      expect(historical).toMatchObject({
        jobId,
        requestId: request.requestId,
        status: "running",
      });
      expect(historical.result).toBeUndefined();
      expect(preflight).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
      expect(f.renderPage).not.toHaveBeenCalled();
    } finally {
      await finish?.();
      await f.close();
    }
  });
});
