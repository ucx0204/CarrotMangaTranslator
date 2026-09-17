import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { McpOperationService } from "../src/main/application/mcpOperationService";
import { McpPageExportService } from "../src/main/application/mcpPageExportService";
import { McpArtifactStore } from "../src/main/mcp/mcpArtifactStore";
import { createMcpOperationTools } from "../src/main/mcp/mcpOperationTools";
import { mcpToolResult } from "../src/main/mcp/mcpToolResult";
import { createPageRevision } from "../src/shared/pageRevision";
import { editingChapter } from "./mcpEditing.fixture";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function fixture() {
  let now = Date.now();
  let snapshot: unknown;
  const persistence = {
    load: async () => snapshot,
    save: async (value: unknown) => {
      snapshot = structuredClone(value);
    },
  };
  const operations = new McpOperationService(
    () => {},
    () => now,
    persistence,
  );
  const store = new McpArtifactStore("https://carrot.test", () => now);
  const chapter = editingChapter();
  let connected = true;
  const scopes = new Set(["carrot.read", "carrot.images"]);
  const context = {
    principalId: "owner",
    assertAuthorized: () => {
      if (!connected) throw new Error("disconnected");
    },
    assertScopes: (required: readonly string[]) => {
      if (required.some((scope) => !scopes.has(scope)))
        throw new Error("scope denied");
    },
  };
  const imageAccess = vi.fn(async () => {});
  const render = vi.fn(async () => Buffer.from("test PNG"));
  const exporter = new McpPageExportService({
    openChapter: async () => structuredClone(chapter),
    render,
    store: store.put.bind(store),
    assertImageAccess: imageAccess,
  });
  const tools = createMcpOperationTools(
    operations,
    {
      exportPng: (target, operation) => exporter.export(target, operation),
    },
    store.assertAvailable.bind(store),
  );
  const call = async (
    name: string,
    args: Record<string, unknown>,
    caller = context,
  ) => {
    const tool = tools.find((item) => item.name === name);
    if (!tool) throw new Error("Missing tool");
    return mcpToolResult(tool, await tool.invoke(args, caller));
  };
  const target = {
    chapterId: "chapter",
    pageId: "page",
    revision: createPageRevision(chapter.pages[0]),
    requestId: randomUUID(),
  };
  const started = await call("carrot_export_page_png", target);
  const jobId = JSON.parse((started.content[0] as { text: string }).text)
    .jobId as string;
  await vi.waitFor(() =>
    expect(operations.status(jobId, "owner").status).toBe("completed"),
  );
  return {
    operations,
    store,
    chapter,
    context,
    scopes,
    imageAccess,
    render,
    call,
    jobId,
    target,
    persistence,
    expire: () => {
      now += 10 * 60_000;
    },
    disconnect: () => {
      connected = false;
    },
    close: async () => {
      await operations.close();
      await store.close();
    },
  };
}

it.each([undefined, false, true])(
  "returns only a text link unless includeAttachment is explicitly true (%s)",
  async (includeAttachment) => {
    const f = await fixture();
    try {
      const args = {
        jobId: f.jobId,
        ...(includeAttachment === undefined ? {} : { includeAttachment }),
      };
      const result = await f.call("carrot_get_job_file", args);
      expect(result.content).toHaveLength(includeAttachment ? 2 : 1);
      const metadata = JSON.parse((result.content[0] as { text: string }).text);
      expect(result.structuredContent).toEqual(metadata);
      expect(metadata).toMatchObject({
        jobId: f.jobId,
        kind: "rendered-page-png",
        url: expect.stringContaining("https://carrot.test/mcp-artifacts/"),
      });
      if (includeAttachment)
        expect(result.content[1]).toMatchObject({
          type: "resource_link",
          uri: metadata.url,
          mimeType: "image/png",
          size: metadata.bytes,
        });
      else
        expect(result.content.every((item) => item.type === "text")).toBe(true);
      expect(await f.call("carrot_get_job_file", args)).toEqual(result);
      expect(f.render).toHaveBeenCalledOnce();
      const status = await f.call("carrot_get_job", { jobId: f.jobId });
      expect(status.content).toHaveLength(1);
      expect(JSON.stringify(status)).not.toMatch(
        /resource_link|mcp-artifacts|"url"/,
      );
      await expect(
        f.call("carrot_get_job", { jobId: f.jobId, includeAttachment: true }),
      ).rejects.toThrow();
    } finally {
      await f.close();
    }
  },
);

it.each([
  "expiry",
  "revision",
  "redaction",
  "revocation",
  "disconnect during check",
  "stop during check",
])(
  "rejects explicit file retrieval after %s without rendering again",
  async (change) => {
    const f = await fixture();
    try {
      const initial = await f.call("carrot_get_job_file", { jobId: f.jobId });
      expect(initial.content).toHaveLength(1);
      expect(initial.content[0].type).toBe("text");
      if (change === "expiry") f.expire();
      if (change === "revision")
        f.chapter.pages[0].blocks[0].translatedText = "changed";
      if (change === "redaction")
        f.imageAccess.mockRejectedValue(new Error("redacted"));
      if (change === "revocation") f.scopes.delete("carrot.images");
      if (change === "disconnect during check")
        f.imageAccess.mockImplementation(async () => f.disconnect());
      if (change === "stop during check")
        f.imageAccess.mockImplementation(async () => f.store.stop());
      for (const includeAttachment of [false, true])
        await expect(
          f.call("carrot_get_job_file", { jobId: f.jobId, includeAttachment }),
        ).rejects.toThrow();
      expect(f.render).toHaveBeenCalledOnce();
      expect(JSON.stringify(f.operations.status(f.jobId, "owner"))).not.toMatch(
        /mcp-artifacts|"url"/,
      );
    } finally {
      await f.close();
    }
  },
);

