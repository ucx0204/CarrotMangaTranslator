import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { libraryImportHttpFixture } from "./mcpLibraryImportHttp.fixture";
import { importWebBoundary } from "./mcpLibraryImportWeb.fixture";

it("runs owned preparation through real OAuth/HTTP and never grants network or plan access to read-only/foreign connections", async () => {
  let paths: string[] = [];
  const web = importWebBoundary(() => paths);
  const f = await libraryImportHttpFixture({ web });
  paths = f.originals;
  try {
    const input = {
      requestId: randomUUID(),
      sources: [
        { kind: "url", url: "https://example.com/one", label: "One" },
        { kind: "url", url: "https://example.com/two", label: "Two" },
      ],
    };
    expect(
      (await f.call("carrot_prepare_import_batch", input, f.read)).error
        .message,
    ).toBe("Unknown tool");
    expect(
      (await f.call("carrot_list_import_batches", {}, f.read)).result
        .structuredContent.total,
    ).toBe(0);
    const created = await f.call("carrot_prepare_import_batch", input);
    expect(created.result.isError).toBe(false);
    const plan = created.result.structuredContent;
    expect(web.scan).not.toHaveBeenCalled();
    expect(
      (await f.call("carrot_get_import_batch", { id: plan.id }, f.other)).result
        .isError,
    ).toBe(true);
    const request = {
      id: plan.id,
      version: plan.version,
      requestId: randomUUID(),
      allowNetwork: true,
    };
    expect(
      (
        await f.call("carrot_run_import_batch", {
          ...request,
          allowNetwork: false,
        })
      ).error.code,
    ).toBe(-32602);
    const accepted = await f.call("carrot_run_import_batch", request);
    expect(accepted.result.isError).toBe(false);
    expect(await f.settle(accepted.result.structuredContent)).toMatchObject({
      status: "completed",
    });
    const done = (await f.call("carrot_get_import_batch", { id: plan.id }))
      .result.structuredContent;
    expect(done.items.map((item: { status: string }) => item.status)).toEqual([
      "ready",
      "ready",
    ]);
    expect(JSON.stringify(done)).not.toMatch(
      /sourcePath|authorized-input|dataUrl|mgt-import-preview/,
    );
    await f.restart();
    const restored = await f.call("carrot_get_import_batch", { id: plan.id });
    expect(
      restored.result.structuredContent.items.map(
        (item: { status: string }) => item.status,
      ),
    ).toEqual(["preview_unavailable", "preview_unavailable"]);
    await f.settle(
      (await f.call("carrot_run_import_batch", request)).result
        .structuredContent,
    );
    expect(web.scan).toHaveBeenCalledTimes(2);
    expect(
      (
        await f.call(
          "carrot_discard_import_batch",
          { id: plan.id, confirm: true },
          f.other,
        )
      ).result.isError,
    ).toBe(true);
    expect(
      (
        await f.call("carrot_discard_import_batch", {
          id: plan.id,
          confirm: true,
        })
      ).result.isError,
    ).toBe(false);
  } finally {
    await f.close();
  }
});

it("rolls back plan and encrypted index when the actual grant is revoked during metadata publication", async () => {
  const f = await libraryImportHttpFixture();
  const owner = f.provider.connectionIdFor(`Bearer ${f.full}`);
  if (!owner) throw new Error("Missing fixture owner");
  const seal = f.codec.seal;
  let revoked = false;
  const hook = vi.spyOn(f.codec, "seal").mockImplementation(async (value) => {
    const encrypted = await seal(value);
    if (
      !revoked &&
      value &&
      typeof value === "object" &&
      "sourceFingerprint" in value &&
      "runs" in value
    ) {
      f.provider.revokeConnection(owner);
      revoked = true;
    }
    return encrypted;
  });
  try {
    const before = await f.library.listLibrary();
    const response = await f.call("carrot_prepare_import_batch", {
      requestId: randomUUID(),
      sources: [{ kind: "url", label: "One", url: "https://example.com/one" }],
    });
    expect(revoked).toBe(true);
    expect(response.result?.isError || response.error).toBeTruthy();
    expect((await f.storage.index()).entries).toEqual([]);
    expect(await f.library.listLibrary()).toEqual(before);
    expect(f.choose).not.toHaveBeenCalled();
  } finally {
    hook.mockRestore();
    await f.close();
  }
});
