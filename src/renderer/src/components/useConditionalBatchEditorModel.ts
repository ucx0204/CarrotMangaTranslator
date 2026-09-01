/* eslint-disable max-lines -- preview, scope, sequence, and apply adapters intentionally meet at the editor model boundary */
import React from "react";
import { useTranslation } from "react-i18next";
import type { BlockStylePreset } from "../../../shared/blockStylePresets";
import {
  createConditionalBatchPreview,
  createConditionalBatchPreviewPage,
  createConditionalBatchSequencePreview,
  type ConditionalBatchEngineOptions,
} from "../../../shared/conditionalBatchEngine";
import {
  type ConditionalBatchApplyResult,
  type ConditionalBatchPreview,
  type ConditionalBatchPreviewResult,
  type ConditionalBatchSchemeDraftV2,
  type ConditionalBatchScope,
  type ConditionalBatchSequencePreview,
  type ConditionalBatchSequenceV2,
  type ConditionalBatchSnapshotV2,
} from "../../../shared/conditionalBatchRules";
import type { ChapterSnapshot } from "../../../shared/libraryTypes";
import type { GlossaryEntry } from "../../../shared/workContextTypes";
import { libraryGateway } from "../api/libraryGateway";
import { createWorkspaceInteractionPreviewStore } from "../lib/workspaceInteractionPreview";
import type { WorkspaceZoomController } from "../lib/workspaceZoom";
import type { AppWorkspaceProps } from "./appWorkspaceTypes";
import type { ConditionalBatchPreviewPaneProps } from "./ConditionalBatchPreviewPane";
import type { ConditionalBatchResultsCardProps } from "./ConditionalBatchResultsCard";
import type {
  ConditionalBatchFooterProps,
  ConditionalBatchRulePanelProps,
} from "./ConditionalBatchRulePanel";
import {
  useConditionalBatchSchemeController,
  type ConditionalBatchApplyNotice,
  type ConditionalBatchParsedDraft,
} from "./useConditionalBatchSchemeController";

type ConditionalBatchScopeKind = "selection" | "page" | "chapter";
type PreviewMode = "before" | "after";

export type ConditionalBatchEditorModelProps = {
  blockStylePresets?: readonly BlockStylePreset[];
  chapter: ChapterSnapshot;
  initialFind?: string;
  initialReplace?: string;
  selectedBlockIds?: readonly string[];
  selectedPageId: string;
  workId?: string;
  workspaceProps: AppWorkspaceProps;
  busy: boolean;
  canUndo: boolean;
  undoLabel: string | null;
  onApply: (
    scheme: ConditionalBatchSchemeDraftV2,
    preview: ConditionalBatchPreview,
    excludedResultKeys: ReadonlySet<string>,
    options?: ConditionalBatchEngineOptions,
  ) => Omit<ConditionalBatchApplyResult, "chapter">;
  onApplySequence?: (
    sequence: ConditionalBatchSequenceV2,
    snapshot: ConditionalBatchSnapshotV2,
    preview: ConditionalBatchSequencePreview,
    excludedResultKeys: ReadonlySet<string>,
    options?: ConditionalBatchEngineOptions,
  ) => Omit<ConditionalBatchApplyResult, "chapter">;
  onClose: () => void;
  onSelectPage: (pageId: string) => void;
  onUndo: () => Promise<boolean>;
};

export type ConditionalBatchEditorModel = {
  footerProps: ConditionalBatchFooterProps;
  hasDirtyTemporaryDrafts: boolean;
  previewPaneProps: ConditionalBatchPreviewPaneProps;
  resultsProps: ConditionalBatchResultsCardProps;
  rulePanelProps: ConditionalBatchRulePanelProps;
};

