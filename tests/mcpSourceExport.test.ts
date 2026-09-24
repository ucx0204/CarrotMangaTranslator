import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { sourceExportFixture, sourcePolicy } from "./mcpSourceExport.fixture";
import { readExportZip } from "./mcpExportBatch.fixture";
import { createPageRevision } from "../src/shared/pageRevision";
import {
  McpExportPreflightInput,
  McpExportPreflightOutput,
  McpExportPagesMetadataSchema,
  McpBatchRasterExportOptionsSchema,
  type McpBatchExportOptions,
} from "../src/shared/mcpExportBatch";
import { McpPageExportOptionsSchema } from "../src/shared/mcpOutputFormats";
import { mcpExportSnapshot } from "../src/main/application/mcpExportSelection";
import { mcpOperationFile } from "../src/main/application/mcpOperationOutputs";
import { mcpJobFileOutput } from "../src/main/mcp/mcpJobOutputSchema";
import { McpOperationService } from "../src/main/application/mcpOperationService";

it("requires explicit bounded source qualities and fallback without widening single-page formats", () => {
  expect(McpBatchRasterExportOptionsSchema.parse(sourcePolicy)).toEqual(
    sourcePolicy,
  );
  for (const change of [
    { jpegQuality: undefined },
    { webpQuality: undefined },
    { unsupportedSource: undefined },
    { jpegQuality: 0 },
    { jpegQuality: 101 },
    { webpQuality: 1.5 },
    { quality: 90 },
    { unsupportedSource: "webp" },
    { path: "C:/private.png" },
  ]) {
    expect(
      McpExportPreflightInput.safeParse({
        chapterId: "chapter",
        imageExport: { ...sourcePolicy, ...change },
      }).success,
    ).toBe(false);
  }
  expect(McpPageExportOptionsSchema.safeParse(sourcePolicy).success).toBe(
    false,
  );
  expect(
    McpPageExportOptionsSchema.safeParse({
      format: "psd",
      acknowledgeOriginalLayer: true,
      acknowledgeRasterLayers: true,
    }).success,
  ).toBe(true);
});

it("reviews mixed saved-source codecs, canonical names and explicit fallback without disclosing names", async () => {
  const f = sourceExportFixture();
  try {
    const plan = await f.plan(["p4", "p2", "p1", "p3"]);
    expect(McpExportPreflightOutput.parse(plan)).toEqual(plan);
    expect(plan.pages.map((page) => page.filename)).toEqual([
      "0001.png",
      "0002.jpg",
      "0003.webp",
      "0004.png",
    ]);
    expect(plan.pages.map((page) => page.imageExport)).toEqual([
      { format: "png", omitText: false },
      { format: "jpeg", omitText: false, quality: 85 },
      { format: "webp", omitText: false, quality: 92 },
      { format: "png", omitText: false },
    ]);
    expect(plan.pages.map((page) => page.fallback)).toEqual([
      "none",
      "none",
      "none",
      "unsupported-source-to-png",
    ]);
    expect(
      plan.pages.every(
        (page) => page.sourceFormatBasis === "saved-source-name",
      ),
    ).toBe(true);
    expect(JSON.stringify(plan)).not.toMatch(
      /private|sourceNameFingerprint|imagePath/,
    );
    expect(f.renderImage).not.toHaveBeenCalled();
    expect(f.preflight).toHaveBeenCalledOnce();
  } finally {
    await f.close();
  }
});

it("routes each reviewed concrete option through the existing image exporter, file projection and ZIP", async () => {
  const f = sourceExportFixture();
  try {
    const before = structuredClone(f.chapter);
    const result = await f.run();
    expect(result.status).toBe("completed");
    expect(f.render).not.toHaveBeenCalled();
    expect(
      f.renderImage.mock.calls.map(([, , options]) => options.format),
    ).toEqual(["png", "jpeg", "webp", "png"]);
    const output = await f.zip(result);
    const entries = readExportZip(await f.read(output.url));
    expect(Object.keys(entries)).toEqual([
      "0001.png",
      "0002.jpg",
      "0003.webp",
      "0004.png",
      "manifest.json",
    ]);
    for (const page of result.exportPages.pages) {
      expect(entries[page.filename]).toEqual(await f.file(page));
      const file = mcpOperationFile(
        {
          kind: "exportPages",
          settled: true,
          status: "completed",
          result,
        },
        page.pageId,
      );
      expect(file.imageExport).toEqual(page.imageExport);
      expect(file.mimeType).toBe(page.mimeType);
      expect(
        mcpJobFileOutput.safeParse({ ...file, jobId: randomUUID() }).success,
      ).toBe(true);
    }
    const manifest = JSON.parse(entries["manifest.json"].toString());
    expect(manifest.imageExport).toEqual(sourcePolicy);
    expect(
      manifest.pages.map(
        (page: { imageExport: { format: string } }) => page.imageExport.format,
      ),
    ).toEqual(["png", "jpeg", "webp", "png"]);
    expect(entries["manifest.json"].toString()).not.toMatch(
      /private|sourceNameFingerprint|mcp-artifacts|"url"/,
    );
    expect(f.chapter).toEqual(before);
    expect(f.renderImage).toHaveBeenCalledTimes(4);
  } finally {
    await f.close();
  }
});

