import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { workflowHttp } from "./mcpWorkflowHttp.fixture";

it("runs through actual scoped HTTP while withholding mutation and image authority from narrower grants", async () => {
  const f = await workflowHttp();
  try {
    const plan = await f.prepareHttp();
    const input = {
      id: plan.id,
      version: plan.version,
      requestId: randomUUID(),
    };
    expect(
      (await f.call("carrot_run_workflow", input, f.read)).error.message,
    ).toBe("Unknown tool");
    expect(
      (await f.call("carrot_get_workflow", { id: plan.id }, f.limited)).result
        .structuredContent.error,
    ).toBe("not_found");
    expect((await f.call("carrot_run_workflow", input)).result.isError).toBe(
      false,
    );
    await vi.waitFor(
      async () => {
        const result = await f.call("carrot_get_workflow", { id: plan.id });
        expect(
          result.result.structuredContent.status,
          JSON.stringify(f.errors),
        ).toBe("completed");
        expect(result.result.structuredContent.completedSteps).toBe(2);
        expect(JSON.stringify(result)).not.toMatch(
          /imagePath|dataUrl|sourceText|settingsFingerprint/,
        );
      },
      { timeout: 20000 },
    );
    expect(
      (await f.call("carrot_run_workflow", input)).result.structuredContent
        .status,
    ).toBe("completed");
    expect(f.render).toHaveBeenCalledTimes(2);
    const limited = await f.prepareHttp(f.limited);
    const denied = await f.call(
      "carrot_run_workflow",
      { id: limited.id, version: limited.version, requestId: randomUUID() },
      f.limited,
    );
    expect(denied.result?.isError ?? Boolean(denied.error)).toBe(true);
    expect(
      (await f.call("carrot_get_workflow", { id: limited.id }, f.limited))
        .result.structuredContent.status,
    ).toBe("prepared");
    expect(f.render).toHaveBeenCalledTimes(2);
    expect(
      (await f.call("carrot_get_workflow", { id: plan.id, path: "C:/private" }))
        .error.code,
    ).toBe(-32602);
  } finally {
    await f.close();
  }
});

it("stops an admitted HTTP workflow after grant revocation without publishing output or starting another page", async () => {
  const f = await workflowHttp();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const render = f.render.getMockImplementation();
    if (!render) throw new Error("Missing renderer boundary");
    f.render.mockImplementationOnce(async (page) => {
      await gate;
      return render(page);
    });
    const plan = await f.prepareHttp();
    expect(
      (
        await f.call("carrot_run_workflow", {
          id: plan.id,
          version: plan.version,
          requestId: randomUUID(),
        })
      ).result.isError,
    ).toBe(false);
    await vi.waitFor(() => expect(f.render).toHaveBeenCalledTimes(1));
    const id = f.provider.connectionIdFor(`Bearer ${f.full}`);
    if (!id) throw new Error("Missing native OAuth connection");
    f.provider.revokeConnection(id);
    release();
    await vi.waitFor(
      async () => {
        expect(await f.storage.record(plan.id)).toMatchObject({
          status: "failed",
        });
      },
      { timeout: 10000 },
    );
    expect(
      (await f.storage.index()).entries.filter(
        (entry) => entry.kind === "output",
      ),
    ).toEqual([]);
    expect(f.render).toHaveBeenCalledTimes(1);
    expect(f.request).not.toHaveBeenCalled();
  } finally {
    release();
    await f.close();
  }
});