// eslint-disable-next-line max-lines-per-function -- the hook composes independently tested controllers into stable production component props
export function useConditionalBatchEditorModel(
  props: ConditionalBatchEditorModelProps,
): ConditionalBatchEditorModel {
  const glossary = useWorkGlossary(props.workId);
  const scheme = useConditionalBatchSchemeController({
    initialFind: props.initialFind,
    initialReplace: props.initialReplace,
    blockStylePresets: props.blockStylePresets,
  });
  const [activeSequenceId, setActiveSequenceId] = React.useState<string | null>(
    null,
  );
  const activeSequence =
    scheme.sequences.find((sequence) => sequence.id === activeSequenceId) ??
    null;
  React.useEffect(() => {
    if (activeSequenceId && !activeSequence) setActiveSequenceId(null);
  }, [activeSequence, activeSequenceId]);
  const preview = usePreviewController(
    props,
    scheme.parsedDraft,
    glossary,
    activeSequence,
    scheme.snapshot,
    scheme.selectedSchemeId,
  );
  const application = useApplicationController({
    excludedResultKeys: preview.excludedResultKeys,
    includedCount: preview.includedCount,
    parsedDraft: scheme.parsedDraft,
    preview: preview.preview,
    props,
    setApplyNotice: scheme.setApplyNotice,
    glossary,
    activeSequence,
    sequencePreview: preview.sequencePreview,
    snapshot: scheme.snapshot,
  });
  const sharedResultsProps: ConditionalBatchResultsCardProps = {
    currentResult: preview.currentResult,
    currentResultIndex: preview.currentResultIndex,
    excludedResultKeys: preview.excludedResultKeys,
    preview: preview.preview,
    onMoveResult: preview.moveResult,
    onSelectResult: preview.activateResult,
    onSetAllResultsIncluded: preview.setAllResultsIncluded,
    onToggleResult: preview.toggleResult,
  };
  return {
    hasDirtyTemporaryDrafts: scheme.hasDirtyTemporaryDrafts,
    previewPaneProps: {
      currentResultIndex: preview.currentResultIndex,
      pageName: preview.selectedPageName,
      previewMode: preview.previewMode,
      resultCount: preview.preview.results.length,
      workspaceProps: preview.previewWorkspaceProps,
      onChangePreviewMode: preview.setPreviewMode,
      onMoveResult: preview.moveResult,
    },
    resultsProps: sharedResultsProps,
    rulePanelProps: {
      applyNotice: scheme.applyNotice,
      activeSequence,
      sequencePreview: preview.sequencePreview,
      autosaveState: scheme.autosaveState,
      blockStylePresets: scheme.blockStylePresets,
      canDeleteScheme: scheme.canDeleteScheme,
      currentResult: preview.currentResult,
      draft: scheme.draft,
      favoriteSchemeIds: scheme.favoriteSchemeIds,
      recipePickerCanClose: scheme.recipePickerCanClose,
      recipePickerOpen: scheme.recipePickerOpen,
      savedSchemes: scheme.savedSchemes,
      scopeKind: preview.scopeKind,
      selectedBlockCount: props.selectedBlockIds?.length ?? 0,
      selectedSchemeId: scheme.selectedSchemeId,
      sequences: scheme.sequences,
      storageBusy: scheme.storageBusy,
      storageError: scheme.storageError,
      temporarySchemes: scheme.temporarySchemes,
      validationMessage: activeSequence ? null : scheme.validationMessage,
      yamlError: scheme.yamlError,
      yamlOpen: scheme.yamlOpen,
      yamlText: scheme.yamlText,
      onChangeDraft: (draft) => {
        setActiveSequenceId(null);
        scheme.changeDraft(draft);
      },
      onChangeScope: preview.changeScope,
      onChooseRecipe: scheme.chooseRecipe,
      onCloseRecipePicker: () => scheme.setRecipePickerOpen(false),
      onDeleteScheme: scheme.deleteScheme,
      onDeleteSequence: scheme.deleteSequence,
      onDuplicateScheme: scheme.duplicateScheme,
      onExportYaml: scheme.exportYaml,
      onImportYaml: scheme.importYaml,
      onNewScheme: scheme.createNewScheme,
      onOpenYaml: scheme.openYamlEditor,
      onOpenYamlFile: scheme.openYamlFile,
      onReflectYaml: scheme.reflectYamlInDraft,
      onSaveScheme: scheme.saveScheme,
      onSaveSequence: scheme.saveSequence,
      onPreviewSequence: setActiveSequenceId,
      onExitSequence: () => setActiveSequenceId(null),
      onSelectScheme: scheme.selectScheme,
      onSetYamlOpen: scheme.setYamlOpen,
      onSetYamlText: scheme.setYamlText,
      onToggleSchemeFavorite: scheme.toggleSchemeFavorite,
    },
    footerProps: {
      applyNotice: scheme.applyNotice,
      busy: props.busy,
      canUndo: props.canUndo,
      conflictCount: application.conflictCount,
      excludedCount: preview.excludedResultKeys.size,
      includedCount: preview.includedCount,
      inspectionOnly: preview.preview.inspectionOnly,
      sequenceName: activeSequence?.name ?? null,
      undoLabel: props.undoLabel,
      validationMessage: activeSequence ? null : scheme.validationMessage,
      onApply: application.apply,
      onUndo: application.undo,
    },
  };
}

