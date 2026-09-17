import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { exportFixture, readExportZip } from "./mcpExportBatch.fixture";
import { McpOperationService } from "../src/main/application/mcpOperationService";
import {
  McpExportPreflightInput,
  McpExportPagesTargetSchema,
  McpExportPreflightOutput,
} from "../src/shared/mcpExportBatch";

it("preflights in chapter order and exports without changing saved page data", async () => {
  const f = exportFixture();
  try {
    const before = structuredClone(f.chapter);
    const plan = await f.service.preflight(
      { chapterId: "chapter", pageIds: ["p3", "p1"] },
      f.assertRetained,
    );
    expect(McpExportPreflightOutput.parse(plan)).toEqual(plan);
    expect(plan.pages.map((page) => page.filename)).toEqual([
      "0001.png",
      "0003.png",
    ]);
    expect(JSON.stringify(plan)).not.toMatch(
      /private|sourceText|translatedText|dataUrl/,
    );
    const result = await f.service.run(
      await f.target(["p3", "p1"]),
      f.context,
      f.assertRetained,
    );
    expect(result.status).toBe("completed");
    expect(result.exportPages.completed).toBe(2);
    expect(f.render.mock.calls.map(([page]) => page.id)).toEqual(["p1", "p3"]);
    expect(f.chapter).toEqual(before);
  } finally {
    await f.close();
  }
});

it("packages actual existing files with stable order, exact bytes and a sanitized manifest", async () => {
  const f = exportFixture();
  try {
    const result = await f.run();
    const zip = await f.zip(result);
    expect(zip).toMatchObject({
      kind: "rendered-pages-zip",
      partialOutput: false,
      pageCount: 3,
    });
    const files = readExportZip(await f.read(zip.url as string));
    expect(Object.keys(files)).toEqual([
      "0001.png",
      "0002.png",
      "0003.png",
      "manifest.json",
    ]);
    for (const page of result.exportPages.pages)
      expect(files[page.filename]).toEqual(await f.file(page));
    expect(files["manifest.json"].toString()).not.toMatch(
      /mcp-artifacts|private|sourceText|translatedText|"url"/,
    );
    const again = await f.zip(result);
    expect(again.sha256).toBe(zip.sha256);
    expect(f.render).toHaveBeenCalledTimes(3);
  } finally {
    await f.close();
  }
});

it.each(["render error", "cancellation"])(
  "stops after %s and preserves completed files for an explicit partial ZIP",
  async (mode) => {
    const f = exportFixture();
    try {
      f.render.mockImplementation(async (page) => {
        if (page.id === "p2") {
          if (mode === "cancellation") f.controller.abort();
          throw new Error("fixture failure with private details");
        }
        return Buffer.from(`PNG fixture ${page.id}`);
      });
      const result = await f.run();
      expect(result.status).toBe(
        mode === "cancellation" ? "cancelled" : "partial",
      );
      expect(result.exportPages.pages.map((page) => page.status)).toEqual([
        "exported",
        mode === "cancellation" ? "cancelled" : "failed",
        "unprocessed",
      ]);
      await expect(f.zip(result)).rejects.toMatchObject({
        code: "invalid_edit",
      });
      const zip = await f.zip(result, true);
      const entries = readExportZip(await f.read(zip.url as string));
      expect(Object.keys(entries)).toEqual(["0001.png", "manifest.json"]);
      expect(
        JSON.parse(entries["manifest.json"].toString()).partialOutput,
      ).toBe(true);
      expect(f.render).toHaveBeenCalledTimes(2);
      expect(f.reportError).toHaveBeenCalledOnce();
      expect(JSON.stringify(result)).not.toContain("private details");
    } finally {
      await f.close();
    }
  },
);

it.each([
  "revision",
  "order",
  "stored order",
  "membership",
  "revocation",
  "expiry",
  "stop",
])("rejects retained output and ZIP use after %s", async (change) => {
  const f = exportFixture();
  try {
    const result = await f.run();
    if (change === "revision")
      f.chapter.pages[0].blocks[0].translatedText = "changed";
    if (change === "order") f.chapter.pages.reverse();
    if (change === "stored order") f.chapter.pageOrder.reverse();
    if (change === "membership") f.chapter.workId = "different";
    if (change === "revocation") f.revoke();
    if (change === "expiry") f.expire();
    if (change === "stop") f.store.stop();
    await expect(f.file(result.exportPages.pages[0])).rejects.toThrow();
    await expect(f.zip(result)).rejects.toThrow();
    expect(f.render).toHaveBeenCalledTimes(3);
  } finally {
    await f.close();
  }
});

