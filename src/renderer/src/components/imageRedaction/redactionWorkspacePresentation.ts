import { redactionProgress, type RedactionSession } from "./redactionSession";

export type RedactionWorkspaceSummary = {
  reviewed: number;
  unreviewed: number;
  total: number;
  hasPreviousMask: boolean;
};

/** Presentation reads current documents only, never the original page snapshots. */
export function summarizeRedactionWorkspace(
  state: RedactionSession,
): RedactionWorkspaceSummary {
  const { pages, view } = state.workspace;
  const previous =
    pages[pages.findIndex((page) => page.id === view.currentId) - 1];
  return {
    ...redactionProgress(state.documents),
    total: pages.length,
    hasPreviousMask: Boolean(
      previous && state.documents[previous.id]?.strokes.length,
    ),
  };
}
