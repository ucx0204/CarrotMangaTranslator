import {
  MCP_WORK_FILE_OUTPUT_BYTES,
  type McpWorkFileExportBinding,
  type McpWorkFileExportReview,
  type McpWorkFileExportReviewInput,
  type McpWorkFileExportTarget,
} from "../../shared/mcpWorkFileExport";
import type { McpOperationContext } from "./mcpOperationService";
import { McpEditError } from "./mcpEditPolicy";

type SourceBinding = {
  chapterId: string;
  pageId: string;
  revision: string;
  sourceFingerprint: string;
};
export type McpWorkFileExportState = {
  review: McpWorkFileExportReview;
  bindings: SourceBinding[];
  verifySources: () => Promise<void>;
};
type Artifact = {
  url: string;
  bytes: number;
  sha256: string;
  expiresAt: number;
  access: string;
  retainedOutputId?: string;
};
type Ports = {
  read: (
    input: McpWorkFileExportReviewInput,
    guard: () => void,
    signal?: AbortSignal,
  ) => Promise<McpWorkFileExportState>;
  check: (binding: McpWorkFileExportBinding) => Promise<void>;
  write: (
    binding: McpWorkFileExportBinding,
    path: string,
    guard: () => void,
    signal: AbortSignal,
  ) => Promise<void>;
  store: (
    writer: (path: string, signal: AbortSignal) => Promise<void>,
    reservedBytes: number,
    access: () => Promise<void>,
    signal: AbortSignal,
    pageBindings: SourceBinding[],
    binding: McpWorkFileExportBinding,
  ) => Promise<Artifact>;
  assertImageAccess: () => Promise<void>;
};

/** Reviewed native share output. The serializer and file lifecycle remain ports. */
export class McpWorkFileExportService {
  constructor(private readonly ports: Ports) {}

  async preflight(input: McpWorkFileExportReviewInput, guard: () => void) {
    guard();
    const state = await this.ports.read(input, guard);
    await this.ports.check(bindingFor(state.review));
    await state.verifySources();
    guard();
    return state.review;
  }

  async run(
    target: McpWorkFileExportTarget,
    context: McpOperationContext,
    retainedAccess: () => void,
  ) {
    context.assertAuthorized();
    await this.ports.assertImageAccess();
    const state = await this.ports.read(
      { workId: target.workId, chapterIds: target.chapterIds },
      retainedAccess,
      context.signal,
    );
    const binding = reviewedBinding(state.review, target);
    const access = this.access(binding, state.verifySources, retainedAccess);
    await access();
    context.assertAuthorized();
    context.progress({
      phase: "packing",
      completed: 0,
      total: state.review.pageCount,
    });
    const artifact = await this.ports.store(
      (path, signal) => this.ports.write(binding, path, retainedAccess, signal),
      MCP_WORK_FILE_OUTPUT_BYTES,
      access,
      context.signal,
      state.bindings,
      binding,
    );
    context.assertAuthorized();
    await access();
    context.progress({
      phase: "done",
      completed: state.review.pageCount,
      total: state.review.pageCount,
    });
    return completedResult(state.review, binding, artifact);
  }

  private access(
    binding: McpWorkFileExportBinding,
    verifySources: () => Promise<void>,
    retainedAccess: () => void,
  ) {
    return async () => {
      retainedAccess();
      await this.ports.assertImageAccess();
      await this.ports.check(binding);
      await verifySources();
      retainedAccess();
    };
  }
}

function completedResult(
  review: McpWorkFileExportReview,
  binding: McpWorkFileExportBinding,
  artifact: Artifact,
) {
  return {
    ...artifact,
    kind: "native-work-file",
    // An app-defined transport MIME, not a claim of a registered standard.
    mimeType: "application/vnd.carrot.mgtshare" as const,
    filename: "carrot-work.mgtshare",
    workFileExport: {
      ...binding,
      sourceSnapshot: review.sourceSnapshot,
      format: "mgtshare-v1" as const,
      chapterCount: review.chapterCount,
      pageCount: review.pageCount,
      blockCount: review.blockCount,
    },
    performed: ["package", "export"],
  };
}

function reviewedBinding(
  review: McpWorkFileExportReview,
  target: McpWorkFileExportTarget,
) {
  const binding = bindingFor(review);
  if (
    binding.snapshot !== target.snapshot ||
    review.sourceSnapshot !== target.sourceSnapshot ||
    binding.chapterIds.length !== target.chapterIds.length ||
    binding.chapterIds.some((id, index) => id !== target.chapterIds[index])
  )
    throw new McpEditError(
      "revision_conflict",
      "The reviewed working-file selection changed. Repeat export preflight.",
    );
  return binding;
}

function bindingFor(review: McpWorkFileExportReview): McpWorkFileExportBinding {
  return {
    workId: review.workId,
    chapterIds: review.chapterIds,
    snapshot: review.snapshot,
  };
}
