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

/** Read/discard the bounded durable catalog without restoring pages or executing models. */
export class McpRetentionCatalog {
  constructor(
    private readonly storage: McpRetentionStorage,
    private readonly lifetime: AbortSignal,
    private readonly images: boolean,
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
      await checkOutputPages(record, true);
      const redacted = (await readImageRedactionState()).enabled;
      check();
      return {
        ...describeRetained(entry, this.storage.now()),
        bytes: record.bytes,
        pages: record.targets.map(
          ({ files: _files, workId: _workId, ...page }) => page,
        ),
        canDownload: this.images && !redacted,
        warnings: [
          "requires_current_image_permission",
          "download_links_are_not_retained",
          ...(redacted ? ["image_redaction_enabled"] : []),
        ],
      };
    });
  }
  async discard(owner: string, id: string, guard: () => void) {
    const check = this.check(guard);
    check();
    return withLibraryMutation(async () => {
      const index = await this.storage.index();
      if (!index.entries.some((item) => item.id === id && item.owner === owner))
        throw new McpEditError(
          "not_found",
          "Retained record is not owned by this connection.",
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
