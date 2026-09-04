import {
  applyConditionalBatchPreview,
  applyConditionalBatchSequencePreview,
  type ConditionalBatchEngineOptions,
} from "../../../../shared/conditionalBatchEngine";
import type {
  ConditionalBatchPreview,
  ConditionalBatchSequencePreview,
  ConditionalBatchSequenceV2,
  ConditionalBatchSnapshotV2,
  ConditionalBatchSchemeDraftV2,
} from "../../../../shared/conditionalBatchRules";
import type { AppWorkspaceProps } from "../../components/appWorkspaceTypes";
import type { AppSessionViewProps } from "./AppSessionView";
import type { AppSessionViewModel } from "./appSessionViewModel";
import { isChapterMutationBlocked } from "./workspaceActivity";

const HISTORY_LABEL_PREFIX = "일괄 편집: ";

export function createConditionalBatchEditorProps(
  model: AppSessionViewModel,
  workspaceProps: AppWorkspaceProps,
): AppSessionViewProps["conditionalBatchEditorProps"] {
  const {
    core,
    derivedState,
    pageNavigationHandlers,
    settingsDialog,
    uiState,
  } = model;
  if (
    !uiState.conditionalBatchOpen ||
    !core.currentChapter ||
    !derivedState.selectedPage
  ) {
    return null;
  }
  const mutationDisabled = isChapterMutationBlocked(model);
  return {
    chapter: core.currentChapter,
    blockStylePresets: settingsDialog?.settings?.blockStylePresets ?? [],
    initialFind: uiState.conditionalBatchInitialFind ?? "",
    initialReplace: uiState.conditionalBatchInitialReplace ?? "",
    selectedBlockIds: derivedState.selectedBlockIds ?? [],
    selectedPageId: derivedState.selectedPage.id,
    workId: core.currentChapter.workId,
    workspaceProps,
    busy: mutationDisabled,
    canUndo:
      model.workspaceHistory.canUndo &&
      Boolean(
        model.workspaceHistory.undoLabel?.startsWith(HISTORY_LABEL_PREFIX),
      ),
    undoLabel: model.workspaceHistory.undoLabel,
    onApply: (scheme, preview, excludedResultKeys, options) =>
      applyEditorChanges(model, scheme, preview, excludedResultKeys, options),
    onApplySequence: (
      sequence,
      snapshot,
      preview,
      excludedResultKeys,
      options,
    ) =>
      applyEditorSequenceChanges(
        model,
        sequence,
        snapshot,
        preview,
        excludedResultKeys,
        options,
      ),
    onEntered: () => {
      if (uiState.textViewOpen) uiState.setTextViewOpen(false);
    },
    onClose: () => {
      uiState.setConditionalBatchInitialFind("");
      uiState.setConditionalBatchInitialReplace("");
      uiState.setConditionalBatchOpen(false);
    },
    onSelectPage: pageNavigationHandlers.selectPageForReading,
    onUndo: model.workspaceHistory.undo,
  };
}

function applyEditorSequenceChanges(
  model: AppSessionViewModel,
  sequence: ConditionalBatchSequenceV2,
  snapshot: ConditionalBatchSnapshotV2,
  preview: ConditionalBatchSequencePreview,
  excludedResultKeys: ReadonlySet<string>,
  options?: ConditionalBatchEngineOptions,
) {
  if (isChapterMutationBlocked(model)) {
    return { appliedCount: 0, conflictCount: 0, dirtyPageIds: [] };
  }
  const current = model.core.currentChapter;
  if (!current) {
    return { appliedCount: 0, conflictCount: 0, dirtyPageIds: [] };
  }
  const result = applyConditionalBatchSequencePreview(
    current,
    sequence,
    snapshot,
    preview,
    excludedResultKeys,
    undefined,
    options,
  );
  const firstDirtyPageId = result.dirtyPageIds[0];
  if (firstDirtyPageId) {
    model.updateCurrentChapter(firstDirtyPageId, () => result.chapter, {
      dirtyPageIds: result.dirtyPageIds,
      label: HISTORY_LABEL_PREFIX + sequence.name,
    });
  }
  return {
    appliedCount: result.appliedCount,
    conflictCount: result.conflictCount,
    dirtyPageIds: result.dirtyPageIds,
  };
}

function applyEditorChanges(
  model: AppSessionViewModel,
  scheme: ConditionalBatchSchemeDraftV2,
  preview: ConditionalBatchPreview,
  excludedResultKeys: ReadonlySet<string>,
  options?: ConditionalBatchEngineOptions,
) {
  if (isChapterMutationBlocked(model)) {
    return { appliedCount: 0, conflictCount: 0, dirtyPageIds: [] };
  }
  const current = model.core.currentChapter;
  if (!current) {
    return { appliedCount: 0, conflictCount: 0, dirtyPageIds: [] };
  }
  const result = applyConditionalBatchPreview(
    current,
    scheme,
    preview,
    excludedResultKeys,
    undefined,
    options,
  );
  const firstDirtyPageId = result.dirtyPageIds[0];
  if (firstDirtyPageId) {
    model.updateCurrentChapter(firstDirtyPageId, () => result.chapter, {
      dirtyPageIds: result.dirtyPageIds,
      label: HISTORY_LABEL_PREFIX + scheme.name,
    });
  }
  return {
    appliedCount: result.appliedCount,
    conflictCount: result.conflictCount,
    dirtyPageIds: result.dirtyPageIds,
  };
}
