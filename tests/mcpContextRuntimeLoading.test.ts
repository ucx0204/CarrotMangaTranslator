import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { mcpAppEnvironment } from "./mcpAppEnvironment.fixture";

it.each(["cancel", "revoke"] as const)(
  "rechecks research authorization after native runtime loading during %s",
  async (mode) => {
    const env = await mcpAppEnvironment();
    try {
      const { getAppPaths } = await import("../src/main/appPaths");
      const { ActiveJobStore } = await import("../src/main/jobs/activeJob");
      const { readWorkContextForEdit, commitWorkContextEdit } =
        await import("../src/main/library");
      const { McpContextProposalService } =
        await import("../src/main/application/mcpContextProposalService");
      const { withMcpContextEditScope } =
        await import("../src/main/mcp/mcpContextEditScope");
      const { createMcpContextResearchExecutor } =
        await import("../src/main/mcp/mcpContextResearchAdapter");
      const app = {
        appPaths: getAppPaths(),
        jobs: new ActiveJobStore({ info: vi.fn(), error: vi.fn() }),
        getMainWindow: () => null,
        decodeImage: async () => null,
      };
      const proposals = new McpContextProposalService({
        read: readWorkContextForEdit,
        commit: commitWorkContextEdit,
        withEdit: withMcpContextEditScope,
      });
      try {
        const run = createMcpContextResearchExecutor(app, proposals);
        const controller = new AbortController();
        const failure = new Error("Research authorization lost during loading");
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
        const before = (await readdir(env.root, { recursive: true })).sort();
        const pending = run(
          "owner",
          {
            chapterId: "chapter",
            revision: "a".repeat(16),
            requestId: randomUUID(),
            researchTitle: "Synthetic work",
            engine: "codex-web",
          },
          operation,
        );
        // Revoke during the import continuation, before native work begins.
        if (mode === "cancel") controller.abort(failure);
        else allowed = false;
        await expect(pending).rejects.toBe(failure);
        expect(operation.progress).not.toHaveBeenCalled();
        expect(app.jobs.all).toEqual([]);
        expect((await readdir(env.root, { recursive: true })).sort()).toEqual(
          before,
        );
      } finally {
        await proposals.close();
      }
    } finally {
      await env.close();
    }
  },
);