it("rejects unsupported sources before native preflight or rendering when fallback was not admitted", async () => {
  const f = sourceExportFixture();
  try {
    await expect(
      f.plan(undefined, { ...sourcePolicy, unsupportedSource: "reject" }),
    ).rejects.toMatchObject({ code: "invalid_edit" });
    expect(f.preflight).not.toHaveBeenCalled();
    expect(f.renderImage).not.toHaveBeenCalled();
    await expect(
      f.plan(["p1", "p2", "p3"], {
        ...sourcePolicy,
        unsupportedSource: "reject",
      }),
    ).resolves.toHaveProperty("snapshot");
  } finally {
    await f.close();
  }
});

it.each([
  "source name",
  "JPEG quality",
  "WebP quality",
  "fallback policy",
] as const)(
  "rejects a changed %s after source review without changing general page revisions",
  async (change) => {
    const f = sourceExportFixture();
    try {
      const target = await f.target(["p1", "p2", "p3"]);
      const before = f.chapter.pages.map(createPageRevision);
      const imageExport: Extract<McpBatchExportOptions, { format: "source" }> =
        { ...sourcePolicy };
      if (change === "source name")
        f.chapter.pages[1].sourceFileName = "private-changed.webp";
      if (change === "JPEG quality") imageExport.jpegQuality = 86;
      if (change === "WebP quality") imageExport.webpQuality = 93;
      if (change === "fallback policy")
        imageExport.unsupportedSource = "reject";
      expect(f.chapter.pages.map(createPageRevision)).toEqual(before);
      await expect(
        f.service.run({ ...target, imageExport }, f.context, f.assertRetained),
      ).rejects.toMatchObject({ code: "revision_conflict" });
      expect(f.renderImage).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  },
);

it("rechecks names after native preflight and after rendering before publication", async () => {
  const f = sourceExportFixture();
  try {
    f.preflight.mockImplementationOnce(async (_chapter, ids) => {
      f.chapter.pages[0].sourceFileName = "changed.jpg";
      return {
        workTitle: "fixture",
        chapterCount: 1,
        pageCount: ids.length,
        sampleRelativePath: "private",
        outputPolicy: "new-timestamped-folder",
        issues: [],
        targets: [],
      };
    });
    await expect(f.plan(["p1"])).rejects.toMatchObject({
      code: "revision_conflict",
    });
    f.renderImage.mockImplementationOnce(async () => {
      f.chapter.pages[0].sourceFileName = "changed.webp";
      return Buffer.from("external codec boundary");
    });
    const result = await f.run(["p1"]);
    expect(result.status).toBe("failed");
    expect(result.exportPages.pages[0]).toMatchObject({
      status: "failed",
      code: "revision_conflict",
    });
    expect(result.exportPages.pages[0].url).toBeUndefined();
    expect(result.exportPages.completed).toBe(0);
  } finally {
    await f.close();
  }
});

it("keeps source selection scoped and denies existing links or ZIP after selected-name drift", async () => {
  const f = sourceExportFixture();
  try {
    const result = await f.run(["p1"]);
    f.chapter.pages[1].sourceFileName = "unselected-change.jpg";
    await expect(f.file(result.exportPages.pages[0])).resolves.toBeInstanceOf(
      Buffer,
    );
    await expect(f.zip(result)).resolves.toHaveProperty("url");
    f.chapter.pages[0].sourceFileName = "selected-change.jpg";
    await expect(f.file(result.exportPages.pages[0])).rejects.toMatchObject({
      code: "revision_conflict",
    });
    await expect(f.zip(result)).rejects.toMatchObject({
      code: "revision_conflict",
    });
    expect(f.renderImage).toHaveBeenCalledOnce();
  } finally {
    await f.close();
  }
});

it.each(["failure", "cancellation"] as const)(
  "preserves concrete completed members for an explicitly requested partial ZIP after %s",
  async (mode) => {
    const f = sourceExportFixture();
    try {
      f.renderImage.mockImplementation(async (page, _signal, options) => {
        if (page.id === "p2") {
          if (mode === "cancellation") f.controller.abort();
          throw new Error("codec failure");
        }
        return Buffer.from(`${options.format} fixture ${page.id}`);
      });
      const result = await f.run();
      expect(result.status).toBe(mode === "failure" ? "partial" : "cancelled");
      await expect(f.zip(result)).rejects.toMatchObject({
        code: "invalid_edit",
      });
      const output = await f.zip(result, true);
      const entries = readExportZip(await f.read(output.url));
      expect(Object.keys(entries)).toEqual(["0001.png", "manifest.json"]);
      expect(entries["0001.png"]).toEqual(Buffer.from("png fixture p1"));
      expect(
        JSON.parse(entries["manifest.json"].toString()).pages[0].imageExport
          .format,
      ).toBe("png");
      expect(f.renderImage).toHaveBeenCalledTimes(2);
    } finally {
      await f.close();
    }
  },
);

it("preserves old explicit-format and default PNG fingerprints on name-only changes", async () => {
  const f = sourceExportFixture();
  try {
    const explicit = { format: "jpeg", omitText: false, quality: 90 } as const;
    const legacy = mcpExportSnapshot(f.chapter);
    const oldExplicit = mcpExportSnapshot(f.chapter, explicit);
    for (const page of f.chapter.pages) {
      page.sourceFileName = "changed.webp";
      page.name = "changed-name.jpg";
    }
    expect(mcpExportSnapshot(f.chapter)).toBe(legacy);
    expect(mcpExportSnapshot(f.chapter, explicit)).toBe(oldExplicit);
    const plan = await f.plan(undefined, explicit);
    expect(plan.pages.every((page) => page.filename.endsWith(".jpg"))).toBe(
      true,
    );
    expect(JSON.stringify(plan)).not.toMatch(
      /sourceFormatBasis|fallback|sourceNameFingerprint/,
    );
  } finally {
    await f.close();
  }
});

it("persists reviewed policy and concrete page metadata while excluding private evidence and capabilities", async () => {
  const f = sourceExportFixture();
  let saved: unknown;
  const operations = new McpOperationService(vi.fn(), Date.now, {
    load: async () => saved,
    save: async (value) => {
      saved = structuredClone(value);
    },
  });
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
    await operations.waitForCompletion(
      receipt.jobId,
      "owner",
      f.controller.signal,
    );
    expect(operations.status(receipt.jobId, "owner").status).toBe("completed");
    expect((await operations.start(request)).jobId).toBe(receipt.jobId);
    const file = operations.file(receipt.jobId, "owner", "p2");
    expect(file.imageExport).toEqual({
      format: "jpeg",
      omitText: false,
      quality: 85,
    });
    expect(file.mimeType).toBe("image/jpeg");
    expect(JSON.stringify(saved)).not.toMatch(
      /private|sourceNameFingerprint|mcp-artifacts|"url"/,
    );
    expect(() => operations.file(receipt.jobId, "foreign", "p2")).toThrow();
    const pages = operations.exportSource(receipt.jobId, "owner").data;
    expect(
      McpExportPagesMetadataSchema.parse(pages).pages[1].imageExport?.format,
    ).toBe("jpeg");
    expect(
      mcpJobFileOutput.safeParse({
        ...file,
        jobId: receipt.jobId,
        imageExport: sourcePolicy,
      }).success,
    ).toBe(false);
    const corrupted = {
      ...pages,
      pages: pages.pages.map((page) => ({ ...page })),
    };
    corrupted.pages[1].mimeType = "image/webp";
    expect(() =>
      mcpOperationFile(
        {
          settled: true,
          status: "completed",
          kind: "exportPages",
          result: { exportPages: corrupted },
        },
        "p2",
      ),
    ).toThrow();
    expect(f.renderImage).toHaveBeenCalledTimes(4);
  } finally {
    await operations.close();
    await f.close();
  }
});
