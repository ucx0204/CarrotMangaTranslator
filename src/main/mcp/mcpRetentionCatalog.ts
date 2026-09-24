import { withLibraryRead, withLibraryMutation } from "../library/lock";
import { runLibraryTransaction } from "../libraryStore/libraryTransaction";
import { readImageRedactionState } from "../imageRedactionStore";
import { hashStableValue } from "../../shared/blockFingerprint";
import { McpEditError } from "../application/mcpEditPolicy";
import type { McpRetentionStorage } from "./mcpRetentionStorage";
import {
  readRetainedChange,
  inspectRecoveryPages,
} from "./mcpRecoveryInspection";
import { readRetainedOutput, checkOutputPages } from "./mcpRetainedOutputs";
import type { RetentionEntry } from "./mcpRetentionRecords";
import { inspectRetainedFile } from "./mcpRetentionEvidence";
import { mcpArtifactRequiresImages } from "../../shared/mcpOutputFormats";
import type { McpArtifactMime } from "../../shared/mcpOutputFormats";
import { diagnoseRetainedOutput } from "./mcpRetentionDiagnostics";

/** Read/discard the bounded durable catalog without restoring pages or executing models. */
export class McpRetentionCatalog {
  constructor(
    private readonly storage: McpRetentionStorage,
    private readonly lifetime: AbortSignal,
    private readonly images: boolean,
    private readonly assertDiscardable?: (
      kind: RetentionEntry["kind"],
      id: string,
    ) => void,
  ) {}
  private check(guard: () => void) {
    return () => {
      this.lifetime.throwIfAborted();
      guard();
    };
  }
  async list(
    owner: string,
    kind: RetentionEntry["kind"],
    input: { offset: number; limit: number; snapshot?: string },
    guard: () => void,
  ) {
    const check = this.check(guard);
    check();
    return withLibraryRead(async () => {
      const entries = (await this.storage.index()).entries
        .filter((item) => item.owner === owner && item.kind === kind)
        .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
      const snapshot = hashStableValue(entries);
      if (
        (input.offset > 0 && !input.snapshot) ||
        (input.snapshot && input.snapshot !== snapshot)
      )
        throw new McpEditError(
          "revision_conflict",
          "Retained catalog changed. Restart pagination from offset zero.",
        );
      check();
      return {
        total: entries.length,
        offset: input.offset,
        limit: input.limit,
        snapshot,
        nextOffset:
          input.offset + input.limit < entries.length
            ? input.offset + input.limit
            : null,
        items: entries
          .slice(input.offset, input.offset + input.limit)
          .map((item) => describeRetained(item, this.storage.now())),
        retention:
          "seven-days; same-profile-and-owner; no-automatic-reexecution" as const,
      };
    });
  }
  async change(owner: string, id: string, guard: () => void) {
    const check = this.check(guard);
    check();
    return withLibraryRead(async () => {
      const { entry, record } = await readRetainedChange(
        this.storage,
        owner,
        id,
      );
      const pages = await inspectRecoveryPages(record, check);
      const room = record.actions.length < 32;
      return {
        ...describeRetained(entry, this.storage.now()),
        pages: pages.map(
          ({ current: _current, contextMatches: _context, ...page }) => page,
        ),
        canUndo: room && pages.every((page) => page.matchesAfter),
        canRedo:
          room &&
          pages.every((page) => page.matchesBefore && page.contextMatches),
        warnings: [
          "availability_rechecked_under_native_page_lock",
          "no_model_rerun",
          "runtime_job_status_not_restored",
          ...(!room ? ["action_history_full"] : []),
        ],
      };
    });
  }
  async output(owner: string, id: string, guard: () => void) {
    const check = this.check(guard);
    check();
    return withLibraryRead(async () => {
      const { entry, record } = await readRetainedOutput(
        this.storage,
        owner,
        id,
      );
      await checkOutputPages(record, true, check);
      const payload = await inspectRetainedFile(
        await this.storage.path(id, record.sha256),
      );
      if (payload.sha256 !== record.sha256 || payload.bytes !== record.bytes)
        throw new McpEditError(
          "revision_conflict",
          "Retained output bytes changed.",
        );
      const images = mcpArtifactRequiresImages(record.mimeType);
      const redacted = images && (await readImageRedactionState()).enabled;
      const exchange = record.exchangeBinding;
      check();
      return {
        ...describeRetained(entry, this.storage.now()),
        bytes: record.bytes,
        pages:
          exchange?.kind === "text"
            ? exchange.pages.map(({ pageId, revision }) => ({
                chapterId: exchange.chapterId,
                pageId,
                revision,
              }))
            : record.targets.map(({ chapterId, pageId, revision }) => ({
                chapterId,
                pageId,
                revision,
              })),
        ...(exchange ? { exchange } : {}),
        canDownload: !images || (this.images && !redacted),
        warnings: [
          ...(images ? ["requires_current_image_permission"] : []),
          "download_links_are_not_retained",
          ...(redacted ? ["image_redaction_enabled"] : []),
        ],
      };
    });
  }
  /** Diagnose only an already owned record; never issue a file capability. */
  async diagnoseOutput(
    owner: string,
    id: string,
    guard: () => void,
    authorizeFormat: (mime: McpArtifactMime) => void = () => {},
  ) {
    const check = this.check(guard);
    check();
    return withLibraryRead(() =>
      diagnoseRetainedOutput({
        storage: this.storage,
        owner,
        id,
        check,
        images: this.images,
        authorizeFormat,
      }),
    );
  }
  async discard(owner: string, id: string, guard: () => void) {
    const check = this.check(guard);
    check();
    return withLibraryMutation(async () => {
      const index = await this.storage.index();
      const entry = index.entries.find(
        (item) => item.id === id && item.owner === owner,
      );
      if (!entry)
        throw new McpEditError(
          "not_found",
          "Retained record is not owned by this connection.",
        );
      const kind = entry.kind;
      this.assertDiscardable?.(kind, id);
      if (
        kind === "chapter-deletion" ||
        kind === "work-deletion" ||
        kind === "page-deletion"
      )
        throw new McpEditError(
          "invalid_edit",
          `Use carrot_discard_${kind.replace("-deletion", "")}_deletion after verified restoration; removed originals cannot be purged early.`,
        );
      if (kind === "import-batch")
        throw new McpEditError(
          "invalid_edit",
          "Use carrot_discard_import_batch after the native scan settles.",
        );
      if (kind === "workflow" || kind === "research-batch")
        throw new McpEditError(
          "invalid_edit",
          kind === "workflow"
            ? "Use carrot_discard_workflow after native work settles."
            : "Use carrot_discard_research_batch after native research settles.",
        );
      await runLibraryTransaction(
        "mcp-discard-retained",
        async (transaction) => {
          await this.storage.retire(transaction, id);
          await this.storage.stageIndex(transaction, {
            ...index,
            entries: index.entries.filter((item) => item.id !== id),
          });
        },
        undefined,
        check,
      );
      return { id, status: "discarded" as const, pageChanges: 0 as const };
    });
  }
}
function describeRetained(entry: RetentionEntry, now: number) {
  const { owner: _owner, bytes, ...metadata } = entry;
  return { ...metadata, storageBytes: bytes, available: entry.expiresAt > now };
}
