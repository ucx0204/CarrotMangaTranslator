import { readFile, writeFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { imageEditingFixture, brushCommand } from "./mcpImageEditing.fixture";

it("honors redaction on mask and color output without disabling ordinary plan inspection", async () => {
  const f = await imageEditingFixture();
  try {
    const plan = await f.preview(brushCommand());
    const { setImageRedactionEnabled } =
      await import("../src/main/imageRedactionStore");
    await setImageRedactionEnabled(true, f.env.root);
    await expect(
      f.invoke("carrot_get_image_edit_mask", { batchId: plan.batchId }),
    ).rejects.toThrow(/redaction/);
    await expect(
      f.invoke("carrot_sample_page_color", {
        chapterId: "chapter",
        pageId: "page",
        revision: plan.request.revision,
        image: "original",
        x: 20,
        y: 30,
      }),
    ).rejects.toThrow(/redaction/);
    expect((await f.inspect(plan.batchId)).status).toBe("proposed");
    expect(f.acquireEngine).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it("samples the requested original pixel and rejects absent cleaned data, outside points and a stopped session", async () => {
  const f = await imageEditingFixture();
  try {
    const input = await f.input(brushCommand());
    const target = {
      chapterId: "chapter",
      pageId: "page",
      revision: input.revision,
      image: "original",
      x: 20,
      y: 30,
    };
    expect(
      (await f.invoke("carrot_sample_page_color", target)).structuredContent,
    ).toMatchObject({ color: "#000000" });
    await expect(
      f.invoke("carrot_sample_page_color", { ...target, image: "cleaned" }),
    ).rejects.toThrow(/no cleaned/);
    await expect(
      f.invoke("carrot_sample_page_color", { ...target, x: 100 }),
    ).rejects.toThrow(/inside/);
    f.session.stop();
    await expect(
      f.invoke("carrot_sample_page_color", target),
    ).rejects.toThrow();
  } finally {
    await f.close();
  }
});

it("bounds page pixels and aggregate geometry before allocating a native model", async () => {
  const f = await imageEditingFixture();
  try {
    const command = brushCommand();
    if (command.kind !== "erase-mask") throw new Error("Expected drawn mask");
    command.strokes = Array.from({ length: 11 }, () => ({
      radiusPx: 2,
      points: Array.from({ length: 1200 }, () => ({ x: 2, y: 2 })),
    }));
    await expect(f.preview(command)).rejects.toThrow(/budget/);
    const stored = JSON.parse(await readFile(f.chapterPath, "utf8"));
    stored.pages[0].width = 5000;
    stored.pages[0].height = 5000;
    await writeFile(f.chapterPath, JSON.stringify(stored));
    await expect(f.preview(brushCommand())).rejects.toThrow(/16 million/);
    expect(f.acquireEngine).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it("registers all eight tools in actual app composition and removes image-only tools when image transfer is disabled", async () => {
  const f = await imageEditingFixture();
  const { createMcpPageOperationSession } =
    await import("../src/main/mcp/mcpPageOperationSession");
  try {
    for (const allowImages of [true, false]) {
      const session = createMcpPageOperationSession({
        origin: "https://isolated-image.test",
        app: f.app,
        reportError: vi.fn(),
        preferences: {
          autoStart: false,
          allowImages,
          allowEditing: true,
          allowProcessing: true,
        },
        editing: { ...f.editing, assertClean: async () => {} },
      });
      try {
        const names = session.tools.map((tool) => tool.name);
        expect(names).toEqual(
          expect.arrayContaining([
            "carrot_preview_image_edit",
            "carrot_get_image_edit",
            "carrot_apply_image_edit",
            "carrot_undo_image_edit",
            "carrot_redo_image_edit",
            "carrot_cancel_image_edit",
          ]),
        );
        expect(names.includes("carrot_get_image_edit_mask")).toBe(allowImages);
        expect(names.includes("carrot_sample_page_color")).toBe(allowImages);
      } finally {
        await session.close();
      }
    }
    expect(f.acquireEngine).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it("does not register an incomplete or locally disabled image writer", async () => {
  const f = await imageEditingFixture();
  const { createMcpImageEditSession } =
    await import("../src/main/mcp/mcpImageEditSession");
  try {
    for (const session of [
      createMcpImageEditSession(f.app, f.editing, false, true),
      createMcpImageEditSession(
        { ...f.app, inpaintingRevisionStore: undefined },
        f.editing,
        true,
        true,
      ),
    ]) {
      expect(session.tools).toEqual([]);
      await session.close();
    }
  } finally {
    await f.close();
  }
});
