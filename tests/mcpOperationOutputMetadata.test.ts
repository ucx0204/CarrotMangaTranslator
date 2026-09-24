import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { McpExportPagesTargetSchema } from "../src/shared/mcpExportBatch";
import { mcpPageOutputFormat } from "../src/shared/mcpOutputFormats";
import {
  mcpOperationFile,
  mcpOperationOutputMetadata,
} from "../src/main/application/mcpOperationOutputs";
import { persistedMcpJobResult } from "../src/main/application/mcpJobJournal";
import { workFileJobData } from "./mcpWorkFileJob.fixture";
import { exchangeJobData } from "./mcpExchangeJob.fixture";

const bytes = 128;
const sha256 = "a".repeat(64);
const url = "https://carrot.test/mcp-artifacts/session/page.png";
function pngJob() {
  const requestId = randomUUID();
  const parameters = {
    chapterId: "chapter",
    pageId: "first",
    revision: "page-v1:0123456789abcdef",
    requestId,
  };
  return {
    kind: "exportPng",
    requestId,
    parameters,
    status: "completed",
    settled: true,
    result: {
      ...parameters,
      kind: "rendered-page-png",
      mimeType: "image/png",
      bytes,
      sha256,
      retainedOutputId: randomUUID(),
      url,
      expiresAt: 600_100,
      access: "single-file-link",
    },
  };
}
function zipJob() {
  const requestId = randomUUID();
  const parameters = {
    sourceJobId: randomUUID(),
    allowPartial: true,
    requestId,
  };
  return {
    kind: "exportZip",
    requestId,
    parameters,
    status: "completed",
    settled: true,
    result: {
      kind: "rendered-pages-zip",
      mimeType: "application/zip",
      filename: "carrot-pages.zip",
      sourceJobId: parameters.sourceJobId,
      partialOutput: true,
      pageCount: 1,
      bytes,
      sha256,
      retainedOutputId: randomUUID(),
      url: url.replace("page.png", "pages.zip"),
      expiresAt: 600_100,
      access: "single-file-link",
    },
  };
}
function pageJob(imageExport?: unknown) {
  const requestId = randomUUID();
  const parameters = McpExportPagesTargetSchema.parse({
    chapterId: "chapter",
    snapshot: "0123456789abcdef",
    requestId,
    pages: ["first", "second"].map((pageId) => ({
      pageId,
      revision: "page-v1:0123456789abcdef",
    })),
    ...(imageExport ? { imageExport } : {}),
  });
  const policy = parameters.imageExport;
  const source = policy?.format === "source";
  const options = source
    ? {
        format: "jpeg" as const,
        omitText: policy.omitText,
        quality: policy.jpegQuality,
      }
    : policy;
  const { mimeType, extension } = mcpPageOutputFormat(options?.format ?? "png");
  const exportPages = {
    chapterId: parameters.chapterId,
    snapshot: parameters.snapshot,
    total: 2,
    completed: 1,
    ...(policy ? { imageExport: policy } : {}),
    pages: parameters.pages.map((page, index) => ({
      ...page,
      pageIndex: index,
      filename: `${index + 1}.${extension}`,
      width: 20,
      height: 20,
      status: index === 0 ? "exported" : "unprocessed",
      ...(source
        ? {
            imageExport: options,
            sourceFormatBasis: "saved-source-name",
            fallback: "none",
          }
        : {}),
      ...(index === 0
        ? {
            bytes,
            sha256,
            retainedOutputId: randomUUID(),
            url,
            ...(policy ? { mimeType } : {}),
          }
        : {}),
    })),
  };
  return {
    kind: "exportPages",
    requestId,
    parameters,
    status: "partial",
    settled: true,
    result: {
      kind: policy ? "rendered-pages-images" : "rendered-pages-png",
      status: "partial",
      exportPages,
    },
  };
}

