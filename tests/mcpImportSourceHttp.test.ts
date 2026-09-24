import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { libraryImportHttpFixture } from "./mcpLibraryImportHttp.fixture";

it("exposes metadata-only duplicate review with read scope while keeping preview ownership and publication authority separate", async () => {
  const f = await libraryImportHttpFixture();
  try {
    const input = await f.prepare();
    const before = await f.library.listLibrary();
    const args = {
      previewId: input.previewId,
      snapshot: input.snapshot,
      target: input.target,
      chapters: input.chapters,
    };
    const tools = await f.rpc("tools/list", {}, f.read);
    const found = tools.result.tools.find(
      (item: { name: string }) => item.name === "carrot_get_import_duplicates",
    );
    expect(found.annotations.readOnlyHint).toBe(true);
    expect(found.outputSchema).toBeDefined();
    const review = await f.call("carrot_get_import_duplicates", args);
    expect(review.result.isError).toBe(false);
    expect(review.result.structuredContent).toMatchObject({
      historicalOnly: true,
      chapters: [{ status: "unseen" }],
    });
    expect(review.result.content).toHaveLength(1);
    expect(JSON.stringify(review)).not.toMatch(
      /sourcePath|authorized-input|urlSha256|selectionSha256|dataUrl/,
    );
    expect(
      (await f.call("carrot_get_import_duplicates", args, f.other)).result
        .isError,
    ).toBe(true);
    expect(
      (await f.call("carrot_get_import_duplicates", args, f.read)).result
        .isError,
    ).toBe(true);
    expect(
      (
        await f.call("carrot_get_import_duplicates", {
          ...args,
          sourcePath: "C:/private",
        })
      ).error.code,
    ).toBe(-32602);
    expect(
      (
        await f.call(
          "carrot_import_chapters",
          { ...input, duplicatePolicy: "reject-known" },
          f.read,
        )
      ).error.message,
    ).toBe("Unknown tool");
    expect(await f.library.listLibrary()).toEqual(before);
    const saved = await f.call("carrot_import_chapters", {
      ...input,
      duplicatePolicy: "reject-known",
    });
    const done = await f.settle(saved.result.structuredContent);
    expect(done.status).toBe("completed");
    const receipt = done.result?.importReceipt;
    if (!receipt) throw new Error("Missing native receipt");
    const second = await f.prepare();
    const target = (
      await f.call("carrot_get_import_target", { workId: receipt.workId })
    ).result.structuredContent;
    second.target = {
      mode: "existing",
      workId: receipt.workId,
      snapshot: target.snapshot,
    };
    const rejected = await f.call("carrot_import_chapters", {
      ...second,
      requestId: randomUUID(),
      duplicatePolicy: "reject-known",
    });
    expect(await f.settle(rejected.result.structuredContent)).toMatchObject({
      status: "failed",
      error: { code: "invalid_edit" },
    });
    expect(f.choose).toHaveBeenCalledTimes(2);
  } finally {
    await f.close();
  }
});
