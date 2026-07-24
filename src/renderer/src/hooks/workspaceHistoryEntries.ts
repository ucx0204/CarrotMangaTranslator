import type {
  WorkspaceChapterEditHistoryEntry,
  WorkspaceChapterEditSnapshot,
  WorkspaceImageEditHistoryEntry,
  WorkspaceMaskEditHistoryEntry,
  WorkspaceMaskSnapshot,
} from "../lib/workspaceHistory";

type HistoryRecordMetadata = {
  label: string;
  mergeKey?: string;
  time?: number;
};

export type RecordWorkspaceChapterEdit = HistoryRecordMetadata & {
  before: WorkspaceChapterEditSnapshot;
  after: WorkspaceChapterEditSnapshot;
};

export type RecordWorkspaceMaskEdit = HistoryRecordMetadata & {
  before: WorkspaceMaskSnapshot;
  after: WorkspaceMaskSnapshot;
};

export type RecordWorkspaceImageEdit = Omit<
  HistoryRecordMetadata,
  "mergeKey"
> & {
  transactionId: string;
  mask?: WorkspaceImageEditHistoryEntry["mask"];
};

export function createChapterHistoryEntry(
  input: RecordWorkspaceChapterEdit,
): WorkspaceChapterEditHistoryEntry {
  return {
    kind: "chapter-edit",
    id: createHistoryEntryId(),
    label: input.label,
    mergeKey: input.mergeKey,
    time: input.time ?? Date.now(),
    before: input.before,
    after: input.after,
  };
}

export function createMaskHistoryEntry(
  input: RecordWorkspaceMaskEdit,
): WorkspaceMaskEditHistoryEntry {
  return {
    kind: "mask-edit",
    id: createHistoryEntryId(),
    label: input.label,
    mergeKey: input.mergeKey,
    time: input.time ?? Date.now(),
    before: input.before,
    after: input.after,
  };
}

export function createImageHistoryEntry(
  input: RecordWorkspaceImageEdit,
): WorkspaceImageEditHistoryEntry {
  return {
    kind: "image-edit",
    id: createHistoryEntryId(),
    label: input.label,
    time: input.time ?? Date.now(),
    transactionId: input.transactionId,
    mask: input.mask,
  };
}

function createHistoryEntryId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  const entropy = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER).toString(
    36,
  );
  return `workspace-history-${Date.now()}-${entropy}`;
}