function useWorkGlossary(workId: string | undefined): readonly GlossaryEntry[] {
  const [glossary, setGlossary] = React.useState<readonly GlossaryEntry[]>([]);
  React.useEffect(() => {
    let active = true;
    if (!workId) {
      setGlossary([]);
      return;
    }
    void libraryGateway
      .getWorkStyleGuide(workId)
      .then((guide) => {
        if (active) setGlossary(guide.glossary);
      })
      .catch(() => {
        if (active) setGlossary([]);
      });
    return () => {
      active = false;
    };
  }, [workId]);
  return glossary;
}

// Scope, exclusions, preview state and result navigation are intentionally one
// state machine: a regenerated preview prunes stale exclusions and selection.
// eslint-disable-next-line max-lines-per-function
function usePreviewController(
  props: ConditionalBatchEditorModelProps,
  parsedDraft: ConditionalBatchParsedDraft,
  glossary: readonly GlossaryEntry[],
  activeSequence: ConditionalBatchSequenceV2 | null,
  snapshot: ConditionalBatchSnapshotV2,
  schemeKey: string,
) {
  const { onSelectPage, selectedPageId } = props;
  const previewWorkspaceState = usePreviewWorkspaceState();
  const [scopeKind, setScopeKind] = React.useState<ConditionalBatchScopeKind>(
    props.selectedBlockIds?.length ? "selection" : "page",
  );
  const [scopePageId, setScopePageId] = React.useState(props.selectedPageId);
  const [previewMode, setPreviewMode] = React.useState<PreviewMode>("after");
  const [excludedByScheme, setExcludedByScheme] = React.useState<
    Readonly<Record<string, ReadonlySet<string>>>
  >({});
  const excludedResultKeys = excludedByScheme[schemeKey] ?? EMPTY_RESULT_KEYS;
  const [currentResultKey, setCurrentResultKey] = React.useState<string | null>(
    null,
  );
  const scope = React.useMemo(
    () => resolveScope(scopeKind, scopePageId, props.selectedBlockIds ?? []),
    [props.selectedBlockIds, scopeKind, scopePageId],
  );
  const sequencePreview = React.useMemo(
    () =>
      activeSequence
        ? createConditionalBatchSequencePreview(
            props.chapter,
            scope,
            activeSequence,
            snapshot,
            { glossary },
          )
        : null,
    [activeSequence, glossary, props.chapter, scope, snapshot],
  );
  const preview = React.useMemo(() => {
    if (sequencePreview) return sequencePreview.preview;
    return parsedDraft.success
      ? createConditionalBatchPreview(props.chapter, scope, parsedDraft.data, {
          glossary,
        })
      : emptyPreview(props.chapter.id);
  }, [glossary, parsedDraft, props.chapter, scope, sequencePreview]);
  React.useEffect(() => {
    const availableKeys = new Set(preview.results.map((result) => result.key));
    setExcludedByScheme((current) => {
      const currentKeys = current[schemeKey] ?? EMPTY_RESULT_KEYS;
      const next = new Set(
        [...currentKeys].filter((key) => availableKeys.has(key)),
      );
      return setsEqual(currentKeys, next)
        ? current
        : { ...current, [schemeKey]: next };
    });
    setCurrentResultKey((current) =>
      current && availableKeys.has(current)
        ? current
        : (preview.results[0]?.key ?? null),
    );
  }, [preview, schemeKey]);
  const currentResultIndex = Math.max(
    0,
    preview.results.findIndex((result) => result.key === currentResultKey),
  );
  const currentResult = preview.results[currentResultIndex] ?? null;
  const includedCount = preview.results.reduce(
    (count, result) => count + (excludedResultKeys.has(result.key) ? 0 : 1),
    0,
  );
  const activateResult = React.useCallback(
    (result: ConditionalBatchPreviewResult | null) => {
      if (!result) return;
      setCurrentResultKey(result.key);
      if (result.pageId !== selectedPageId) onSelectPage(result.pageId);
    },
    [onSelectPage, selectedPageId],
  );
  const moveResult = (offset: number): void => {
    if (preview.results.length === 0) return;
    const nextIndex =
      (currentResultIndex + offset + preview.results.length) %
      preview.results.length;
    activateResult(preview.results[nextIndex] ?? null);
  };
  const changeScope = (next: ConditionalBatchScopeKind): void => {
    if (next === "selection" && !props.selectedBlockIds?.length) return;
    setScopeKind(next);
    if (next !== "chapter") setScopePageId(selectedPageId);
  };
  const toggleResult = (key: string, included: boolean): void => {
    setExcludedByScheme((current) => {
      const next = new Set(current[schemeKey] ?? EMPTY_RESULT_KEYS);
      if (included) next.delete(key);
      else next.add(key);
      return { ...current, [schemeKey]: next };
    });
  };
  const setAllResultsIncluded = (included: boolean): void => {
    setExcludedByScheme((current) => ({
      ...current,
      [schemeKey]: included
        ? new Set<string>()
        : new Set(preview.results.map((result) => result.key)),
    }));
  };
  const view = createPreviewWorkspaceView({
    activateResult,
    currentResult,
    excludedResultKeys,
    preview,
    previewMode,
    previewWorkspaceState,
    props,
  });
  return {
    activateResult: (result: ConditionalBatchPreviewResult) =>
      activateResult(result),
    changeScope,
    currentResult,
    currentResultIndex,
    excludedResultKeys,
    includedCount,
    moveResult,
    preview,
    previewMode,
    scopeKind,
    sequencePreview,
    setPreviewMode,
    setAllResultsIncluded,
    toggleResult,
    ...view,
  };
}

