import { hashStableValue } from "../../shared/blockFingerprint";
import type { McpExportPageResult } from "../../shared/mcpExportBatch";
import type { McpExportSource } from "../application/mcpExportBatchService";
import { assertMcpExportSelection } from "../application/mcpExportSelection";
import type { McpOperationService } from "../application/mcpOperationService";
import { McpEditError } from "../application/mcpEditPolicy";
import { openChapter } from "../library";
import type { McpArtifactStore } from "./mcpArtifactStore";
import type {
  McpBorrowedOutputIdentity,
  borrowRetainedOutput,
} from "./mcpRetainedOutputs";
import { readMcpExportSourceName } from "./mcpSourceExport";

export type McpExportSourceBorrow = (
  owner: string,
  id: string,
  guard: () => void,
  expected: McpBorrowedOutputIdentity,
) => ReturnType<typeof borrowRetainedOutput>;
type Options = {
  operations: Pick<
    McpOperationService,
    "ready" | "exportSource" | "outputMetadata"
  >;
  artifacts: Pick<McpArtifactStore, "assertAvailable">;
  borrowOutput: McpExportSourceBorrow;
  readChapter?: typeof openChapter;
};

/** Only exact native page-output receipts can regain a session lease; never writes the job journal. */
export function createMcpExportSourceResolver(options: Options) {
  return async (
    owner: string,
    sourceJobId: string,
    guard: () => void,
  ): Promise<McpExportSource> => {
    guard();
    await options.operations.ready();
    const source = structuredClone(
      options.operations.exportSource(sourceJobId, owner),
    );
    await assertCurrentSource(
      source,
      sourceJobId,
      options.readChapter ?? openChapter,
    );
    for (const page of source.data.pages) {
      guard();
      if (page.status !== "exported") continue;
      const metadata = options.operations.outputMetadata(
        sourceJobId,
        owner,
        page.pageId,
      );
      if (!metadata) throw unavailable();
      if (metadata.url && (await available(options.artifacts, metadata.url))) {
        page.url = metadata.url;
        continue;
      }
      const { retainedOutputId, ...artifact } = metadata.artifact;
      if (!retainedOutputId) throw unavailable();
      const expected = {
        chapterId: source.data.chapterId,
        pageId: page.pageId,
        revision: page.revision,
        ...artifact,
      };
      const borrowed = await options.borrowOutput(
        owner,
        retainedOutputId,
        guard,
        expected,
      );
      if (
        borrowed.sha256 !== artifact.sha256 ||
        borrowed.bytes !== artifact.bytes ||
        borrowed.mimeType !== artifact.mimeType
      )
        throw unavailable();
      page.url = borrowed.url;
    }
    guard();
    await assertCurrentSource(
      source,
      sourceJobId,
      options.readChapter ?? openChapter,
    );
    guard();
    return source;
  };
}
async function available(artifacts: Options["artifacts"], url: string) {
  try {
    await artifacts.assertAvailable(url);
    return true;
  } catch (error) {
    if (error instanceof McpEditError && error.code === "not_found")
      return false;
    throw error;
  }
}
async function assertCurrentSource(
  source: McpExportSource,
  requestId: string,
  readChapter: typeof openChapter,
) {
  const { data } = source;
  const selected = assertMcpExportSelection(
    await readChapter(data.chapterId),
    {
      chapterId: data.chapterId,
      snapshot: data.snapshot,
      requestId,
      pages: data.pages,
      ...(data.imageExport ? { imageExport: data.imageExport } : {}),
    },
    readMcpExportSourceName,
  );
  if (
    selected.some(
      (page, index) =>
        hashStableValue(pageIdentity(page)) !==
        hashStableValue(pageIdentity(data.pages[index])),
    )
  )
    throw new McpEditError(
      "revision_conflict",
      "Owned export names, order or resolved format no longer match the native source plan.",
    );
}
function pageIdentity(
  page: Pick<
    McpExportPageResult,
    | "pageId"
    | "revision"
    | "pageIndex"
    | "filename"
    | "width"
    | "height"
    | "imageExport"
    | "sourceFormatBasis"
    | "fallback"
  >,
) {
  const {
    pageId,
    revision,
    pageIndex,
    filename,
    width,
    height,
    imageExport,
    sourceFormatBasis,
    fallback,
  } = page;
  return {
    pageId,
    revision,
    pageIndex,
    filename,
    width,
    height,
    imageExport,
    sourceFormatBasis,
    fallback,
  };
}
function unavailable() {
  return new McpEditError(
    "not_found",
    "Exact owned retained page bytes are unavailable; no replacement export was started.",
  );
}
