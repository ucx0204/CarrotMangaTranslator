import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  nativeOutputSyncFixture,
  outputSyncDeferred,
} from "./mcpNativeOutputSync.fixture";

describe("MCP native output lifecycle", () => {
  it("waits for the actual renderer and durable cancellation outcome when the session closes", async () => {
    const f = await nativeOutputSyncFixture();
    const entered = outputSyncDeferred();
    const release = outputSyncDeferred();
    f.renderPage.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return Buffer.from("cancelled render");
    });
    try {
      const request = f.request(await f.preflight());
      const start = await f.start(request);
      const done = f.wait(start.jobId);
      await Promise.race([
        entered.promise,
        done.then(() => {
          throw new Error("Job ended before renderer entry");
        }),
      ]);
      let closed = false;
      const closing = f
        .current()
        .session.close()
        .then(() => {
          closed = true;
        });
      await Promise.resolve();
      expect(closed).toBe(false);
      expect(f.cancel).toHaveBeenCalledTimes(1);
      release.resolve();
      expect(await done).toMatchObject({
        status: "cancelled",
        result: { status: "cancelled" },
      });
      await closing;
      expect(closed).toBe(true);
      const receipt = await f
        .current()
        .repository.inspect(
          f.owner,
          { requestId: request.requestId },
          () => undefined,
        );
      expect(receipt).toMatchObject({
        status: "cancelled",
        publishedBytes: 0,
        publicationUnconfirmed: 0,
        metadata: "pending",
        mirror: "pending",
      });
      expect(receipt.files.every((file) => file.state === "planned")).toBe(
        true,
      );
      expect(f.rendererClose).toHaveBeenCalledTimes(1);
      expect(f.retained.app.jobs.all).toEqual([]);
      expect(f.current().repository.isActive(receipt.id)).toBe(false);
    } finally {
      release.resolve();
      await f.close();
    }
  });

  it("retains an unconfirmed publication when the file is written but its effect receipt fails", async () => {
    const f = await nativeOutputSyncFixture();
    try {
      const request = f.request(await f.preflight());
      const stage = f.current().storage.stageRecord.bind(f.current().storage);
      let calls = 0;
      vi.spyOn(f.current().storage, "stageRecord").mockImplementation(
        async (...args) => {
          if (++calls === 2)
            throw new Error("fixture effect receipt disk failure");
          return stage(...args);
        },
      );
      const events = vi.spyOn(f.retained.app.jobs, "updateLastEvent");
      const start = await f.start(request);
      const completed = await f.wait(start.jobId);
      const view = await f.receipt(request.requestId);
      expect(completed).toMatchObject({
        status: "partial",
        result: { status: "partial" },
      });
      expect(view.receipt).toMatchObject({
        status: "partial",
        errorCode: "receipt_failed",
        publishedBytes: 0,
        reportedPublishedBytes: Buffer.byteLength(
          `native-output:${f.selectedPageId}`,
        ),
        publicationUnconfirmed: 1,
      });
      expect(
        view.receipt.files.find(
          (file) => file.fileId === `result:${f.selectedPageId}:publish`,
        ),
      ).toMatchObject({
        state: "publication_unconfirmed",
        bytes: null,
        sha256: null,
      });
      expect(
        view.evidence?.files.find(
          (file) => file.fileId === `result:${f.selectedPageId}:publish`,
        ),
      ).toMatchObject({ currentState: "matches_planned" });
      const input = await f
        .current()
        .repository.inspectEvidenceInput(
          f.owner,
          view.receipt.id,
          () => undefined,
        );
      const target = input.targets[0]?.relativePath;
      if (!target) throw new Error("Expected admitted external target");
      expect(await readFile(join(f.output, target), "utf8")).toBe(
        `native-output:${f.selectedPageId}`,
      );
      expect(events.mock.calls.at(-1)?.[1].status).toBe("failed");
      expect(f.reportError).toHaveBeenCalled();
      expect(f.rendererClose).toHaveBeenCalledTimes(1);
      const historical = await f.start(request);
      expect(historical.jobId).toBe(start.jobId);
      expect(f.renderPage).toHaveBeenCalledTimes(1);
      expect(f.current().repository.isActive(view.receipt.id)).toBe(false);
    } finally {
      await f.close();
    }
  });

  it("reports the original renderer cleanup failure while preserving all already published effects", async () => {
    const f = await nativeOutputSyncFixture();
    const failure = new Error("fixture renderer close failed");
    f.rendererClose.mockImplementationOnce(() => {
      throw failure;
    });
    try {
      const request = f.request(await f.preflight());
      const events = vi.spyOn(f.retained.app.jobs, "updateLastEvent");
      const start = await f.start(request);
      expect(await f.wait(start.jobId)).toMatchObject({
        status: "partial",
        result: { status: "partial" },
      });
      expect((await f.receipt(request.requestId)).receipt).toMatchObject({
        status: "partial",
        metadata: "published",
        mirror: "published",
        publicationUnconfirmed: 0,
      });
      expect(
        f.reportError.mock.calls.some(
          ([error]) =>
            error instanceof AggregateError && error.errors.includes(failure),
        ),
      ).toBe(true);
      expect(events.mock.calls.at(-1)?.[1].status).toBe("failed");
      expect(f.retained.app.jobs.all).toEqual([]);
    } finally {
      await f.close();
    }
  });
});
