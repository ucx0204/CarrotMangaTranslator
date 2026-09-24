import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { mcpAppEnvironment } from "./mcpAppEnvironment.fixture";
import { editingChapter } from "./mcpEditing.fixture";

it.each([
  ["ocr", "cancel"],
  ["ocr", "revoke"],
  ["erasure", "cancel"],
  ["erasure", "revoke"],
] as const)(
  "rechecks page %s authorization after default runtime loading during %s",
  async (kind, mode) => {
    const env = await mcpAppEnvironment();
    try {
      const { getAppPaths } = await import("../src/main/appPaths");
      const { ActiveJobStore } = await import("../src/main/jobs/activeJob");
      const { createPageRevision } = await import("../src/shared/pageRevision");
      const app = {
        appPaths: getAppPaths(),
        jobs: new ActiveJobStore({ info: vi.fn(), error: vi.fn() }),
        getMainWindow: () => null,
        decodeImage: async () => null,
      };
      const chapter = editingChapter();
      const page = chapter.pages[0];
      page.imagePath = join(env.root, "source.png");
      const target = {
        chapterId: chapter.id,
        pageId: page.id,
        revision: createPageRevision(page),
        requestId: randomUUID(),
      };
      const editing = {
        assertWritable: vi.fn(async () => {}),
        assertClean: vi.fn(async () => {}),
        notifySaved: vi.fn(),
      };
      const emit = vi.fn();
      const failure = new Error(
        "Authorization lost during page runtime loading",
      );
      const controller = new AbortController();
      let allowed = true;
      const operation = {
        id: randomUUID(),
        signal: controller.signal,
        progress: vi.fn(),
        assertAuthorized: () => {
          controller.signal.throwIfAborted();
          if (!allowed) throw failure;
        },
      };
      const run =
        kind === "ocr"
          ? await import("../src/main/mcp/mcpOcrAdapter").then(
              ({ recognizeMcpPage }) =>
                () =>
                  recognizeMcpPage(app, chapter.id, page, operation, emit),
            )
          : await import("../src/main/mcp/mcpErasureAdapter").then(
              ({ eraseMcpPage }) =>
                () =>
                  eraseMcpPage(app, editing, target, operation),
            );
      const before = (await readdir(env.root, { recursive: true })).sort();
      expect(app.jobs.all).toEqual([]);
      const pending = run();
      // Real dynamic imports yield even when cached. Revoke before their
      // continuation, before any native job, model, or target file is needed.
      if (mode === "cancel") controller.abort(failure);
      else allowed = false;
      await expect(pending).rejects.toBe(failure);
      expect(operation.progress).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
      expect(editing.assertWritable).not.toHaveBeenCalled();
      expect(editing.assertClean).not.toHaveBeenCalled();
      expect(editing.notifySaved).not.toHaveBeenCalled();
      expect(app.jobs.all).toEqual([]);
      expect((await readdir(env.root, { recursive: true })).sort()).toEqual(
        before,
      );
    } finally {
      await env.close();
    }
  },
);
