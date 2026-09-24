import {
  McpExportPagesTargetSchema,
  McpExportPreflightOutput,
  type McpExportPageResult,
  type McpExportPagesTarget,
} from "../../shared/mcpExportBatch";
import type { PageRevision } from "../../shared/pageRevisionTypes";
import { McpWorkFileExportReviewSchema } from "../../shared/mcpWorkFileExport";
import { McpTextExportReviewOutputSchema } from "../../shared/mcpTextExchange";
import type { McpCompositeWorkflowAction } from "../../shared/mcpCompositeWorkflowActions";
import type {
  McpCompositeCost,
  McpCompositeGuard,
  McpCompositeRecord,
} from "../application/mcpCompositeWorkflowPorts";
import type { McpOperationService } from "../application/mcpOperationService";
import { compositeFingerprint } from "../application/mcpCompositeWorkflowPolicy";
import { mcpExportPageMetadata } from "../application/mcpExportSelection";
import type { McpCompositeNativePage } from "./mcpCompositeNativePages";
import type { CompositeNativeRead } from "./mcpCompositeNativeTools";
import { readMcpContextExchangeState } from "./mcpContextExchangeSource";
import {
  nativeCompositeCost,
  selectCompositeNativePages,
  scopeError,
} from "./mcpCompositeNativeScope";

type OutputAction = Extract<
  McpCompositeWorkflowAction,
  {
    kind:
      | "images-export"
      | "work-file-export"
      | "zip-export"
      | "text-export"
      | "context-export";
  }
>;
type Options = {
  read: CompositeNativeRead;
  operations: Pick<
    McpOperationService,
    "ready" | "exportSource" | "outputMetadata"
  >;
  readContext?: typeof readMcpContextExchangeState;
};

/** Bind native output scope and cost without rendering, publishing or borrowing bytes. */
export async function costCompositeNativeOutput(
  options: Options,
  record: McpCompositeRecord,
  action: OutputAction,
  values: McpCompositeNativePage[],
  guard: McpCompositeGuard,
): Promise<McpCompositeCost> {
  guard();
  switch (action.kind) {
    case "images-export":
      await inspectImageSelection(
        options.read,
        record.owner,
        action.input,
        values,
        guard,
      );
      return nativeCompositeCost(action.input.pages.length);
    case "work-file-export":
      return costWorkFile(
        options.read,
        record.owner,
        action.input,
        values,
        guard,
      );
    case "zip-export":
      return costZip(options, record.owner, action.input, values, guard);
    case "text-export":
      return costText(options.read, record.owner, action.input, values, guard);
    case "context-export":
      return costContext(
        options.readContext ?? readMcpContextExchangeState,
        action.input,
        values,
        guard,
      );
  }
}

async function inspectImageSelection(
  read: CompositeNativeRead,
  owner: string,
  input: McpExportPagesTarget,
  values: McpCompositeNativePage[],
  guard: McpCompositeGuard,
) {
  selectCompositeNativePages(values, input.chapterId, input.pages);
  const review = await read(
    McpExportPreflightOutput,
    "carrot_preflight_pages_export",
    {
      chapterId: input.chapterId,
      pageIds: input.pages.map((page) => page.pageId),
      ...(input.imageExport ? { imageExport: input.imageExport } : {}),
    },
    owner,
    guard,
  );
  if (
    review.chapterId !== input.chapterId ||
    review.snapshot !== input.snapshot ||
    !same(review.imageExport ?? null, input.imageExport ?? null) ||
    !same(
      review.pages.map(({ pageId, revision }) => ({ pageId, revision })),
      input.pages,
    )
  )
    throw scopeError();
  guard();
  return review;
}

async function costWorkFile(
  read: CompositeNativeRead,
  owner: string,
  input: Extract<OutputAction, { kind: "work-file-export" }>["input"],
  values: McpCompositeNativePage[],
  guard: McpCompositeGuard,
) {
  for (const chapterId of input.chapterIds)
    anchor(values, input.workId, chapterId);
  const review = await read(
    McpWorkFileExportReviewSchema,
    "carrot_preflight_work_file_export",
    { workId: input.workId, chapterIds: input.chapterIds },
    owner,
    guard,
  );
  if (
    review.workId !== input.workId ||
    review.snapshot !== input.snapshot ||
    review.sourceSnapshot !== input.sourceSnapshot ||
    !same(review.chapterIds, input.chapterIds) ||
    !same(
      review.chapters.map((chapter) => chapter.chapterId),
      input.chapterIds,
    )
  )
    throw scopeError();
  let pageCount = 0;
  for (const chapter of review.chapters) {
    if (chapter.pageCount !== chapter.pages.length) throw scopeError();
    if (chapter.pages.length)
      selectCompositeNativePages(values, chapter.chapterId, chapter.pages);
    pageCount += chapter.pages.length;
  }
  if (
    review.chapterCount !== review.chapters.length ||
    review.pageCount !== pageCount
  )
    throw scopeError();
  guard();
  return nativeCompositeCost(pageCount);
}