function resolveScope(
  kind: ConditionalBatchScopeKind,
  pageId: string,
  blockIds: readonly string[],
): ConditionalBatchScope {
  if (kind === "chapter") return { kind: "chapter" };
  if (kind === "selection" && blockIds.length > 0) {
    return { kind: "selection", pageId, blockIds: [...blockIds] };
  }
  return { kind: "page", pageId };
}

type PreviewWorkspaceState = Pick<
  AppWorkspaceProps,
  | "imageRef"
  | "interactionPreviewStore"
  | "stageRef"
  | "workspacePanelRef"
  | "workspaceZoomControllerRef"
>;

function usePreviewWorkspaceState(): PreviewWorkspaceState {
  const imageRef = React.useRef<HTMLImageElement | null>(null);
  const stageRef = React.useRef<HTMLDivElement | null>(null);
  const workspacePanelRef = React.useRef<HTMLElement | null>(null);
  const workspaceZoomControllerRef =
    React.useRef<WorkspaceZoomController | null>(null);
  const [interactionPreviewStore] = React.useState(
    createWorkspaceInteractionPreviewStore,
  );
  return {
    imageRef,
    interactionPreviewStore,
    stageRef,
    workspacePanelRef,
    workspaceZoomControllerRef,
  };
}

function createPreviewWorkspaceView({
  activateResult,
  currentResult,
  excludedResultKeys,
  preview,
  previewMode,
  previewWorkspaceState,
  props,
}: {
  activateResult: (result: ConditionalBatchPreviewResult | null) => void;
  currentResult: ConditionalBatchPreviewResult | null;
  excludedResultKeys: ReadonlySet<string>;
  preview: ConditionalBatchPreview;
  previewMode: PreviewMode;
  previewWorkspaceState: PreviewWorkspaceState;
  props: ConditionalBatchEditorModelProps;
}): {
  previewWorkspaceProps: AppWorkspaceProps;
  selectedPageName: string;
} {
  const selectedPage =
    props.chapter.pages.find((page) => page.id === props.selectedPageId) ??
    props.chapter.pages[0] ??
    null;
  const previewPage = selectedPage
    ? createConditionalBatchPreviewPage(
        selectedPage,
        preview,
        excludedResultKeys,
        previewMode === "after",
      )
    : null;
  const highlightedBlockIds = preview.results
    .filter(
      (result) =>
        result.pageId === selectedPage?.id &&
        !excludedResultKeys.has(result.key),
    )
    .map((result) => result.blockId);
  return {
    selectedPageName: selectedPage?.name ?? "",
    previewWorkspaceProps: {
      ...props.workspaceProps,
      ...previewWorkspaceState,
      selectedPage: previewPage,
      selectedBlockId:
        currentResult?.pageId === selectedPage?.id
          ? currentResult.blockId
          : null,
      selectedBlockIds: highlightedBlockIds,
      showBlockChrome: true,
      showTextBlocks: true,
      showingOriginalPeek: false,
      jobActive: true,
      stageTool: "select",
      stageToolbarHidden: true,
      maskStrokes: [],
      regionSelectionActive: false,
      regionSelectionRect: null,
      originalImageOpacity: 0,
      originalImageOpacityAvailable: false,
      onBlockPointerDown: (event, block) => {
        event.preventDefault();
        event.stopPropagation();
        activateResult(
          preview.results.find(
            (result) =>
              result.pageId === selectedPage?.id && result.blockId === block.id,
          ) ?? null,
        );
      },
      onEffectiveScaleChange: undefined,
    },
  };
}

