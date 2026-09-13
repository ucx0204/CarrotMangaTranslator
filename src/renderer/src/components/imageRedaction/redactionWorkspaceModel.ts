import type { ImageRedactionStroke } from "../../../../shared/imageRedaction";
import type {
  RedactionDecision,
  RedactionPreferences,
  RedactionPreset,
  RedactionView,
} from "../../../../shared/imageRedactionWorkspace";
import {
  copyRedactionStrokes,
  mergeRedactionStrokes,
  redactionStrokesEqual,
} from "../../../../shared/imageRedactionEditing";
import {
  editRedactionDocuments,
  nextUnreviewedPage,
  type RedactionSession,
} from "./redactionSession";

export function changeRedactionView(
  state: RedactionSession,
  patch: Partial<RedactionView>,
): RedactionSession {
  const view = { ...state.workspace.view, ...patch };
  if (JSON.stringify(view) === JSON.stringify(state.workspace.view))
    return state;
  return {
    ...state,
    workspace: { ...state.workspace, view },
    generation: state.generation + 1,
  };
}
export function changeRedactionPreferences(
  state: RedactionSession,
  patch: Partial<RedactionPreferences>,
): RedactionSession {
  return {
    ...state,
    workspace: {
      ...state.workspace,
      preferences: { ...state.workspace.preferences, ...patch },
    },
    generation: state.generation + 1,
  };
}
export function changeRedactionPresets(
  state: RedactionSession,
  presets: RedactionPreset[],
): RedactionSession {
  return {
    ...state,
    workspace: { ...state.workspace, presets },
    generation: state.generation + 1,
  };
}
export function changeRedactionStrokes(
  state: RedactionSession,
  pageId: string,
  strokes: ImageRedactionStroke[],
): RedactionSession {
  if (strokes.length > 1000)
    throw new Error("The page mask limit was exceeded");
  const document = state.documents[pageId];
  if (!document) throw new Error("Unknown redaction page");
  if (redactionStrokesEqual(document.strokes, strokes)) return state;
  return editRedactionDocuments(state, [
    { ...document, strokes, decision: "unreviewed" },
  ]);
}
export function decideRedactionPages(
  state: RedactionSession,
  ids: readonly string[],
  decision: RedactionDecision,
): RedactionSession {
  return editRedactionDocuments(
    state,
    ids.map((id) => {
      const document = state.documents[id];
      if (!document) throw new Error("Unknown redaction page");
      return { ...document, decision };
    }),
    ids.length > 1,
  );
}
export function navigateRedactionPage(
  state: RedactionSession,
  target: string,
): RedactionSession {
  if (!state.documents[target]) return state;
  const { view, preferences } = state.workspace;
  const previous = view.pageViews[view.currentId];
  const pageViews = { ...view.pageViews };
  if (!pageViews[target] && preferences.keepZoom && previous)
    pageViews[target] = { zoom: previous.zoom, x: 0, y: 0 };
  return changeRedactionView(state, { currentId: target, pageViews });
}
export function decideAndAdvanceRedaction(
  state: RedactionSession,
  decision: "reviewed",
): RedactionSession {
  const id = state.workspace.view.currentId;
  const next = decideRedactionPages(state, [id], decision);
  const target = nextUnreviewedPage(next, id);
  return target ? navigateRedactionPage(next, target) : next;
}
export function filteredRedactionPages(
  pages: RedactionSession["workspace"]["pages"],
  documents: RedactionSession["documents"],
  filter: RedactionView["filter"],
  errors: ReadonlySet<string>,
): string[] {
  return pages
    .filter((page) => {
      const document = documents[page.id];
      if (filter === "all") return true;
      if (filter === "error") return errors.has(page.id);
      if (filter === "masked") return document.strokes.length > 0;
      return document.decision === filter;
    })
    .map((page) => page.id);
}

export type RedactionCopySource = {
  width: number;
  height: number;
  strokes: ImageRedactionStroke[];
};
export function applyRedactionBatch(
  state: RedactionSession,
  input: {
    source: RedactionCopySource;
    ids: string[];
    scaling: "exact" | "proportional";
    replace: boolean;
  },
): RedactionSession {
  const metadata = new Map(
    state.workspace.pages.map((page) => [page.id, page]),
  );
  const changes = input.ids.map((id) => {
    const page = metadata.get(id);
    const document = state.documents[id];
    if (!page || !document) throw new Error("Unknown batch redaction page");
    const copied = copyRedactionStrokes(
      input.source.strokes,
      input.source,
      page,
      input.scaling,
    );
    const strokes = mergeRedactionStrokes(
      document.strokes,
      copied,
      input.replace,
    );
    if (strokes.length > 1000)
      throw new Error("The batch would exceed a page mask limit");
    return { ...document, strokes, decision: "unreviewed" as const };
  });
  return editRedactionDocuments(state, changes, input.ids.length > 1);
}