it("rejects invalid, duplicate, absent, oversized and stale targets before rendering", async () => {
  const f = exportFixture();
  try {
    for (const pageIds of [
      [],
      ["p1", "p1"],
      ["missing"],
      Array.from({ length: 51 }, (_, i) => `p${i}`),
    ])
      await expect(f.target(pageIds)).rejects.toThrow();
    const target = await f.target();
    f.chapter.pages[0].blocks[0].sourceText = "modified";
    await expect(
      f.service.run(target, f.context, f.assertRetained),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    expect(f.render).not.toHaveBeenCalled();
    expect(
      McpExportPreflightInput.safeParse({
        chapterId: "chapter",
        path: "C:/private",
      }).success,
    ).toBe(false);
    expect(
      McpExportPagesTargetSchema.safeParse({ ...target, pages: [] }).success,
    ).toBe(false);
    expect(
      McpExportPagesTargetSchema.safeParse({ ...target, requestId: "bad" })
        .success,
    ).toBe(false);
  } finally {
    await f.close();
  }
});

it("retains metadata-only durable receipts and prevents duplicate execution or other-owner output access", async () => {
  const f = exportFixture();
  let saved: unknown;
  const persistence = {
    load: async () => saved,
    save: async (value: unknown) => {
      saved = structuredClone(value);
    },
  };
  const operations = new McpOperationService(
    f.reportError,
    Date.now,
    persistence,
  );
  try {
    const target = await f.target();
    const request = {
      owner: "owner",
      kind: "exportPages",
      requestId: target.requestId,
      parameters: target,
      assertAuthorized: f.assertRetained,
      execute: (job: typeof f.context) =>
        f.service.run(target, job, f.assertRetained),
    };
    const receipt = await operations.start(request);
    await vi.waitFor(() =>
      expect(operations.status(receipt.jobId, "owner").status).toBe(
        "completed",
      ),
    );
    expect((await operations.start(request)).jobId).toBe(receipt.jobId);
    const publicResult = operations.status(receipt.jobId, "owner");
    expect(publicResult.result?.exportPages?.completed).toBe(3);
    expect(JSON.stringify(publicResult)).not.toMatch(
      /mcp-artifacts|"url"|private/,
    );
    expect(JSON.stringify(saved)).not.toMatch(/mcp-artifacts|"url"|private/);
    expect(() => operations.file(receipt.jobId, "other", "p1")).toThrow();
    expect(() => operations.file(receipt.jobId, "owner")).toThrow();
    const file = operations.file(receipt.jobId, "owner", "p1");
    expect(await f.read(file.url as string)).toEqual(
      Buffer.from("PNG fixture p1"),
    );
    expect(() =>
      operations.retryTarget(receipt.jobId, "owner", target.pages[0].revision),
    ).toThrow();
    const restored = new McpOperationService(
      f.reportError,
      Date.now,
      persistence,
    );
    await restored.ready();
    expect(
      restored.status(receipt.jobId, "owner").result?.artifactExpired,
    ).toBe(true);
    expect(() => restored.file(receipt.jobId, "owner", "p1")).toThrow();
    await restored.close();
    expect(f.render).toHaveBeenCalledTimes(3);
    await expect(
      operations.start({
        ...request,
        parameters: { ...target, snapshot: "0000000000000000" },
      }),
    ).rejects.toThrow();
  } finally {
    await operations.close();
    await f.close();
  }
});

it("checks source identity without interpreting attacker-supplied paths as ZIP entries", async () => {
  const f = exportFixture();
  try {
    const result = await f.run();
    const url = result.exportPages.pages[0].url;
    if (!url) throw new Error("Missing fixture output");
    for (const filename of [
      "../outside.png",
      "C:/private.png",
      "ordinary.txt",
      "0001.png/extra",
    ])
      await expect(
        f.store.zip(
          [{ url, filename }],
          {},
          async () => {},
          new AbortController().signal,
        ),
      ).rejects.toThrow();
    const abort = new AbortController();
    abort.abort();
    await expect(
      f.store.zip(
        [{ url, filename: "0001.png" }],
        {},
        async () => {},
        abort.signal,
      ),
    ).rejects.toThrow();
    await expect(
      f.store.assertAvailable(
        "https://other.test/mcp-artifacts/" + randomUUID() + "/page.png",
      ),
    ).rejects.toThrow();
  } finally {
    await f.close();
  }
});
