import { readdir, readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { typographyAnalysisAppFixture } from "./mcpTypographyAnalysisApp.fixture";
import { imageNativeBoundary } from "./mcpImageNative.fixture";
import { brushCommand } from "./mcpImageEditing.fixture";

it.each(["cancel", "revoke"] as const)(
  "rechecks image erasure authority after native engine loading during %s",
  async (mode) => {
    const f = await typographyAnalysisAppFixture(imageNativeBoundary);
    try {
      const { prepareMcpImageEdit } =
        await import("../src/main/mcp/mcpImageEditEvidence");
      const { produceMcpImageEdit } =
        await import("../src/main/mcp/mcpImageEditExecution");
      const page = {
        ...f.chapter.pages[0],
        maskProvenance: undefined,
        blocks: f.chapter.pages[0].blocks.map((block) => ({
          ...block,
          bboxSpace: "pixels" as const,
        })),
      };
      const command = brushCommand();
      const controller = new AbortController();
      const failure = new Error(
        "Image erasure authorization lost during loading",
      );
      let allowed = true;
      const guard = () => {
        controller.signal.throwIfAborted();
        if (!allowed) throw failure;
      };
      const prepared = await prepareMcpImageEdit(page, command, guard);
      const before = (await readdir(f.env.root, { recursive: true })).sort();
      const chapterBefore = await readFile(f.chapterPath);
      const produced = vi.fn();
      const pending = produceMcpImageEdit(
        f.app,
        page,
        command,
        prepared,
        guard,
        controller.signal,
        undefined,
        produced,
      );
      if (mode === "cancel") controller.abort(failure);
      else allowed = false;
      await expect(pending).rejects.toBe(failure);
      expect(produced).not.toHaveBeenCalled();
      expect(f.app.jobs.all).toEqual([]);
      expect(await readFile(f.chapterPath)).toEqual(chapterBefore);
      expect(await readFile(page.imagePath)).toEqual(f.bytes);
      expect((await readdir(f.env.root, { recursive: true })).sort()).toEqual(
        before,
      );
    } finally {
      await f.close();
    }
  },
);
