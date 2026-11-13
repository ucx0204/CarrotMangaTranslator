import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { McpOperationService } from "../src/main/application/mcpOperationService";
import { createMcpOperationTools } from "../src/main/mcp/mcpOperationTools";
import { McpEditError } from "../src/main/application/mcpEditPolicy";
import type { McpTool } from "../src/main/mcp/mcpReadTools";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function fixture(kind: "ocr" | "erase" = "ocr") {
  const service = new McpOperationService(() => {});
  const scopes = new Set(["carrot.read", "carrot.process"]);
  const check = vi.fn((needed: readonly string[] = ["carrot.read"]) => {
    if (needed.some((scope) => !scopes.has(scope)))
      throw new McpEditError("access_denied", "Permission unavailable");
  });
  const context = {
    principalId: "grant-a",
    assertAuthorized: () => check(),
    assertScopes: check,
    assertJobAuthorized: check,
  };
  let fail = true;
  const executor = vi.fn(async () => {
    if (fail) throw new Error("model unavailable");
    return { status: "saved", blockIds: ["a"] };
  });
  const tools = createMcpOperationTools(service, { [kind]: executor });
  const call = async (
    name: string,
    args: Record<string, unknown>,
    caller: Parameters<McpTool["invoke"]>[1] = context,
  ) => {
    const tool = tools.find((tool) => tool.name === name);
    if (!tool) throw new Error("Missing test tool");
    const result = await tool.invoke(args, caller);
    if (result[0].type !== "text") throw new Error("Expected metadata");
    return JSON.parse(result[0].text);
  };
  const parameters = {
    chapterId: "chapter",
    pageId: "page",
    revision: "page-v1:0000000000000000",
    requestId: randomUUID(),
  };
  return {
    service,
    scopes,
    context,
    executor,
    call,
    parameters,
    succeed: () => {
      fail = false;
    },
  };
}
async function failedFixture() {
  const f = fixture();
  const receipt = await f.call("carrot_run_page_ocr", f.parameters);
  for (
    let i = 0;
    i < 100 &&
    (await f.service.status(receipt.jobId, "grant-a")).status === "running";
    i++
  )
    await tick();
  expect((await f.service.status(receipt.jobId, "grant-a")).status).toBe(
    "failed",
  );
  return { ...f, receipt };
}
it("lists scoped jobs and performs only an explicitly requested same-target retry", async () => {
  const f = await failedFixture();
  try {
    const listed = await f.call("carrot_list_jobs", {});
    expect(listed.jobs[0].jobId).toBe(f.receipt.jobId);
    const other = await f.call(
      "carrot_list_jobs",
      {},
      { ...f.context, principalId: "other" },
    );
    expect(other.total).toBe(0);
    f.succeed();
    const parameters = {
      jobId: f.receipt.jobId,
      requestId: randomUUID(),
      revision: f.parameters.revision,
    };
    const retried = await f.call("carrot_retry_job", parameters);
    expect(retried.jobId).not.toBe(f.receipt.jobId);
    expect((await f.call("carrot_retry_job", parameters)).jobId).toBe(
      retried.jobId,
    );
    await tick();
    expect((await f.service.status(retried.jobId, "grant-a")).status).toBe(
      "completed",
    );
    expect(f.executor).toHaveBeenCalledTimes(2);
  } finally {
    await f.service.close();
  }
});
it("does not retry with read-only scopes, changed revision, reused request ID or another principal", async () => {
  const f = await failedFixture();
  try {
    const parameters = {
      jobId: f.receipt.jobId,
      requestId: randomUUID(),
      revision: f.parameters.revision,
    };
    await expect(
      f.call("carrot_retry_job", {
        ...parameters,
        requestId: f.parameters.requestId,
      }),
    ).rejects.toThrow(/new requestId/);
    await expect(
      f.call("carrot_retry_job", {
        ...parameters,
        revision: "page-v1:1111111111111111",
      }),
    ).rejects.toThrow(/original target revision/);
    await expect(
      f.call("carrot_retry_job", parameters, {
        ...f.context,
        principalId: "other",
      }),
    ).rejects.toThrow(/not found/);
    await expect(
      f.call("carrot_retry_job", parameters, {
        ...f.context,
        assertJobAuthorized: undefined,
      }),
    ).rejects.toThrow(/approved OAuth/);
    f.scopes.delete("carrot.process");
    await expect(f.call("carrot_retry_job", parameters)).rejects.toThrow(
      /Permission/,
    );
    expect(f.executor).toHaveBeenCalledOnce();
  } finally {
    await f.service.close();
  }
});
it("validates listing/retry arguments and forbids anonymous access", async () => {
  const f = fixture();
  try {
    await expect(
      f.call("carrot_list_jobs", {}, undefined),
    ).resolves.toMatchObject({ total: 0 });
    await expect(
      f.call("carrot_list_jobs", {}, { assertAuthorized: () => {} }),
    ).rejects.toThrow(/approved OAuth/);
    await expect(
      f.call("carrot_list_jobs", { path: "private" }),
    ).rejects.toThrow();
    await expect(
      f.call("carrot_retry_job", { jobId: "invalid" }),
    ).rejects.toThrow();
  } finally {
    await f.service.close();
  }
});

