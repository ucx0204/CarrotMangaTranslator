import { isDeepStrictEqual } from "node:util";
import type {
  RedactionView,
  RedactionWorkspace,
  RedactionWorkspacePage,
  SaveRedactionWorkspace,
} from "../../shared/imageRedactionWorkspace";

export type StoredRedactionPage = Pick<
  RedactionWorkspacePage,
  "fingerprint" | "strokes" | "decision" | "width" | "height"
>;
type Settings = Pick<RedactionWorkspace, "preferences" | "presets">;
type DraftStore = Settings & {
  pages: Record<string, StoredRedactionPage>;
  views: Record<string, RedactionView>;
};
export type RedactionDraftBaseline = Settings & {
  scopeKey: string;
  pages: Record<string, StoredRedactionPage | undefined>;
  view: RedactionView | undefined;
};

/** Observe only this session's resources, including records that do not exist yet. */
export function observeRedactionDraft(
  disk: DraftStore,
  paths: readonly string[],
  scopeKey: string,
): RedactionDraftBaseline {
  return {
    scopeKey,
    pages: Object.fromEntries(paths.map((path) => [path, disk.pages[path]])),
    view: disk.views[scopeKey],
    preferences: disk.preferences,
    presets: disk.presets,
  };
}

function assertUnchanged(observed: unknown, current: unknown): void {
  if (!isDeepStrictEqual(observed, current))
    throw new Error(
      "다른 가리기 창에서 초안이 변경되었습니다. 이 창의 내용을 보존한 뒤 다시 열어 주세요.",
    );
}

/** A save never adopts unrelated writes as this session's observed baseline. */
export function applyRedactionDraftChanges(
  disk: DraftStore,
  baseline: RedactionDraftBaseline,
  input: {
    previous: RedactionWorkspace;
    request: SaveRedactionWorkspace;
    pages: Record<string, StoredRedactionPage>;
  },
): RedactionDraftBaseline {
  const { previous, request, pages } = input;
  const viewChanged = !isDeepStrictEqual(previous.view, request.view);
  const preferencesChanged = !isDeepStrictEqual(
    previous.preferences,
    request.preferences,
  );
  const presetsChanged = !isDeepStrictEqual(previous.presets, request.presets);
  for (const path of Object.keys(pages))
    assertUnchanged(baseline.pages[path], disk.pages[path]);
  if (viewChanged)
    assertUnchanged(baseline.view, disk.views[baseline.scopeKey]);
  if (preferencesChanged)
    assertUnchanged(baseline.preferences, disk.preferences);
  if (presetsChanged) assertUnchanged(baseline.presets, disk.presets);

  // All conflicts are checked before mutating the transaction's private snapshot.
  Object.assign(disk.pages, pages);
  if (viewChanged) disk.views[baseline.scopeKey] = request.view;
  if (preferencesChanged) disk.preferences = request.preferences;
  if (presetsChanged) disk.presets = request.presets;
  return {
    ...baseline,
    pages: { ...baseline.pages, ...pages },
    view: viewChanged ? request.view : baseline.view,
    preferences: preferencesChanged
      ? request.preferences
      : baseline.preferences,
    presets: presetsChanged ? request.presets : baseline.presets,
  };
}

/** Approval binds the pages actually observed/saved, not the root's write counter. */
export function assertRedactionDraftPagesCurrent(
  disk: DraftStore,
  baseline: RedactionDraftBaseline,
): void {
  for (const [path, observed] of Object.entries(baseline.pages))
    assertUnchanged(observed, disk.pages[path]);
}
