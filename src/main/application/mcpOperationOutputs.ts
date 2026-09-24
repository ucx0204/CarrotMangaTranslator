import { z } from "zod/v4";
import {
  McpExportPagesMetadataSchema,
  McpExportPagesTargetSchema,
  McpExportZipTargetSchema,
  type McpBatchExportOptions,
} from "../../shared/mcpExportBatch";
import {
  McpWorkFileExportArtifactSchema,
  McpWorkFileExportTargetSchema,
} from "../../shared/mcpWorkFileExport";
import { McpExchangeFileArtifactSchema } from "../../shared/mcpExchangeFiles";
import { hashStableValue } from "../../shared/blockFingerprint";
import {
  mcpPageOutputFormat,
  type McpArtifactMime,
} from "../../shared/mcpOutputFormats";
import { McpEditError } from "./mcpEditPolicy";
import {
  mcpExchangeFileMetadataSchema,
  mcpExchangeMetadataInput,
  validMcpExchangeJobReferences,
} from "./mcpExchangeJobPolicy";
import {
  mcpJobResultMetadataSchema,
  mcpJobTargetSchema,
} from "./mcpJobJournal";
import { validMcpJobReferences } from "./mcpJobReferencePolicy";

type Entry = {
  settled: boolean;
  status: string;
  kind: string;
  parameters?: unknown;
  requestId?: string;
  result?: Record<string, unknown>;
};
const retainedPages = McpExportPagesMetadataSchema.extend({
  pages: z
    .array(
      McpExportPagesMetadataSchema.shape.pages.element.extend({
        url: z.string().url().optional(),
      }),
    )
    .max(50),
});
export function mcpExportSource(entry: Entry) {
  if (
    !entry.settled ||
    entry.kind !== "exportPages" ||
    !entry.result?.exportPages
  )
    throw unavailable();
  return {
    status: entry.status,
    data: retainedPages.parse(entry.result.exportPages),
  };
}
export function mcpOperationFile(
  entry: Entry,
  pageId?: string,
): Record<string, unknown> {
  if (entry.kind !== "exportPages") return singleFile(entry, pageId);
  if (!pageId)
    throw new McpEditError(
      "invalid_edit",
      "Select an exported pageId, or explicitly create a ZIP from this job.",
    );
  return selectedFile(mcpExportSource(entry), pageId);
}
function selectedFile(
  source: ReturnType<typeof mcpExportSource>,
  pageId: string,
) {
  const page = source.data.pages.find((item) => item.pageId === pageId);
  if (!page || page.status !== "exported" || !page.url) throw unavailable();
  const { options, mimeType } = selectedFormat(source.data, page);
  return {
    ...page,
    kind: options ? "rendered-page-image" : "rendered-page-png",
    chapterId: source.data.chapterId,
    mimeType,
    ...(options ? { imageExport: options } : {}),
    access:
      "single-file-link; expires on stop, revocation, page change or redaction change",
  };
}
/** Resolve reviewed source policy to its actual encoded page metadata. */
function selectedFormat(
  data: ReturnType<typeof mcpExportSource>["data"],
  page: ReturnType<typeof mcpExportSource>["data"]["pages"][number],
) {
  const policy = data.imageExport;
  const options =
    policy?.format === "source" ? checkedSourceOptions(policy, page) : policy;
  const { mimeType, extension } = mcpPageOutputFormat(options?.format ?? "png");
  if (
    (options && page.mimeType !== mimeType) ||
    !page.filename.endsWith(`.${extension}`)
  )
    throw unavailable();
  return { options, mimeType };
}
function sourceOptions(
  page: ReturnType<typeof mcpExportSource>["data"]["pages"][number],
) {
  if (
    !page.imageExport ||
    page.sourceFormatBasis !== "saved-source-name" ||
    !page.fallback
  )
    throw unavailable();
  return page.imageExport;
}
function checkedSourceOptions(
  policy: Extract<McpBatchExportOptions, { format: "source" }>,
  page: ReturnType<typeof mcpExportSource>["data"]["pages"][number],
) {
  const options = sourceOptions(page);
  const quality =
    options.format === "jpeg"
      ? policy.jpegQuality
      : options.format === "webp"
        ? policy.webpQuality
        : undefined;
  if (options.omitText !== policy.omitText || options.quality !== quality)
    throw unavailable();
  if (
    page.fallback !== "none" &&
    (policy.unsupportedSource !== "png" || options.format !== "png")
  )
    throw unavailable();
  return options;
}
const singleFileKinds: Record<string, string> = {
  exportPng: "rendered-page-png",
  exportZip: "rendered-pages-zip",
  workFileExport: "native-work-file",
  textFileExport: "exchange-file",
  contextFileExport: "exchange-file",
};
function singleFile(entry: Entry, pageId?: string): Record<string, unknown> {
  const expected = singleFileKinds[entry.kind];
  if (
    pageId ||
    !entry.settled ||
    entry.status !== "completed" ||
    !expected ||
    entry.result?.kind !== expected ||
    typeof entry.result?.url !== "string"
  )
    throw unavailable();
  if (entry.kind === "workFileExport") {
    const output = McpWorkFileExportArtifactSchema.safeParse(entry.result);
    if (!output.success) throw unavailable();
    return output.data;
  }
  if (expected === "exchange-file") {
    return exchangeFile(entry);
  }
  return structuredClone(entry.result);
}
function exchangeFile(entry: Entry): Record<string, unknown> {
  const output = McpExchangeFileArtifactSchema.safeParse(entry.result);
  if (!output.success || !validMcpExchangeJobReferences(entry))
    throw unavailable();
  return output.data;
}