it("retries source measurement with its original executor and process scope", async () => {
  const f = fixture();
  const measure = vi
    .fn()
    .mockRejectedValueOnce(new Error("temporary failure"))
    .mockResolvedValue({ status: "saved" });
  const exportPng = vi.fn(async () => ({ status: "saved" }));
  const tools = createMcpOperationTools(f.service, {
    sourceSize: measure,
    exportPng,
  });
  const invoke = async (name: string, args: Record<string, unknown>) => {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`Missing tool: ${name}`);
    const result = await tool.invoke(args, f.context);
    if (result[0].type !== "text") throw new Error("Expected receipt");
    return JSON.parse(result[0].text);
  };
  try {
    const first = await invoke("carrot_run_page_source_size", f.parameters);
    await f.service.waitForCompletion(
      first.jobId,
      "grant-a",
      new AbortController().signal,
    );
    const disabled = createMcpOperationTools(f.service, { exportPng }).find(
      (tool) => tool.name === "carrot_retry_job",
    );
    if (!disabled) throw new Error("Missing recovery tool");
    await expect(
      disabled.invoke(
        {
          jobId: first.jobId,
          requestId: randomUUID(),
          revision: f.parameters.revision,
        },
        f.context,
      ),
    ).rejects.toThrow();
    expect(exportPng).not.toHaveBeenCalled();
    const retry = await invoke("carrot_retry_job", {
      jobId: first.jobId,
      requestId: randomUUID(),
      revision: f.parameters.revision,
    });
    const result = await f.service.waitForCompletion(
      retry.jobId,
      "grant-a",
      new AbortController().signal,
    );
    expect(result).toMatchObject({ kind: "sourceSize", status: "completed" });
    expect(measure).toHaveBeenCalledTimes(2);
    expect(exportPng).not.toHaveBeenCalled();
  } finally {
    await f.service.close();
  }
});

it("requires image scope again when retrying Codex erasure and retains the selected engine", async () => {
  const f = fixture("erase");
  const parameters = {
    ...f.parameters,
    engine: "codex",
    expectedModel: "gpt-6-astra",
    allowExternalProcessing: true,
  };
  try {
    await expect(f.call("carrot_run_page_erasure", parameters)).rejects.toThrow(
      /Permission/,
    );
    expect(f.executor).not.toHaveBeenCalled();
    f.scopes.add("carrot.images");
    const receipt = await f.call("carrot_run_page_erasure", parameters);
    await f.service.waitForCompletion(
      receipt.jobId,
      "grant-a",
      new AbortController().signal,
    );
    f.scopes.delete("carrot.images");
    const retry = {
      jobId: receipt.jobId,
      requestId: randomUUID(),
      revision: f.parameters.revision,
    };
    await expect(f.call("carrot_retry_job", retry)).rejects.toThrow(
      /Permission/,
    );
    expect(f.executor).toHaveBeenCalledOnce();
    f.scopes.add("carrot.images");
    f.succeed();
    const next = await f.call("carrot_retry_job", retry);
    await f.service.waitForCompletion(
      next.jobId,
      "grant-a",
      new AbortController().signal,
    );
    expect(f.executor).toHaveBeenLastCalledWith(
      expect.objectContaining({
        engine: "codex",
        expectedModel: "gpt-6-astra",
        allowExternalProcessing: true,
      }),
      expect.anything(),
    );
  } finally {
    await f.service.close();
  }
});