async function costZip(
  options: Options,
  owner: string,
  input: Extract<OutputAction, { kind: "zip-export" }>["input"],
  values: McpCompositeNativePage[],
  guard: McpCompositeGuard,
) {
  await options.operations.ready();
  guard();
  const source = options.operations.exportSource(input.sourceJobId, owner);
  const { data } = source;
  const exported = data.pages.filter((page) => page.status === "exported");
  if (
    !exported.length ||
    data.total !== data.pages.length ||
    data.completed !== exported.length ||
    (!input.allowPartial &&
      (source.status !== "completed" || data.completed !== data.total))
  )
    throw scopeError();
  const review = await inspectImageSelection(
    options.read,
    owner,
    {
      chapterId: data.chapterId,
      snapshot: data.snapshot,
      requestId: input.requestId,
      pages: data.pages.map(({ pageId, revision }) => ({ pageId, revision })),
      ...(data.imageExport ? { imageExport: data.imageExport } : {}),
    },
    values,
    guard,
  );
  if (
    !same(
      review.pages.map(({ issues: _issues, ...metadata }) => metadata),
      data.pages.map(storedPageMetadata),
    )
  )
    throw scopeError();
  assertZipReceipts(options.operations, source, input.sourceJobId, owner);
  guard();
  return nativeCompositeCost(exported.length);
}

function storedPageMetadata(page: McpExportPageResult) {
  const revision = page.revision;
  if (!validStoredRevision(revision)) throw scopeError();
  return mcpExportPageMetadata({ ...page, revision });
}
function validStoredRevision(value: string): value is PageRevision {
  return McpExportPagesTargetSchema.shape.pages.element.shape.revision.safeParse(
    value,
  ).success;
}

function assertZipReceipts(
  operations: Options["operations"],
  source: ReturnType<Options["operations"]["exportSource"]>,
  sourceJobId: string,
  owner: string,
) {
  for (const page of source.data.pages.filter(
    (page) => page.status === "exported",
  )) {
    const metadata = operations.outputMetadata(sourceJobId, owner, page.pageId);
    if (
      !metadata ||
      metadata.artifact.bytes !== page.bytes ||
      metadata.artifact.sha256 !== page.sha256 ||
      metadata.artifact.retainedOutputId !== page.retainedOutputId
    )
      throw scopeError();
  }
}

async function costText(
  read: CompositeNativeRead,
  owner: string,
  input: Extract<OutputAction, { kind: "text-export" }>["input"],
  values: McpCompositeNativePage[],
  guard: McpCompositeGuard,
) {
  const { binding } = input;
  anchor(values, binding.workId, binding.chapterId);
  selectCompositeNativePages(values, binding.chapterId, binding.pages);
  const review = await read(
    McpTextExportReviewOutputSchema,
    "carrot_preflight_text_export",
    {
      chapterId: binding.chapterId,
      pageIds: binding.pages.map((page) => page.pageId),
      options: binding.options,
    },
    owner,
    guard,
  );
  if (
    !same(review.binding, binding) ||
    review.pageCount !== binding.pages.length ||
    !review.bytes
  )
    throw scopeError();
  guard();
  return nativeCompositeCost(binding.pages.length);
}

async function costContext(
  read: typeof readMcpContextExchangeState,
  input: Extract<OutputAction, { kind: "context-export" }>["input"],
  values: McpCompositeNativePage[],
  guard: McpCompositeGuard,
) {
  anchor(values, input.workId, input.chapterId);
  guard(["carrot.read"]);
  const source = await read(
    { workId: input.workId, chapterId: input.chapterId, scope: input.scope },
    guard,
  );
  if (
    source.binding.workId !== input.workId ||
    source.binding.chapterId !== input.chapterId ||
    source.binding.scope !== input.scope ||
    source.binding.snapshot !== input.sourceSnapshot
  )
    throw scopeError();
  const memory =
    input.scope === "guide-and-memory"
      ? (source.payload.memory?.pages ?? [])
      : [];
  if (memory.length)
    selectCompositeNativePages(values, input.chapterId, memory);
  await source.verifySources();
  guard(["carrot.read"]);
  return nativeCompositeCost(memory.length);
}

function anchor(
  values: McpCompositeNativePage[],
  workId: string,
  chapterId: string,
) {
  if (
    !values.some(
      ({ target }) =>
        target.workId === workId && target.chapterId === chapterId,
    )
  )
    throw scopeError();
}
function same(left: unknown, right: unknown) {
  return compositeFingerprint(left) === compositeFingerprint(right);
}
