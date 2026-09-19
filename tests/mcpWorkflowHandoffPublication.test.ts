import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { workflowHandoffFixture } from "./mcpWorkflowHandoff.fixture";

it("excludes run and settled controls during acceptance while allowing the donor to revoke pending consent", async () => {
  const f = await workflowHandoffFixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = vi.fn();
  let rejected: Promise<unknown> | undefined;
  const seal = f.codec.seal;
  const hook = vi.spyOn(f.codec, "seal").mockImplementation(async (value) => {
    if (
      typeof value === "object" &&
      value !== null &&
      "owner" in value &&
      value.owner === f.recipient.principalId
    ) {
      entered();
      await gate;
    }
    return seal(value);
  });
  try {
    const before = await readFile(f.chapterPath);
    const plan = await f.prepare([
      { kind: "await-external", purpose: "translation" },
    ]);
    const offered = await f.offer(plan.id);
    rejected = expect(f.accept(offered.acceptance)).rejects.toThrow("revoked");
    await vi.waitFor(() => expect(entered).toHaveBeenCalled(), {
      timeout: 10000,
    });
    const requests: [string, object][] = [
      [
        "carrot_run_workflow",
        { id: plan.id, version: plan.version, requestId: randomUUID() },
      ],
      ["carrot_pause_workflow", { id: plan.id }],
      ["carrot_cancel_workflow", { id: plan.id }],
      ["carrot_discard_workflow", { id: plan.id, confirm: true }],
      [
        "carrot_accept_workflow_external",
        {
          id: plan.id,
          version: plan.version,
          requestId: randomUUID(),
          page: plan.pages[0],
        },
      ],
    ];
    for (const [name, input] of requests)
      await expect(f.invoke(name, input)).rejects.toThrow("admission");
    await f.invoke(
      "carrot_revoke_workflow_handoff",
      {
        id: plan.id,
        offerId: offered.receipt.offerId,
      },
      f.donor,
    );
    release();
    await rejected;
    await f.storage.owned(f.owner, plan.id, "workflow");
    expect(await readFile(f.chapterPath)).toEqual(before);
    expect(f.request).not.toHaveBeenCalled();
  } finally {
    release();
    await rejected;
    hook.mockRestore();
    await f.close();
  }
});

it("rechecks original file evidence after encryption and rolls ownership back when it changes", async () => {
  const f = await workflowHandoffFixture();
  const page = (await f.library.openChapter("chapter")).pages[0];
  const original = await readFile(page.imagePath);
  const seal = f.codec.seal;
  let changed = false;
  const hook = vi.spyOn(f.codec, "seal").mockImplementation(async (value) => {
    if (
      !changed &&
      typeof value === "object" &&
      value !== null &&
      "owner" in value &&
      value.owner === f.recipient.principalId
    ) {
      changed = true;
      await writeFile(
        page.imagePath,
        Buffer.concat([original, Buffer.from("changed source")]),
      );
    }
    return seal(value);
  });
  try {
    const plan = await f.prepare([{ kind: "export-png" }]);
    const offered = await f.offer(plan.id);
    await expect(f.accept(offered.acceptance)).rejects.toThrow("source");
    expect(changed).toBe(true);
    await f.storage.owned(f.owner, plan.id, "workflow");
    expect(await f.storage.record(plan.id)).toMatchObject({
      owner: f.owner,
      version: plan.version,
    });
    expect(f.render).not.toHaveBeenCalled();
  } finally {
    hook.mockRestore();
    await writeFile(page.imagePath, original);
    await f.close();
  }
});

it("refuses handoff while a native child is active and keeps the original owner", async () => {
  const f = await workflowHandoffFixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const request = f.request.getMockImplementation();
  if (!request) throw new Error("Missing deterministic model boundary");
  f.request.mockImplementationOnce(async (args) => {
    await gate;
    return request(args);
  });
  try {
    const plan = await f.prepare();
    await f.run(plan.id);
    await vi.waitFor(() => expect(f.request).toHaveBeenCalled(), {
      timeout: 10000,
    });
    await expect(f.offer(plan.id)).rejects.toThrow("cleanup");
    await f.storage.owned(f.owner, plan.id, "workflow");
    release();
    expect((await f.done(plan.id)).status).toBe("completed");
    await expect(f.offer(plan.id)).rejects.toThrow("settled");
  } finally {
    release();
    await f.close();
  }
});

for (const point of ["after-replace-step", "after-commit-point"] as const) {
  it(`recovers both owners and the exact accepted receipt after native ${point}`, async () => {
    const f = await workflowHandoffFixture();
    const tx = await import("../src/main/libraryStore/libraryTransaction");
    let reset = () => {};
    try {
      const plan = await f.prepare([{ kind: "export-png" }]);
      const offered = await f.offer(plan.id);
      let crashed = false;
      reset = tx.setLibraryTransactionCrashInjectorForTests((position) => {
        if (position === point) {
          crashed = true;
          throw new tx.SimulatedLibraryTransactionCrash(position);
        }
      });
      await f.accept(offered.acceptance).catch((error: unknown) => {
        if (!(error instanceof tx.SimulatedLibraryTransactionCrash))
          throw error;
      });
      expect(crashed).toBe(true);
      reset();
      await tx.recoverLibraryTransactions();
      await f.restart();
      if (point === "after-commit-point") {
        await expect(f.get(plan.id)).rejects.toThrow();
        expect((await f.accept(offered.acceptance)).status).toBe(
          "already_transferred",
        );
        expect((await f.inspect(plan.id, f.recipient)).status).toBe("paused");
      } else {
        expect((await f.get(plan.id)).status).toBe("prepared");
        await expect(f.accept(offered.acceptance)).rejects.toThrow();
        const next = await f.offer(plan.id);
        expect((await f.accept(next.acceptance)).status).toBe("transferred");
      }
      expect(f.request).not.toHaveBeenCalled();
      expect(f.render).not.toHaveBeenCalled();
    } finally {
      reset();
      await f.close();
    }
  });
}
