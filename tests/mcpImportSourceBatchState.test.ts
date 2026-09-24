import * as fs from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { importBatchFixture } from "./mcpImportBatch.fixture";
import { createDeferred } from "./inpaintingSelectionJobFixtures";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
}));

it("keeps source checking visible through batch tools without claiming publication or rescanning", async () => {
  const f = await importBatchFixture(1);
  const release = createDeferred<void>();
  const entered = createDeferred<void>();
  let pending: Promise<unknown> | undefined;
  let hook: { mockRestore: () => void } | undefined;
  try {
    const plan = await f.prepareBatch();
    const prepared = await f.run(plan.id);
    const ref = prepared.view.items[0].preview;
    if (!ref) throw new Error("Missing prepared input");
    const input = await f.command(ref);
    const lstat = fs.lstat;
    let held = false;
    // Pause only the external filesystem observation of a captured PNG. Native
    // preview ownership, history, batch repository and output contracts stay real.
    hook = vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      const path = String(args[0]).replaceAll("\\", "/");
      if (!held && path.includes("/tmp/mcp-import-") && path.endsWith(".png")) {
        held = true;
        entered.resolve();
        await release.promise;
      }
      return lstat(...args);
    });
    pending = f.invoke("carrot_get_import_duplicates", {
      previewId: ref.previewId,
      snapshot: ref.snapshot,
      target: input.target,
      chapters: input.chapters,
    });
    await entered.promise;
    const checking = await f.get(plan.id);
    expect(checking.items[0]).toMatchObject({
      status: "checking",
      receipt: null,
    });
    expect(checking.status).not.toBe("completed");
    expect(checking.version).toBe(prepared.view.version);
    await expect(
      f.invoke("carrot_discard_import_preview", {
        previewId: ref.previewId,
        confirm: true,
      }),
    ).rejects.toMatchObject({ code: "editor_busy" });
    release.resolve();
    expect(await pending).toMatchObject({ historicalOnly: true });
    expect((await f.get(plan.id)).items[0].status).toBe("ready");
    expect(f.web.scan).toHaveBeenCalledOnce();
    expect(f.validate).not.toHaveBeenCalled();
    expect((await f.library.listLibrary()).works).toHaveLength(1);
  } finally {
    release.resolve();
    await Promise.allSettled([pending]);
    hook?.mockRestore();
    await f.close();
  }
});
