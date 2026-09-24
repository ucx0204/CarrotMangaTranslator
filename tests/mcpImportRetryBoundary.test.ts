import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { chapterDiscoveryFixture } from "./mcpChapterDiscovery.fixture";

it.each(["importDiscover", "importPrepare", "importCreate"] as const)(
  "rejects page-only retry for %s without another browser or import call",
  async (kind) => {
    const f = await chapterDiscoveryFixture(1);
    try {
      f.web.discoverChapters.mockResolvedValueOnce({
        status: "rejected",
        reason: "page-unavailable",
      });
      f.web.scan.mockResolvedValueOnce({
        status: "rejected",
        reason: "page-unavailable",
      });
      const commands = {
        importDiscover: { name: "carrot_discover_chapters", args: f.input },
        importPrepare: {
          name: "carrot_scan_import_url",
          args: {
            requestId: randomUUID(),
            source: "web",
            url: "https://chapters.example/chapter/1",
            allowNetwork: true,
          },
        },
        importCreate: {
          name: "carrot_import_chapters",
          args: {
            requestId: randomUUID(),
            previewId: randomUUID(),
            snapshot: "0".repeat(16),
            allowNativePreparation: true,
            target: { mode: "new", title: "No preview exists" },
            chapters: [
              {
                draftId: randomUUID(),
                title: "Missing",
                pageIds: [randomUUID()],
              },
            ],
          },
        },
      };
      const command = commands[kind];
      const done = await f.settle(await f.invoke(command.name, command.args));
      expect(done).toMatchObject({ kind, status: "failed" });
      const before = [
        f.web.discoverChapters.mock.calls.length,
        f.web.scan.mock.calls.length,
        f.validate.mock.calls.length,
      ];
      expect(() =>
        f
          .current()
          .operations.retryTarget(
            done.jobId,
            "import-owner",
            "page-v1:0123456789abcdef",
          ),
      ).toThrowError(expect.objectContaining({ code: "invalid_edit" }));
      expect([
        f.web.discoverChapters.mock.calls.length,
        f.web.scan.mock.calls.length,
        f.validate.mock.calls.length,
      ]).toEqual(before);
      expect((await f.storage.index()).entries).toEqual([]);
      expect((await f.library.listLibrary()).works).toHaveLength(1);
    } finally {
      await f.close();
    }
  },
);