it("requires both scopes and ownership and expires files across restart", async () => {
  const f = await fixture();
  try {
    for (const scope of ["carrot.read", "carrot.images"]) {
      f.scopes.delete(scope);
      for (const includeAttachment of [false, true])
        await expect(
          f.call("carrot_get_job_file", { jobId: f.jobId, includeAttachment }),
        ).rejects.toThrow(/scope/);
      f.scopes.add(scope);
    }
    for (const includeAttachment of [false, true])
      await expect(
        f.call(
          "carrot_get_job_file",
          { jobId: f.jobId, includeAttachment },
          { ...f.context, principalId: "other" },
        ),
      ).rejects.toThrow(/not found/);
    const restored = new McpOperationService(() => {}, Date.now, f.persistence);
    await restored.ready();
    try {
      expect(restored.status(f.jobId, "owner").result).toMatchObject({
        artifactExpired: true,
      });
      expect(() => restored.file(f.jobId, "owner")).toThrow(
        /export the current page/i,
      );
    } finally {
      await restored.close();
    }
  } finally {
    await f.close();
  }
});

it.each(["partial", "failed", "cancelled"])(
  "never returns a file for %s results",
  async (status) => {
    const service = new McpOperationService(() => {});
    const job = await service.start({
      owner: "owner",
      requestId: randomUUID(),
      kind: "exportPng",
      parameters: {},
      assertAuthorized: () => {},
      execute: async () => ({
        status,
        kind: "rendered-page-png",
        url: "https://private.test",
        bytes: 1,
      }),
    });
    await tick();
    try {
      expect(() => service.file(job.jobId, "owner")).toThrow();
      expect(JSON.stringify(service.status(job.jobId, "owner"))).not.toContain(
        "private.test",
      );
    } finally {
      await service.close();
    }
  },
);

it("withholds files until the final receipt is durably saved", async () => {
  let release!: () => void;
  let saves = 0;
  const service = new McpOperationService(() => {}, Date.now, {
    load: async () => null,
    save: async () => {
      if (++saves === 2)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
    },
  });
  const target = {
    chapterId: "chapter",
    pageId: "page",
    revision: "page-v1:0000000000000000",
    requestId: randomUUID(),
  };
  const job = await service.start({
    owner: "owner",
    requestId: target.requestId,
    kind: "exportPng",
    parameters: target,
    assertAuthorized: () => {},
    execute: async () => ({
      kind: "rendered-page-png",
      url: "https://private.test",
      bytes: 1,
    }),
  });
  await tick();
  expect(service.status(job.jobId, "owner").status).toBe("running");
  expect(() => service.file(job.jobId, "owner")).toThrow();
  release();
  await service.close();
});

it("requires a valid job ID and explicit image-scope verification before checking the file", async () => {
  const f = await fixture();
  try {
    for (const args of [
      {},
      { jobId: "not-a-uuid" },
      { jobId: f.jobId, extra: true },
      { jobId: f.jobId, includeAttachment: "true" },
      { jobId: f.jobId, includeAttachment: 1 },
      { jobId: f.jobId, includeAttachment: null },
      { jobId: f.jobId, includeAttachment: [] },
    ])
      await expect(f.call("carrot_get_job_file", args)).rejects.toThrow();
    const check = vi.fn(async () => {});
    const tools = createMcpOperationTools(
      f.operations,
      { exportPng: async () => ({}) },
      check,
    );
    const file = tools.find((tool) => tool.name === "carrot_get_job_file");
    if (!file) throw new Error("Missing file tool");
    await expect(
      file.invoke(
        { jobId: f.jobId },
        {
          principalId: "owner",
          assertAuthorized: () => {},
        },
      ),
    ).rejects.toMatchObject({ code: "access_denied" });
    expect(check).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it("does not turn malformed internal output metadata into a file attachment", async () => {
  const operations = new McpOperationService(() => {});
  const check = vi.fn(async () => {});
  const execute = async () => ({
    kind: "rendered-page-png",
    url: "https://carrot.test/not-a-file",
    bytes: "bad",
  });
  try {
    const job = await operations.start({
      owner: "owner",
      requestId: randomUUID(),
      kind: "exportPng",
      parameters: {},
      assertAuthorized: () => {},
      execute,
    });
    await vi.waitFor(() =>
      expect(operations.status(job.jobId, "owner").status).toBe("completed"),
    );
    const file = createMcpOperationTools(
      operations,
      { exportPng: execute },
      check,
    ).find((tool) => tool.name === "carrot_get_job_file");
    if (!file) throw new Error("Missing file tool");
    await expect(
      file.invoke(
        { jobId: job.jobId },
        {
          principalId: "owner",
          assertAuthorized: () => {},
          assertScopes: () => {},
        },
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(check).not.toHaveBeenCalled();
  } finally {
    await operations.close();
  }
});
