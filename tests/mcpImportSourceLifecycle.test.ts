import { expect, it, vi } from "vitest";
import { importDuplicateFixture } from "./mcpImportDuplicate.fixture";
import { createDeferred } from "./inpaintingSelectionJobFixtures";

it("reports checking rather than importing during metadata inspection and releases the reserved preview afterward", async () => {
  const f = await importDuplicateFixture();
  const release = createDeferred<void>();
  const entered = createDeferred<void>();
  let blocking: Promise<unknown> | undefined;
  let pending: Promise<unknown> | undefined;
  try {
    const ref = await f.prepare();
    const input = await f.command(ref);
    input.target = await f.target("work");
    const { withLibraryMutation } = await import("../src/main/library/lock");
    blocking = withLibraryMutation(async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    pending = f.review(input);
    await vi.waitFor(async () =>
      expect((await f.inspect(ref)).status).toBe("checking"),
    );
    await expect(
      f.invoke("carrot_discard_import_preview", {
        previewId: ref.previewId,
        confirm: true,
      }),
    ).rejects.toMatchObject({ code: "editor_busy" });
    release.resolve();
    await blocking;
    expect(await pending).toMatchObject({ historicalOnly: true });
    expect((await f.inspect(ref)).status).toBe("ready");
    expect(f.validate).not.toHaveBeenCalled();
    expect((await f.library.listLibrary()).works).toHaveLength(1);
  } finally {
    release.resolve();
    await Promise.allSettled([blocking, pending]);
    await f.close();
  }
});

it("does not return a review after the approval is revoked during queued native history reading", async () => {
  const f = await importDuplicateFixture();
  const release = createDeferred<void>();
  const entered = createDeferred<void>();
  let blocking: Promise<unknown> | undefined;
  let outcome: Promise<unknown> | undefined;
  try {
    const ref = await f.prepare();
    const input = await f.command(ref);
    input.target = await f.target("work");
    const { withLibraryMutation } = await import("../src/main/library/lock");
    const { McpEditError } =
      await import("../src/main/application/mcpEditPolicy");
    let authorized = true;
    blocking = withLibraryMutation(async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    outcome = f
      .review(
        input,
        f.auth("import-owner", () => {
          if (!authorized)
            throw new McpEditError("access_denied", "Revoked during review");
        }),
      )
      .then(
        () => "unexpected-success",
        (error: unknown) => error,
      );
    await vi.waitFor(async () =>
      expect((await f.inspect(ref)).status).toBe("checking"),
    );
    authorized = false;
    release.resolve();
    await blocking;
    expect(await outcome).toMatchObject({ code: "access_denied" });
    expect((await f.inspect(ref)).status).toBe("ready");
    expect(f.validate).not.toHaveBeenCalled();
  } finally {
    release.resolve();
    await Promise.allSettled([blocking, outcome]);
    await f.close();
  }
});
