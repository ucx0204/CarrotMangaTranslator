import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { mcpAppEnvironment } from "./mcpAppEnvironment.fixture";
import { editingChapter } from "./mcpEditing.fixture";

it.each([
  ["ocr", "cancel"],
  ["ocr", "revoke"],
  ["translation", "cancel"],
  ["translation", "revoke"],
] as const)(
  "rechecks %s authorization after default runtime loading during %s",
  async (kind, mode) => {
    const env = await mcpAppEnvironment();
    try {
      const { getAppPaths } = await import("../src/main/appPaths");
      const { ActiveJobStore } = await import("../src/main/jobs/activeJob");
      const { resolveDefaultAppSettings } =
        await import("../src/main/appSettings");
      const { buildBaseOptions } = await import("../src/main/pipeline/options");
      const appPaths = getAppPaths();
      const app = {
        appPaths,
        jobs: new ActiveJobStore({ info: vi.fn(), error: vi.fn() }),
        getMainWindow: () => null,
        decodeImage: async () => null,
      };
      const options = buildBaseOptions(
        "runtime-loading",
        join(env.root, "run"),
        resolveDefaultAppSettings(process.env, null),
        appPaths,
      );
      const page = editingChapter().pages[0];
      page.imagePath = join(env.root, "source.png");
      const input = {
        chapterId: "chapter",
        workId: "work",
        pageId: page.id,
        pageIndex: 0,
        previousPageIds: [] as string[],
        blockId: page.blocks[0].id,
        sourceText: "source",
        textRole: "ordinary" as const,
        contextMode: "saved" as const,
      };
      const failure = new Error("Authorization lost during runtime loading");
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
          ? await import("../src/main/mcp/mcpBlockOcrAdapter").then(
              ({ recognizeMcpBlock }) =>
                () =>
                  recognizeMcpBlock(
                    app,
                    "chapter",
                    page,
                    { x: 0, y: 0, w: 1, h: 1 },
                    operation,
                  ),
            )
          : await import("../src/main/mcp/mcpBlockTranslationAdapter").then(
              ({ translateMcpBlock }) =>
                () =>
                  translateMcpBlock(input, options, operation),
            );
      const before = await readdir(env.root);
      const pending = run();
      // The real module import is asynchronous even when its code is cached.
      // Revoke before its continuation; no model or native target is required.
      if (mode === "cancel") controller.abort(failure);
      else allowed = false;
      await expect(pending).rejects.toBe(failure);
      expect(operation.progress).not.toHaveBeenCalled();
      expect(await readdir(env.root)).toEqual(before);
    } finally {
      await env.close();
    }
  },
);