it("reports safe live and historical PNG, ZIP and native metadata without manufacturing a URL", () => {
  const native = workFileJobData();
  const entries = [
    pngJob(),
    zipJob(),
    { ...native.record, result: native.result, settled: true },
  ];
  for (const entry of entries) {
    const result = {
      ...entry.result,
      rawText: "private payload",
      sourcePath: "C:/private/source",
      token: "secret",
    };
    const expected = {
      mimeType: result.mimeType,
      bytes: result.bytes,
      sha256: result.sha256,
      retainedOutputId: result.retainedOutputId,
    };
    expect(mcpOperationOutputMetadata({ ...entry, result })).toEqual({
      artifact: expected,
      url: result.url,
    });
    const historical = { ...entry, result: persistedMcpJobResult(result) };
    expect(mcpOperationOutputMetadata(historical)).toEqual({
      artifact: expected,
    });
    expect(JSON.stringify(mcpOperationOutputMetadata(historical))).not.toMatch(
      /private|secret|"url"/,
    );
  }
});

it("distinguishes pending or failed exports from unsupported operations and invalid page selection", () => {
  const file = pngJob();
  const pages = pageJob();
  for (const entry of [file, pages]) {
    for (const status of ["running", "failed", "cancelled", "interrupted"])
      expect(
        mcpOperationOutputMetadata(
          {
            ...entry,
            result: undefined,
            status,
            settled: status !== "running",
          },
          entry.kind === "exportPages" ? "first" : undefined,
        ),
      ).toBeUndefined();
  }
  expect(() => mcpOperationOutputMetadata({ ...file, kind: "ocr" })).toThrow(
    /does not produce/,
  );
  expect(() => mcpOperationOutputMetadata(file, "first")).toThrow(/whole file/);
  expect(() => mcpOperationOutputMetadata(pages)).toThrow(/Select one/);
  expect(() =>
    mcpOperationOutputMetadata({ ...pages, settled: false }, "unknown"),
  ).toThrow(/not selected/);
  expect(mcpOperationOutputMetadata(pages, "second")).toBeUndefined();
  expect(
    mcpOperationOutputMetadata({ ...pages, settled: false }, "first"),
  ).toBeUndefined();
});

it.each([
  [undefined, "image/png"],
  [{ format: "jpeg", quality: 82 }, "image/jpeg"],
  [{ format: "webp", quality: 83 }, "image/webp"],
  [
    {
      format: "psd",
      acknowledgeOriginalLayer: true,
      acknowledgeRasterLayers: true,
    },
    "image/vnd.adobe.photoshop",
  ],
  [
    {
      format: "source",
      jpegQuality: 84,
      webpQuality: 85,
      unsupportedSource: "png",
    },
    "image/jpeg",
  ],
] as const)(
  "resolves a retained selected page to its concrete encoded MIME (%s)",
  (options, mimeType) => {
    const entry = pageJob(options);
    const first = entry.result.exportPages.pages[0];
    const expected = {
      mimeType,
      bytes,
      sha256,
      retainedOutputId: first.retainedOutputId,
    };
    expect(mcpOperationOutputMetadata(entry, "first")).toEqual({
      artifact: expected,
      url,
    });
    const historical = {
      ...entry,
      result: persistedMcpJobResult(entry.result),
    };
    expect(mcpOperationOutputMetadata(historical, "first")).toEqual({
      artifact: expected,
    });
    expect(mcpOperationFile(entry, "first")).toMatchObject({ mimeType });
  },
);

it("rejects mismatched page result membership, revisions, order and batch options", () => {
  const f = pageJob({ format: "webp", quality: 83 });
  const data = f.result.exportPages;
  for (const patch of [
    { chapterId: "other" },
    { snapshot: "fedcba9876543210" },
    { total: 1 },
    { completed: 2 },
    { pages: [...data.pages].reverse() },
    { pages: data.pages.slice(0, 1) },
    { imageExport: { format: "webp", quality: 81, omitText: false } },
    {
      pages: data.pages.map((page) => ({
        ...page,
        revision: "page-v1:fedcba9876543210",
      })),
    },
    { pages: data.pages.map((page) => ({ ...page, pageId: "other" })) },
  ])
    expect(() =>
      mcpOperationOutputMetadata(
        { ...f, result: { ...f.result, exportPages: { ...data, ...patch } } },
        "first",
      ),
    ).toThrow();
  expect(() =>
    mcpOperationOutputMetadata(
      { ...f, result: { ...f.result, kind: "rendered-pages-png" } },
      "first",
    ),
  ).toThrow();
  expect(() =>
    mcpOperationOutputMetadata({ ...f, requestId: randomUUID() }, "first"),
  ).toThrow();
});