function useApplicationController({
  activeSequence,
  excludedResultKeys,
  includedCount,
  parsedDraft,
  preview,
  props,
  setApplyNotice,
  glossary,
  sequencePreview,
  snapshot,
}: {
  activeSequence: ConditionalBatchSequenceV2 | null;
  excludedResultKeys: ReadonlySet<string>;
  includedCount: number;
  parsedDraft: ConditionalBatchParsedDraft;
  preview: ConditionalBatchPreview;
  props: ConditionalBatchEditorModelProps;
  setApplyNotice: React.Dispatch<
    React.SetStateAction<ConditionalBatchApplyNotice>
  >;
  glossary: readonly GlossaryEntry[];
  sequencePreview: ConditionalBatchSequencePreview | null;
  snapshot: ConditionalBatchSnapshotV2;
}) {
  const { t } = useTranslation("components");
  const [conflictCount, setConflictCount] = React.useState(0);
  const apply = (): void => {
    if (includedCount === 0 || preview.inspectionOnly) {
      return;
    }
    const outcome = activeSequence
      ? sequencePreview && props.onApplySequence
        ? props.onApplySequence(
            activeSequence,
            snapshot,
            sequencePreview,
            excludedResultKeys,
            { glossary },
          )
        : null
      : parsedDraft.success
        ? props.onApply(parsedDraft.data, preview, excludedResultKeys, {
            glossary,
          })
        : null;
    if (!outcome) return;
    setConflictCount(outcome.conflictCount);
    const conflictsOnly =
      outcome.appliedCount === 0 && outcome.conflictCount > 0;
    setApplyNotice({
      kind: outcome.conflictCount > 0 ? "warning" : "success",
      message: conflictsOnly
        ? t("conditionalBatch.notice.conflictsOnly", {
            count: outcome.conflictCount,
          })
        : t("conditionalBatch.notice.applied", {
            applied: outcome.appliedCount,
            conflicts: outcome.conflictCount,
          }),
    });
  };
  const undo = (): void => {
    void props.onUndo().then((undone) => {
      if (undone) setConflictCount(0);
      setApplyNotice(
        undone
          ? { kind: "info", message: t("conditionalBatch.notice.undone") }
          : null,
      );
    });
  };
  return { apply, conflictCount, undo };
}

function emptyPreview(chapterId: string): ConditionalBatchPreview {
  return {
    chapterId,
    matchedCount: 0,
    unchangedMatchCount: 0,
    inspectionOnly: false,
    results: [],
  };
}

function setsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>) {
  if (left.size !== right.size) return false;
  return [...left].every((value) => right.has(value));
}

const EMPTY_RESULT_KEYS: ReadonlySet<string> = new Set();
