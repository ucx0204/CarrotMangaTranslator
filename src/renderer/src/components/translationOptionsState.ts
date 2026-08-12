import React from "react";
import type { AnalysisBlockMode } from "../../../shared/analysisTypes";
import type {
  ChapterSnapshot,
  LibraryIndex,
  LibraryWorkSummary,
} from "../../../shared/libraryTypes";
import type {
  TranslationWorkflowMode,
  UiSettings,
} from "../../../shared/settingsTypes";
import type { TranslationFlowOptions } from "../hooks/useTranslationActions";
import {
  buildRunSelection,
  selectedPageIds,
  type ChapterSelectionMap,
  type TranslationOptionsInitialScope,
} from "../lib/translationSelection";

export type TranslationOptionsFormProps = {
  chapter: ChapterSnapshot;
  work: LibraryWorkSummary | null;
  selection: ChapterSelectionMap;
  onSelectionChange: (selection: ChapterSelectionMap) => void;
  workflowMode: TranslationWorkflowMode;
  onWorkflowModeChange: (mode: TranslationWorkflowMode) => void;
  blockMode: AnalysisBlockMode;
  onBlockModeChange: (mode: AnalysisBlockMode) => void;
  autoFontMatching: boolean;
  onAutoFontMatchingChange: (enabled: boolean) => void;
  naturalTextLayout: boolean;
  onNaturalTextLayoutChange: (enabled: boolean) => void;
  eraseOriginalWorkflow: boolean;
  onEraseOriginalWorkflowChange: (enabled: boolean) => void;
  bubbleLayoutWorkflow: boolean;
  onBubbleLayoutWorkflowChange: (enabled: boolean) => void;
  overwriteRisk?: boolean;
};

export function useTranslationOptionsModalState(
  chapter: ChapterSnapshot,
  initialScope: TranslationOptionsInitialScope,
  library: LibraryIndex,
  uiSettings: UiSettings | undefined,
): {
  formProps: TranslationOptionsFormProps;
  runSelection: TranslationFlowOptions["selection"];
  overwriteRisk: boolean;
} {
  const work = React.useMemo(
    () => library.works.find((item) => item.id === chapter.workId) ?? null,
    [chapter.workId, library.works],
  );
  const [selection, setSelection] = React.useState<ChapterSelectionMap>(() =>
    createInitialSelection(chapter, work, initialScope),
  );
  const formFields = useTranslationFormFields(uiSettings);
  const chapterOrder = React.useMemo(
    () => (work ? work.chapters.map((item) => item.id) : [chapter.id]),
    [chapter.id, work],
  );
  const runSelection = React.useMemo(
    () => buildRunSelection(chapterOrder, selection),
    [chapterOrder, selection],
  );
  const overwriteRisk = React.useMemo(
    () => selectionCanOverwriteEdits(selection, chapter, work),
    [chapter, selection, work],
  );
  return {
    formProps: {
      ...formFields,
      chapter,
      onSelectionChange: setSelection,
      selection,
      work,
    },
    overwriteRisk,
    runSelection,
  };
}

function useTranslationFormFields(
  uiSettings: UiSettings | undefined,
): Omit<
  TranslationOptionsFormProps,
  "chapter" | "onSelectionChange" | "overwriteRisk" | "selection" | "work"
> {
  const [workflowMode, onWorkflowModeChange] = React.useState(
    uiSettings?.translationWorkflowDefault ?? "cumulative",
  );
  const [blockMode, onBlockModeChange] = React.useState<AnalysisBlockMode>(
    uiSettings?.blockModeDefault ?? "auto",
  );
  const [autoFontMatching, onAutoFontMatchingChange] = React.useState(
    uiSettings?.autoFontMatchingDefault ?? false,
  );
  const [naturalTextLayout, onNaturalTextLayoutChange] = React.useState(
    uiSettings?.naturalTextLayoutDefault ?? true,
  );
  const completionDefaults = resolveInitialCompletionDefaults(uiSettings);
  const [eraseOriginalWorkflow, onEraseOriginalWorkflowChange] = React.useState(
    completionDefaults.eraseOriginal,
  );
  const [bubbleLayoutWorkflow, onBubbleLayoutWorkflowChange] = React.useState(
    completionDefaults.bubbleLayout,
  );
  return {
    autoFontMatching,
    blockMode,
    bubbleLayoutWorkflow,
    eraseOriginalWorkflow,
    naturalTextLayout,
    onAutoFontMatchingChange,
    onBlockModeChange,
    onBubbleLayoutWorkflowChange,
    onEraseOriginalWorkflowChange,
    onNaturalTextLayoutChange,
    onWorkflowModeChange,
    workflowMode,
  };
}

function createInitialSelection(
  chapter: ChapterSnapshot,
  work: LibraryWorkSummary | null,
  initialScope: TranslationOptionsInitialScope,
): ChapterSelectionMap {
  if (initialScope === "work-all" && work) {
    return new Map(
      work.chapters.map((item) => [item.id, { kind: "all" }] as const),
    );
  }
  return new Map([[chapter.id, { kind: "pending" }]]);
}

function resolveInitialCompletionDefaults(uiSettings: UiSettings | undefined): {
  eraseOriginal: boolean;
  bubbleLayout: boolean;
} {
  if (uiSettings?.eraseOriginalWorkflowDefault === undefined) {
    return {
      eraseOriginal: uiSettings?.bubbleLayoutWorkflowDefault ?? false,
      bubbleLayout: true,
    };
  }
  return {
    eraseOriginal: uiSettings.eraseOriginalWorkflowDefault,
    bubbleLayout: uiSettings.bubbleLayoutWorkflowDefault ?? true,
  };
}

function selectionCanOverwriteEdits(
  selection: ChapterSelectionMap,
  currentChapter: ChapterSnapshot,
  work: LibraryWorkSummary | null,
): boolean {
  for (const [chapterId, chapterSelection] of selection) {
    if (chapterSelection.kind === "pending") continue;
    if (chapterId !== currentChapter.id) {
      const summary = work?.chapters.find(
        (chapter) => chapter.id === chapterId,
      );
      if (
        chapterSelection.kind === "pages" ||
        summary?.status === "completed" ||
        summary?.status === "partial"
      ) {
        return true;
      }
      continue;
    }
    const selectedIds = selectedPageIds(chapterSelection, currentChapter.pages);
    if (
      currentChapter.pages.some(
        (page) =>
          selectedIds.has(page.id) &&
          (page.analysisStatus === "completed" || page.blocks.length > 0),
      )
    ) {
      return true;
    }
  }
  return false;
}