it("checks encoded source policy quality, text omission and fallback before file or metadata projection", () => {
  const f = pageJob({
    format: "source",
    jpegQuality: 84,
    webpQuality: 85,
    unsupportedSource: "reject",
  });
  const data = f.result.exportPages;
  for (const patch of [
    { mimeType: "image/webp" },
    { filename: "1.webp" },
    { sourceFormatBasis: undefined },
    { fallback: undefined },
    { fallback: "unsupported-source-to-png" },
    { imageExport: undefined },
    { imageExport: { format: "jpeg", quality: 80, omitText: false } },
    { imageExport: { format: "jpeg", quality: 84, omitText: true } },
  ]) {
    const entry = {
      ...f,
      result: {
        ...f.result,
        exportPages: {
          ...data,
          pages: data.pages.map((page, index) =>
            index === 0 ? { ...page, ...patch } : page,
          ),
        },
      },
    };
    expect(() => mcpOperationOutputMetadata(entry, "first")).toThrow();
    expect(() => mcpOperationFile(entry, "first")).toThrow();
  }
});

it("rejects malformed file identity and target substitutions before returning safe metadata", () => {
  const png = pngJob();
  for (const patch of [
    { bytes: 0 },
    { bytes: 1.5 },
    { sha256: "invalid" },
    { retainedOutputId: "invalid" },
    { mimeType: "text/plain" },
    { kind: "exchange-file" },
    { url: "not-a-url" },
    { pageId: "other" },
    { chapterId: "other" },
    { revision: "page-v1:fedcba9876543210" },
  ])
    expect(() =>
      mcpOperationOutputMetadata({
        ...png,
        result: { ...png.result, ...patch },
      }),
    ).toThrow();
  expect(() =>
    mcpOperationOutputMetadata({ ...png, requestId: randomUUID() }),
  ).toThrow();
  expect(() =>
    mcpOperationOutputMetadata({
      ...png,
      parameters: { ...png.parameters, blockId: "block" },
    }),
  ).toThrow();
  const zip = zipJob();
  for (const patch of [
    { sourceJobId: randomUUID() },
    { partialOutput: "yes" },
    { pageCount: 0 },
  ])
    expect(() =>
      mcpOperationOutputMetadata({
        ...zip,
        result: { ...zip.result, ...patch },
      }),
    ).toThrow();
  expect(() =>
    mcpOperationOutputMetadata({
      ...zip,
      parameters: { ...zip.parameters, allowPartial: false },
    }),
  ).toThrow();
  const native = workFileJobData();
  for (const patch of [
    { mimeType: "application/zip" },
    { filename: "private.mgtshare" },
    { workFileExport: { ...native.metadata, snapshot: "fedcba9876543210" } },
  ])
    expect(() =>
      mcpOperationOutputMetadata({
        ...native.record,
        settled: true,
        result: { ...native.result, ...patch },
      }),
    ).toThrow();
});

it("uses exact context and text export bindings for diagnostics and never accepts an unreviewed whole-file target", () => {
  for (const format of ["csv", "context"] as const) {
    const f = exchangeJobData(format);
    const entry = { ...f.record, settled: true, result: f.result };
    expect(mcpOperationOutputMetadata(entry)).toEqual({
      url: f.result.url,
      artifact: {
        mimeType: f.result.mimeType,
        bytes,
        sha256,
        retainedOutputId: f.result.retainedOutputId,
      },
    });
    expect(() => mcpOperationOutputMetadata(entry, "first")).toThrow();
    expect(() =>
      mcpOperationOutputMetadata({ ...entry, requestId: randomUUID() }),
    ).toThrow();
    expect(() =>
      mcpOperationOutputMetadata({
        ...entry,
        result: { ...f.result, filename: "private.txt" },
      }),
    ).toThrow();
    expect(() =>
      mcpOperationOutputMetadata({
        ...entry,
        result: {
          ...f.result,
          exchange: { ...f.binding, snapshot: "fedcba9876543210" },
        },
      }),
    ).toThrow();
    expect(
      mcpOperationOutputMetadata({
        ...entry,
        settled: false,
        result: undefined,
      }),
    ).toBeUndefined();
  }
});
