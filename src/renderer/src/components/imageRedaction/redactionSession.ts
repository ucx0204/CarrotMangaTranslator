import type {
  RedactionDocument,
  RedactionWorkspace,
} from "../../../../shared/imageRedactionWorkspace";

type DocumentMap = Record<string, RedactionDocument>;
type Edit = { before: DocumentMap; after: DocumentMap; batch: boolean };
export type RedactionSession = {
  workspace: RedactionWorkspace;
  documents: DocumentMap;
  undo: Edit[];
  redo: Edit[];
  generation: number;
};
const HISTORY_LIMIT = 100;

export function createRedactionSession(
  workspace: RedactionWorkspace,
): RedactionSession {
  return {
    workspace,
    documents: Object.fromEntries(
      workspace.pages.map(({ id, fingerprint, strokes, decision }) => [
        id,
        { id, fingerprint, strokes, decision },
      ]),
    ),
    undo: [],
    redo: [],
    generation: 0,
  };
}

export function editRedactionDocuments(
  state: RedactionSession,
  changes: RedactionDocument[],
  batch = false,
): RedactionSession {
  const before: DocumentMap = {},
    after: DocumentMap = {};
  for (const change of changes) {
    const original = state.documents[change.id];
    if (!original || original.fingerprint !== change.fingerprint)
      throw new Error("Unknown redaction page revision");
    if (JSON.stringify(original) === JSON.stringify(change)) continue;
    before[change.id] = original;
    after[change.id] = change;
  }
  if (!Object.keys(after).length) return state;
  return {
    ...state,
    documents: { ...state.documents, ...after },
    undo: [...state.undo, { before, after, batch }].slice(-HISTORY_LIMIT),
    redo: [],
    generation: state.generation + 1,
  };
}

function applicable(
  edit: Edit,
  documents: DocumentMap,
  direction: "undo" | "redo",
): boolean {
  const expected = direction === "undo" ? edit.after : edit.before;
  return Object.entries(expected).every(
    ([id, document]) => documents[id] === document,
  );
}

function historyIndex(
  state: RedactionSession,
  direction: "undo" | "redo",
  pageId: string,
  batch: boolean,
): number {
  const entries = state[direction];
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    const matches = batch
      ? entry.batch
      : !entry.batch && Boolean(entry.after[pageId]);
    if (matches && applicable(entry, state.documents, direction)) return index;
  }
  return -1;
}

export function canRestoreRedactionEdit(
  state: RedactionSession,
  direction: "undo" | "redo",
  pageId: string,
  batch = false,
): boolean {
  return historyIndex(state, direction, pageId, batch) >= 0;
}

export function restoreRedactionEdit(
  state: RedactionSession,
  direction: "undo" | "redo",
  pageId: string,
  batch = false,
): RedactionSession {
  const index = historyIndex(state, direction, pageId, batch);
  if (index < 0) return state;
  const source = [...state[direction]];
  const [edit] = source.splice(index, 1);
  const opposite = direction === "undo" ? "redo" : "undo";
  return {
    ...state,
    documents: {
      ...state.documents,
      ...(direction === "undo" ? edit.before : edit.after),
    },
    [direction]: source,
    [opposite]: [...state[opposite], edit].slice(-HISTORY_LIMIT),
    generation: state.generation + 1,
  };
}

export function redactionProgress(
  documents: DocumentMap,
): Record<"reviewed" | "unreviewed" | "deferred", number> {
  const counts = { reviewed: 0, unreviewed: 0, deferred: 0 };
  for (const document of Object.values(documents)) counts[document.decision]++;
  return counts;
}

export function nextUnreviewedPage(
  state: RedactionSession,
  currentId: string,
): string | undefined {
  const pages = state.workspace.pages;
  const start = pages.findIndex((page) => page.id === currentId);
  for (let step = 1; step <= pages.length; step++) {
    const page = pages[(Math.max(start, 0) + step) % pages.length];
    if (state.documents[page.id].decision === "unreviewed") return page.id;
  }
  return undefined;
}

export function selectRedactionRange(
  ids: readonly string[],
  selected: readonly string[],
  anchor: string,
  target: string,
  extend: boolean,
  toggle: boolean,
): string[] {
  if (extend) {
    const start = ids.indexOf(anchor),
      end = ids.indexOf(target);
    if (start >= 0 && end >= 0)
      return [
        ...new Set([
          ...selected,
          ...ids.slice(Math.min(start, end), Math.max(start, end) + 1),
        ]),
      ];
  }
  if (!toggle) return [target];
  return selected.includes(target)
    ? selected.filter((id) => id !== target)
    : [...selected, target];
}
