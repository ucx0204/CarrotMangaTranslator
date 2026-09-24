import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { structureHttpFixture } from "./mcpStructureHttp.fixture";

it("performs scoped preview/apply/undo/redo over HTTP using real page ownership and storage", async () => {
  const f = await structureHttpFixture();
  try {
    const before = await f.snapshot();
    const raster = await readFile(f.output);
    const original = (await f.library.openChapter("chapter")).pages[0];
    const response = await f.call(
      "carrot_preview_block_structure_edit",
      f.request,
    );
    expect(response.result.isError).toBe(false);
    expect(response.result.content).toHaveLength(1);
    const plan = response.result.structuredContent;
    expect(JSON.parse(response.result.content[0].text)).toEqual(plan);
    expect(plan).toMatchObject({
      canApply: true,
      state: "proposed",
      beforeBlockOrder: ["b", "a"],
      afterBlockOrder: ["b"],
    });
    expect(await f.snapshot()).toEqual(before);
    expect(JSON.stringify(response)).not.toMatch(
      /dataUrl|resource_link|imagePath/,
    );
    expect(JSON.stringify(response)).not.toContain(f.environment.root);
    let action = {
      editId: plan.editId,
      revision: plan.currentRevision,
      requestId: randomUUID(),
    };
    const saved = (await f.call("carrot_apply_block_structure_edit", action))
      .result.structuredContent;
    expect(saved).toMatchObject({
      status: "saved",
      pagesChanged: 1,
      historical: false,
    });
    const applied = (await f.library.openChapter("chapter")).pages[0];
    expect(applied.blocks).toEqual([original.blocks[1]]);
    expect(applied.blockOrder).toEqual(["b"]);
    expect(await readFile(f.output)).toEqual(raster);
    const undoRequest = {
      ...action,
      revision: saved.revision,
      requestId: randomUUID(),
    };
    const undone = (
      await f.call("carrot_undo_block_structure_edit", undoRequest)
    ).result.structuredContent;
    expect(undone.status).toBe("saved");
    expect((await f.library.openChapter("chapter")).pages[0].blocks).toEqual(
      original.blocks,
    );
    action = { ...action, revision: undone.revision, requestId: randomUUID() };
    const redo = (await f.call("carrot_redo_block_structure_edit", action))
      .result.structuredContent;
    expect(redo.revision).toBe(saved.revision);
    expect(
      (await f.call("carrot_undo_block_structure_edit", undoRequest)).result
        .structuredContent,
    ).toMatchObject({
      status: "already_applied",
      pagesChanged: 0,
      historical: true,
    });
    expect((await f.library.openChapter("chapter")).pages[0].blocks).toEqual([
      original.blocks[1],
    ]);
    const final = await f.call("carrot_undo_block_structure_edit", {
      ...action,
      revision: redo.revision,
      requestId: randomUUID(),
    });
    expect(final.result.isError).toBe(false);
    const restored = (await f.library.openChapter("chapter")).pages[0];
    expect(restored.blocks).toEqual(original.blocks);
    expect(restored.blockOrder).toEqual(original.blockOrder);
    expect(restored.inpaintedImagePath).toBe(original.inpaintedImagePath);
    expect(await readFile(f.output)).toEqual(raster);
    expect(await readFile(f.original, "utf8")).toBe("original-pixels");
    expect(f.jobs.gate.activities).toEqual([]);
    expect(f.errors).toEqual([]);
  } finally {
    await f.close();
  }
});

it("hides structure operations from read-only clients and rejects invalid input or foreign plans", async () => {
  const f = await structureHttpFixture();
  try {
    const before = await f.snapshot();
    const readList = await f.rpc("tools/list", {}, f.read);
    expect(
      readList.result.tools.filter((tool: { name: string }) =>
        tool.name.includes("structure"),
      ),
    ).toEqual([]);
    const tools = (await f.rpc("tools/list")).result.tools.filter(
      (tool: { name: string }) => tool.name.includes("structure"),
    );
    expect(tools).toHaveLength(5);
    for (const tool of tools) {
      expect(tool.outputSchema).toMatchObject({ type: "object" });
      expect((await f.call(tool.name, {}, f.read)).error.code).toBe(-32602);
      expect((await f.call(tool.name, { injected: true })).error.code).toBe(
        -32602,
      );
    }
    const plan = (
      await f.call("carrot_preview_block_structure_edit", f.request)
    ).result.structuredContent;
    expect(
      (
        await f.call(
          "carrot_get_block_structure_edit",
          { editId: plan.editId },
          f.other,
        )
      ).result.structuredContent.error,
    ).toBe("not_found");
    const foreign = await f.call(
      "carrot_apply_block_structure_edit",
      {
        editId: plan.editId,
        revision: plan.currentRevision,
        requestId: randomUUID(),
      },
      f.other,
    );
    expect(foreign.result.structuredContent.error).toBe("not_found");
    const bad = await f.call("carrot_preview_block_structure_edit", {
      ...f.request,
      requestId: randomUUID(),
      operation: { kind: "delete", blockId: "missing" },
    });
    expect(bad.result.structuredContent.error).toBe("not_found");
    expect(await f.snapshot()).toEqual(before);
    expect(f.notifySaved).not.toHaveBeenCalled();
    expect(f.jobs.gate.activities).toEqual([]);
    expect(f.errors).toEqual([]);
  } finally {
    await f.close();
  }
});
