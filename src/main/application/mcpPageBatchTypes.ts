import type { MangaPage } from "../../shared/libraryTypes";
import type { McpContextSnapshot } from "./mcpContextEditPolicy";
import type { McpTranslationBatchDirection } from "../../shared/mcpTranslationBatch";

export type BatchChange = { changed: boolean; excludedReason: string | null };
export type BatchPage<C extends BatchChange> = {
  pageId: string;
  expectedRevision: string;
  state: "pending" | "applied" | "undone" | "unchanged" | "excluded";
  result: "not_started" | "saved" | "failed" | "cancelled";
  errorCode: string | null;
  changedBlocks: number;
  changes: C[];
};
export type BatchPlan<C extends BatchChange> = {
  workId: string;
  membership: string;
  pages: BatchPage<C>[];
};
export type BatchTarget = {
  chapterId: string;
  contextRevision: string;
  requestId: string;
  reason: string;
};
export type BatchCommit<R> = (
  request: R,
  expected: {
    workId: string;
    membership: string;
    contextRevision: string | null;
  },
  guard: () => void,
  onCommitted: (page: MangaPage) => void,
) => Promise<void>;
export type BatchPorts<R> = {
  read: (chapterId: string) => Promise<McpContextSnapshot>;
  commit: BatchCommit<R>;
  reportError: (error: unknown) => void;
};
export type BatchPolicy<
  I extends BatchTarget,
  C extends BatchChange,
  R,
  V,
  P extends BatchPlan<C> = BatchPlan<C>,
> = {
  parse: (value: unknown) => I;
  plan: (
    saved: McpContextSnapshot,
    input: I,
    access: { owner: string; guard: () => void },
  ) => P | Promise<P>;
  request: (
    page: BatchPage<C>,
    input: I,
    direction: McpTranslationBatchDirection,
    plan: P,
  ) => R;
  project: (change: C) => V;
  inspectTool: string;
  exclusionWarning: string;
};