const metadataArtifact = z.object({
  bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  retainedOutputId: z.uuid().optional(),
  url: z.string().url().optional(),
});
type OutputMetadata = {
  artifact: {
    mimeType: McpArtifactMime;
    bytes: number;
    sha256: string;
    retainedOutputId?: string;
  };
  url?: string;
};
/** Internal delivery inspection uses the same owned job and source selection as
 * retrieval. It neither creates a capability nor reads or discloses file bytes. */
export function mcpOperationOutputMetadata(
  entry: Entry,
  pageId?: string,
): OutputMetadata | undefined {
  if (entry.kind === "exportPages") return pageMetadata(entry, pageId);
  if (!singleFileKinds[entry.kind])
    throw new McpEditError(
      "invalid_edit",
      "This operation does not produce a downloadable file.",
    );
  if (pageId !== undefined)
    throw new McpEditError(
      "invalid_edit",
      "This operation produces one whole file; omit pageId.",
    );
  assertSingleTarget(entry);
  if (!entry.settled || !entry.result || entry.status !== "completed")
    return undefined;
  if (entry.result.kind !== singleFileKinds[entry.kind]) throw unavailable();
  if (entry.result.kind === "exchange-file") {
    const result = mcpExchangeFileMetadataSchema
      .strip()
      .safeParse(entry.result);
    if (
      !result.success ||
      (entry.result.url !== undefined &&
        !McpExchangeFileArtifactSchema.safeParse(entry.result).success)
    )
      throw unavailable();
    return outputMetadata(entry.result, result.data.mimeType);
  }
  return legacyMetadata(entry);
}
function outputMetadata(
  result: Record<string, unknown>,
  mimeType: McpArtifactMime,
): OutputMetadata {
  const parsed = metadataArtifact.safeParse(result);
  if (
    !parsed.success ||
    (result.mimeType !== undefined && result.mimeType !== mimeType)
  )
    throw unavailable();
  const { url, ...artifact } = parsed.data;
  return { artifact: { mimeType, ...artifact }, ...(url ? { url } : {}) };
}
function assertSingleTarget(entry: Entry) {
  if (["textFileExport", "contextFileExport"].includes(entry.kind)) {
    if (!validMcpExchangeJobReferences(entry)) throw unavailable();
    return;
  }
  const schemas: Record<string, z.ZodType<{ requestId: string }>> = {
    exportPng: mcpJobTargetSchema,
    exportZip: McpExportZipTargetSchema,
    workFileExport: McpWorkFileExportTargetSchema,
  };
  const target = schemas[entry.kind]?.safeParse(entry.parameters);
  if (!target?.success || target.data.requestId !== entry.requestId)
    throw unavailable();
  assertLegacyResultReference(entry);
  if (entry.kind === "exportPng") assertPngTarget(entry.parameters);
}
function assertLegacyResultReference(entry: Entry) {
  const parsed = mcpJobResultMetadataSchema.safeParse(
    mcpExchangeMetadataInput(entry.result),
  );
  if (entry.result !== undefined && !parsed.success) throw unavailable();
  if (
    !validMcpJobReferences({
      ...entry,
      parameters: entry.parameters,
      requestId: entry.requestId ?? "",
      result: parsed.data,
    })
  )
    throw unavailable();
}
function assertPngTarget(value: unknown) {
  const target = mcpJobTargetSchema.parse(value);
  if (target.blockId !== undefined || target.contextMode !== undefined)
    throw unavailable();
}
function legacyMetadata(entry: Entry): OutputMetadata {
  const result = entry.result;
  if (!result) throw unavailable();
  if (entry.kind === "workFileExport") return nativeMetadata(result);
  if (entry.kind === "exportZip") return zipMetadata(entry, result);
  const target = mcpJobTargetSchema.parse(entry.parameters);
  if (
    result.chapterId !== target.chapterId ||
    result.pageId !== target.pageId ||
    result.revision !== target.revision
  )
    throw unavailable();
  return outputMetadata(result, "image/png");
}
function nativeMetadata(result: Record<string, unknown>): OutputMetadata {
  if (
    !result.workFileExport ||
    !McpWorkFileExportArtifactSchema.shape.bytes.safeParse(result.bytes).success
  )
    throw unavailable();
  if (
    result.url !== undefined &&
    !McpWorkFileExportArtifactSchema.safeParse(result).success
  )
    throw unavailable();
  return outputMetadata(result, "application/vnd.carrot.mgtshare");
}
function zipMetadata(
  entry: Entry,
  result: Record<string, unknown>,
): OutputMetadata {
  const target = McpExportZipTargetSchema.parse(entry.parameters);
  if (
    result.sourceJobId !== target.sourceJobId ||
    typeof result.partialOutput !== "boolean" ||
    !z.number().int().min(1).max(50).safeParse(result.pageCount).success ||
    (result.partialOutput && !target.allowPartial)
  )
    throw unavailable();
  return outputMetadata(result, "application/zip");
}
function pageMetadata(
  entry: Entry,
  pageId?: string,
): OutputMetadata | undefined {
  if (!pageId)
    throw new McpEditError(
      "invalid_edit",
      "Select one exported pageId to inspect its file delivery.",
    );
  const parsed = McpExportPagesTargetSchema.safeParse(entry.parameters);
  if (!parsed.success || parsed.data.requestId !== entry.requestId)
    throw unavailable();
  if (!parsed.data.pages.some((page) => page.pageId === pageId))
    throw new McpEditError(
      "not_found",
      "This pageId was not selected by the export job.",
    );
  if (!entry.settled || !entry.result) return undefined;
  const source = mcpExportSource(entry);
  assertPageResults(entry, parsed.data, source.data);
  const page = source.data.pages.find((item) => item.pageId === pageId);
  if (!page || page.status !== "exported") return undefined;
  return outputMetadata(page, selectedFormat(source.data, page).mimeType);
}
function assertPageResults(
  entry: Entry,
  target: z.infer<typeof McpExportPagesTargetSchema>,
  data: ReturnType<typeof mcpExportSource>["data"],
) {
  const expectedKind = target.imageExport
    ? "rendered-pages-images"
    : "rendered-pages-png";
  if (
    entry.result?.kind !== expectedKind ||
    data.chapterId !== target.chapterId ||
    data.snapshot !== target.snapshot ||
    data.total !== target.pages.length ||
    data.pages.length !== target.pages.length ||
    hashStableValue([data.imageExport]) !==
      hashStableValue([target.imageExport])
  )
    throw unavailable();
  if (
    data.pages.some(
      (page, index) =>
        page.pageId !== target.pages[index].pageId ||
        page.revision !== target.pages[index].revision,
    ) ||
    data.completed !==
      data.pages.filter((page) => page.status === "exported").length
  )
    throw unavailable();
}
function unavailable() {
  return new McpEditError(
    "not_found",
    "Completed output is unavailable. Inspect retained output IDs, or explicitly export the current page or selection again.",
  );
}
