import {
  buildPanelFormatSelection,
  createPanelSelectionKey,
  type PanelSyncState,
} from "../../../../shared/panelBridgeTypes";
import type { AppSessionViewModel } from "./appSessionViewModel";
import { isWorkspaceImageReadyForSelectedPage } from "./appSessionSelectors";
import { resolvePageSourceFontFaceFallbacks } from "../../lib/sourceFontSizeMatching";

export function buildPanelSyncState({
  blockEditingActions,
  core,
  derivedState,
  inpaintingBridge,
  uiState,
  workspaceHistory,
}: Pick<
  AppSessionViewModel,
  | "blockEditingActions"
  | "core"
  | "derivedState"
  | "inpaintingBridge"
  | "uiState"
  | "workspaceHistory"
>): PanelSyncState {
  const interactionBusy =
    inpaintingBridge.contextValue.jobActive ||
    uiState.translationFlowActive ||
    workspaceHistory.busy;
  const selectedIds = resolvePanelSelectedIds(derivedState);
  const selectedIdSet = new Set(selectedIds);
  const selectedBlocks =
    derivedState.selectedPage?.blocks.filter((block) =>
      selectedIdSet.has(block.id),
    ) ?? [];
  const selectedPageSize = derivedState.selectedPage
    ? {
        width: derivedState.selectedPage.width,
        height: derivedState.selectedPage.height,
      }
    : null;
  const selectedBlockSourceFontFaceFallbackPx =
    resolveSelectedBlockSourceFontFaceFallbackPx(
      derivedState,
      selectedPageSize,
    );
  return {
    areaTranslateAvailable:
      isWorkspaceImageReadyForSelectedPage({
        selectedPage: derivedState.selectedPage,
        workspaceImageDataUrl: derivedState.workspaceImageDataUrl,
        workspaceImagePageId: derivedState.workspaceImagePageId,
      }) && !interactionBusy,
    areaTranslateSelecting: Boolean(core.regionSelection?.active),
    disableChapterApply: interactionBusy,
    editorDisabled:
      derivedState.selectedPageEditLocked || workspaceHistory.busy,
    blockStylePresets: blockEditingActions.stylePresetSummaries,
    selectedBlock: derivedState.selectedBlock,
    selectedBlockCount: selectedIds.length,
    selectionKey: createPanelSelectionKey(selectedIds),
    formatSelection: buildPanelFormatSelection(selectedBlocks),
    editorTextTabRequestToken: uiState.editorTextTabRequestToken,
    transformMode:
      uiState.stageTool === "perspective" ||
      uiState.stageTool === "curve" ||
      uiState.stageTool === "warp"
        ? uiState.stageTool
        : "select",
    selectedPageSize,
    selectedBlockSourceFontFaceFallbackPx,
  };
}

function resolveSelectedBlockSourceFontFaceFallbackPx(
  derivedState: AppSessionViewModel["derivedState"],
  selectedPageSize: { width: number; height: number } | null,
): number | null {
  if (
    !derivedState.selectedBlock ||
    !derivedState.selectedPage ||
    !selectedPageSize
  ) {
    return null;
  }
  return (
    resolvePageSourceFontFaceFallbacks(
      derivedState.selectedPage.blocks,
      selectedPageSize,
    ).get(derivedState.selectedBlock.id) ?? null
  );
}

function resolvePanelSelectedIds(
  derivedState: AppSessionViewModel["derivedState"],
): readonly string[] {
  if (derivedState.selectedBlockIds.length > 0) {
    return derivedState.selectedBlockIds;
  }
  return derivedState.selectedBlock ? [derivedState.selectedBlock.id] : [];
}
