import { withMcpAuthorization } from "./mcpAuthorizationScope";
import { randomUUID } from "node:crypto";
import type { McpRecoveryAction } from "../../shared/mcpRetention";
import { hashStableValue } from "../../shared/blockFingerprint";
import {
  createPageRevision,
  createSoundEffectReviewPageRevision,
} from "../../shared/pageRevision";
import { openChapter, commitPageRecovery } from "../library";
import { withLibraryRead } from "../library/lock";
import type { InpaintingJobContext } from "../jobs/inpaintingJobTypes";
import { reserveJobChapter, acquireJobPage } from "../jobs/jobPageOwnership";
import type { PageRecoveryUpdate } from "../libraryStore/libraryPageRecovery";
import { McpEditError } from "../application/mcpEditPolicy";
import { runMcpAppJob } from "./mcpAppJob";
import {
  readRetainedChange,
  inspectRecoveryPages,
} from "./mcpRecoveryInspection";
import { inspectRetainedFile } from "./mcpRetentionEvidence";
import type { McpRetentionStorage } from "./mcpRetentionStorage";
import type { RetainedChange } from "./mcpRetentionRecords";
import { logError } from "../logger";

type Editing = {
  assertWritable: (chapterId: string, pageId: string) => Promise<void>;
  notifySaved: (chapterId: string, pageId: string) => void;
};
type Action = RetainedChange["actions"][number];
export function createRecoveryApplication(
  storage: McpRetentionStorage,
  app: InpaintingJobContext,
  editing: Editing,
  lifetime: AbortSignal,
) {
  return async (
    owner: string,
    input: McpRecoveryAction,
    direction: "undo" | "redo",
    guard: () => void,
  ) =>
    withMcpAuthorization(guard, lifetime, async (check, signal) => {
      const { record, entry } = await withLibraryRead(() =>
        readRetainedChange(storage, owner, input.id),
      );
      check();
      const authorize = () => {
        check();
        if (entry.expiresAt <= storage.now())
          throw new McpEditError(
            "not_found",
            "Retained history expired before commit.",
          );
      };
      const signature = hashStableValue({ ...input, direction });
      const previous = prior(record, input.requestId, signature);
      if (previous) return result(input.id, previous, true);
      if (record.actions.length >= 32)
        throw new McpEditError(
          "editor_busy",
          "This retained change has reached its 32-action history limit.",
        );
      const operation = {
        id: randomUUID(),
        signal,
        assertAuthorized: authorize,
        progress: () => {},
      };
      return runMcpAppJob(
        app,
        operation,
        "mcp-edit",
        async (context) => {
          for (const chapterId of new Set(
            record.pages.map((item) => item.chapterId),
          )) {
            const chapter = await openChapter(chapterId);
            const ids = record.pages
              .filter((item) => item.chapterId === chapterId)
              .map((item) => item.after.page.id);
            reserveJobChapter(app.jobs, context.id, chapter, ids);
            for (const pageId of ids)
              await acquireJobPage(
                app.jobs,
                context.id,
                chapterId,
                pageId,
                openChapter,
              );
          }
          return applyOwned(
            storage,
            record,
            input,
            direction,
            signature,
            context.assertAuthorized,
            editing,
          );
        },
        {
          resources: [...new Set(record.pages.map((item) => item.workId))].map(
            (scope) => ({
              kind: "work-context" as const,
              scope,
              access: "read" as const,
            }),
          ),
        },
      );
    });
}
async function applyOwned(
  storage: McpRetentionStorage,
  record: RetainedChange,
  input: McpRecoveryAction,
  direction: "undo" | "redo",
  signature: string,
  guard: () => void,
  editing: Editing,
) {
  const verify = createRecoveryVerifier(
    storage,
    record,
    input,
    direction,
    guard,
  );
  const pages = await withLibraryRead(verify);
  const updates = await recoveryUpdates(storage, record, pages, direction);
  for (const page of pages)
    await editing.assertWritable(page.chapterId, page.pageId);
  let savedAction: Action | undefined;
  try {
    await commitPageRecovery(
      updates,
      guard,
      async () => {
        await verify();
      },
      async (transaction, saved) => {
        const fresh = await readRetainedChange(
          storage,
          record.owner,
          record.id,
        );
        if (fresh.record.actions.length !== record.actions.length)
          throw new McpEditError(
            "revision_conflict",
            "Recovery history changed.",
          );
        savedAction = {
          requestId: input.requestId,
          signature,
          direction,
          pages: saved.map((item) => ({
            chapterId: item.chapterId,
            pageId: item.page.id,
            revision: createPageRevision(item.page),
            reviewRevision: createSoundEffectReviewPageRevision(item.page),
          })),
        };
        await storage.stageRecord(transaction, record.id, {
          ...record,
          actions: [...record.actions, savedAction],
        });
      },
    );
    for (const page of pages) editing.notifySaved(page.chapterId, page.pageId);
  } catch (error) {
    const saved = await withLibraryRead(() =>
      readRetainedChange(storage, record.owner, record.id),
    ).catch((receiptError: unknown) => {
      throw new AggregateError(
        [error, receiptError],
        "Recovery failed and its durable outcome could not be inspected; inspect saved pages before retrying.",
        { cause: error },
      );
    });
    const receipt = prior(saved.record, input.requestId, signature);
    if (!receipt) throw error;
    logError("Durable recovery saved; post-commit notification failed", error);
    return {
      ...result(record.id, receipt, false),
      warnings: ["notification_failed_after_commit"],
    };
  }
  if (!savedAction)
    throw new Error("Durable recovery receipt was not produced.");
  return result(record.id, savedAction, false);
}
async function recoveryUpdates(
  storage: McpRetentionStorage,
  record: RetainedChange,
  current: Awaited<ReturnType<typeof inspectRecoveryPages>>,
  direction: "undo" | "redo",
) {
  const updates: PageRecoveryUpdate[] = [];
  for (const item of record.pages) {
    const page = current.find(
      (page) =>
        page.chapterId === item.chapterId && page.pageId === item.after.page.id,
    );
    if (!page) throw new Error("Missing current recovery page.");
    const state = direction === "undo" ? item.before : item.after;
    const snapshot = structuredClone(state.page);
    const copies: PageRecoveryUpdate["copies"] = [];
    for (const field of ["inpaintedImagePath", "inpaintMaskPath"] as const) {
      const restored = await recoverImageField(
        storage,
        record.id,
        page.current,
        state,
        field,
      );
      if (!restored) continue;
      snapshot[field] = restored.path;
      if (restored.copy) copies.push(restored.copy);
    }
    updates.push({
      workId: item.workId,
      chapterId: item.chapterId,
      pageId: page.pageId,
      revision: page.revision,
      reviewRevision: page.reviewRevision,
      snapshot,
      copies,
    });
  }
  return updates;
}
function prior(record: RetainedChange, requestId: string, signature: string) {
  const previous = record.actions.find((item) => item.requestId === requestId);
  if (previous && previous.signature !== signature)
    throw new McpEditError(
      "invalid_edit",
      "Recovery requestId belongs to a different action.",
    );
  return previous;
}
function result(id: string, action: Action, historical: boolean) {
  return {
    id,
    requestId: action.requestId,
    direction: action.direction,
    pages: action.pages,
    status: historical ? ("already_applied" as const) : ("saved" as const),
    historical,
    warnings: [] as string[],
  };
}

