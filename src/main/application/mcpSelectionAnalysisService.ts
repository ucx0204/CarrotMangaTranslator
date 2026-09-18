import {
  McpSelectionAnalysisItemSchema,
  McpSelectionAnalysisGetSchema,
  type McpSelectionAnalysisItem,
  type McpSelectionInput,
} from "../../shared/mcpSelectionAnalysis";
import type { McpContextSnapshot } from "./mcpContextEditPolicy";
import type { McpOperationContext } from "./mcpOperationService";
import {
  mcpBatchMembership,
  requireBatchPage,
  validateBatchTargets,
} from "./mcpPageBatchPolicy";
import { McpEditError } from "./mcpEditPolicy";

export type McpSelectionBinding = {
  chapterId: string;
  contextRevision: string;
  membership: string;
  pages: { pageId: string; revision: string; sourceHash?: string }[];
};
export type McpSelectionAnalysis = {
  analysisId: string;
  owner: string;
  expiresAt: number;
  kind: "ocr" | "translation";
  binding: McpSelectionBinding;
  items: McpSelectionAnalysisItem[];
};
type Ports = {
  read: (id: string) => Promise<McpContextSnapshot>;
  analyze: (
    saved: McpContextSnapshot,
    input: McpSelectionInput,
    context: McpOperationContext,
  ) => Promise<{
    items: McpSelectionAnalysisItem[];
    binding: McpSelectionBinding;
  }>;
  verify: (binding: McpSelectionBinding, guard: () => void) => Promise<void>;
};
const TTL = 30 * 60_000;
/** Expiring evidence only. The existing operation service owns durable receipts.
 * No save function or model scheduling authority is introduced here. */
export class McpSelectionAnalysisService {
  private readonly records = new Map<string, McpSelectionAnalysis>();
  constructor(
    private readonly ports: Ports,
    private readonly now = Date.now,
  ) {}

  async run(
    owner: string,
    input: McpSelectionInput,
    context: McpOperationContext,
  ) {
    context.assertAuthorized();
    this.prune();
    if (this.records.size >= 16)
      throw new McpEditError(
        "invalid_edit",
        "Selection evidence capacity reached. Wait for evidence expiry.",
      );
    const saved = await this.ports.read(input.chapterId);
    validateMcpSelection(saved, input);
    context.assertAuthorized();
    const result = await this.ports.analyze(saved, input, context);
    context.assertAuthorized();
    const items = result.items.map((item) =>
      McpSelectionAnalysisItemSchema.parse(item),
    );
    const count = input.pages.reduce(
      (n, page) =>
        n + ("targets" in page ? page.targets.length : page.blockIds.length),
      0,
    );
    if (
      items.length !== count ||
      new Set(items.map((item) => item.itemId)).size !== items.length ||
      JSON.stringify(items).length > 1_000_000
    )
      throw new McpEditError(
        "invalid_edit",
        "Selection evidence is incomplete or exceeds its bounded review size. No truncation or page save occurred.",
      );
    await this.ports.verify(result.binding, context.assertAuthorized);
    context.assertAuthorized();
    const record: McpSelectionAnalysis = {
      analysisId: context.id,
      owner,
      expiresAt: this.now() + TTL,
      kind: "expectedEngine" in input ? "translation" : "ocr",
      ...result,
      items,
    };
    this.records.set(context.id, record);
    return {
      kind: "selection-analysis",
      chapterId: input.chapterId,
      pagesChanged: 0,
      needsReview: true,
      performed: items.some((item) => item.ocr || item.translation)
        ? [record.kind === "ocr" ? "selected-ocr" : "selected-translation"]
        : [],
      selectionAnalysis: reference(record),
    };
  }
  get(owner: string, value: unknown, guard: () => void) {
    const input = McpSelectionAnalysisGetSchema.parse(value);
    const entry = this.require(owner, input.analysisId, guard);
    return {
      ...reference(entry),
      chapterId: entry.binding.chapterId,
      contextRevision: entry.binding.contextRevision,
      offset: input.offset,
      limit: input.limit,
      nextOffset:
        input.offset + input.limit < entry.items.length
          ? input.offset + input.limit
          : null,
      items: structuredClone(
        entry.items.slice(input.offset, input.offset + input.limit),
      ),
      notes: [
        "observations_only_no_page_save",
        "select_items_explicitly_before_application",
        "session_only_fixed_30_minute_expiry",
        "generated_lettering_excluded",
        "no_automatic_paid_retry",
      ],
    };
  }
  require(owner: string, id: string, guard: () => void): McpSelectionAnalysis {
    guard();
    this.prune();
    const entry = this.records.get(id);
    if (!entry || entry.owner !== owner)
      throw new McpEditError(
        "not_found",
        "Owned selection evidence is unavailable or expired. Run a new explicit analysis.",
      );
    return structuredClone(entry);
  }
  close() {
    this.records.clear();
  }
  private prune() {
    for (const [id, entry] of this.records)
      if (entry.expiresAt <= this.now()) this.records.delete(id);
  }
}
function reference(entry: McpSelectionAnalysis) {
  return {
    analysisId: entry.analysisId,
    expiresAt: entry.expiresAt,
    total: entry.items.length,
    kind: entry.kind,
  };
}
export function validateMcpSelection(
  saved: McpContextSnapshot,
  input: McpSelectionInput,
) {
  const pages = input.pages.map((page) => ({
    ...page,
    edits: ("targets" in page
      ? page.targets.map((target) =>
          target.kind === "block"
            ? `block:${target.blockId}`
            : `region:${target.regionId}`,
        )
      : page.blockIds
    ).map((blockId) => ({ blockId })),
  }));
  validateBatchTargets(saved, { ...input, pages });
  if (pages.reduce((n, page) => n + page.edits.length, 0) > 100)
    throw new McpEditError(
      "invalid_edit",
      "At most 100 explicit OCR regions/blocks or translation calls are allowed.",
    );
  for (const page of pages) requireBatchPage(saved.chapter, page);
}
export function assertMcpSelectionFreshness(
  saved: McpContextSnapshot,
  binding: McpSelectionBinding,
) {
  validateBatchTargets(saved, {
    ...binding,
    pages: binding.pages.map((page) => ({ ...page, edits: [] })),
  });
  if (mcpBatchMembership(saved.chapter) !== binding.membership)
    throw new McpEditError(
      "revision_conflict",
      "Selection chapter membership/order changed.",
    );
  for (const page of binding.pages)
    requireBatchPage(saved.chapter, { ...page, edits: [] });
}