function createRecoveryVerifier(
  storage: McpRetentionStorage,
  record: RetainedChange,
  input: McpRecoveryAction,
  direction: "undo" | "redo",
  guard: () => void,
) {
  return async () => {
    await storage.owned(record.owner, record.id, "change");
    const pages = await inspectRecoveryPages(record, guard);
    if (
      input.pages.length !== pages.length ||
      new Set(input.pages.map((item) => `${item.chapterId}/${item.pageId}`))
        .size !== pages.length
    )
      throw new McpEditError(
        "invalid_edit",
        "Specify every retained page exactly once.",
      );
    for (const page of pages) {
      const target = input.pages.find(
        (item) =>
          item.chapterId === page.chapterId && item.pageId === page.pageId,
      );
      if (
        !target ||
        target.revision !== page.revision ||
        target.reviewRevision !== page.reviewRevision ||
        !(direction === "undo"
          ? page.matchesAfter
          : page.matchesBefore && page.contextMatches)
      )
        throw new McpEditError(
          "revision_conflict",
          "Retained recovery conflicts with later page, source, review or context changes.",
        );
    }
    guard();
    return pages;
  };
}

async function recoverImageField(
  storage: McpRetentionStorage,
  id: string,
  current: RetainedChange["pages"][number]["before"],
  state: RetainedChange["pages"][number]["before"],
  field: "inpaintedImagePath" | "inpaintMaskPath",
): Promise<
  { path: string; copy?: PageRecoveryUpdate["copies"][number] } | undefined
> {
  const path = state.page[field];
  if (!path) return undefined;
  const file = state.files.find((file) => file.path === path);
  if (!file) throw new Error("Missing retained image evidence.");
  const existing = current.files.find(
    (file) => file.path === current.page[field],
  );
  if (existing?.sha256 === file.sha256) return { path: existing.path };
  if (!file.asset) {
    if (path !== state.page.imagePath)
      throw new Error("Missing durable image copy.");
    return { path };
  }
  const source = await storage.path(id, file.asset);
  const actual = await inspectRetainedFile(source);
  if (actual.sha256 !== file.sha256 || actual.bytes !== file.bytes)
    throw new Error("Retained image bytes changed.");
  return { path, copy: { field, source, sha256: file.sha256 } };
}
