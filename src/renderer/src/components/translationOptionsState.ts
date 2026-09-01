import React from "react";
import type { AnalysisBlockMode } from "../../../shared/analysisTypes";
import type {
  ChapterSnapshot,
  LibraryChapterSummary,
  LibraryIndex,
  LibraryWorkSummary,
} from "../../../shared/libraryTypes";
import type {
  CumulativeContextDetail,
  TranslationWorkflowMode,
  UiSettings,
} from "../../../shared/settingsTypes";
import type { TranslationFlowOptions } from "../hooks/useTranslationActions";
import {
  DEFAULT_SOURCE_LANGUAGE,
  DEFAULT_TARGET_LANGUAGE,
} from "../../../shared/translationLanguageDefaults";
import {
  buildRunSelection,
  createPendingChapterSelection,
  pageRunIntent,
  type ChapterSel,
  type ChapterSelectionMap,
  type TranslationResumeContext,
  type TranslationOptionsInitialScope,
} from "../lib/translationSelection";

export type TranslationOptionsFormProps = {
  chapter: ChapterSnapshot;
  work: LibraryWorkSummary | null;
  selection: ChapterSelectionMap;
  onSelectionChange: (selection: ChapterSelectionMap) => void;
  workflowMode: TranslationWorkflowMode;
  onWorkflowModeChange: (mode: TranslationWorkflowMode) => void;
  cumulativeContextDetail: CumulativeContextDetail;
  onCumulativeContextDetailChange: (detail: CumulativeContextDetail) => void;
  blockMode: AnalysisBlockMode;
  sourceLanguage: string;
  targetLanguage: string;
  onBlockModeChange: (mode: AnalysisBlockMode) => void;
  autoFontMatching: boolean;
  onAutoFontMatchingChange: (enabled: boolean) => void;
  aiFontSizeMatching: boolean;
  onAiFontSizeMatchingChange: (enabled: boolean) => void;
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
  languagePair?: Readonly<{
    sourceLanguage?: string;
    targetLanguage?: string;
  }>,
): {
  formProps: TranslationOptionsFormProps;
  runSelection: TranslationFlowOptions["selection"];
  overwriteRisk: boolean;
  hasResumeSelection: boolean;
} {
  const work = React.useMemo(
    () => library.works.find((item) => item.id === chapter.workId) ?? null,
    [chapter.workId, library.works],
  );
  const formFields = useTranslationFormFields(uiSettings);
  const sourceLanguage =
    languagePair?.sourceLanguage ?? DEFAULT_SOURCE_LANGUAGE;
  const targetLanguage =
    languagePair?.targetLanguage ?? DEFAULT_TARGET_LANGUAGE;
  const resumeContext = React.useMemo(
    () =>
      resolveTranslationResumeContext({
        blockMode: formFields.blockMode,
        bubbleLayoutWorkflow: formFields.bubbleLayoutWorkflow,
        eraseOriginalWorkflow: formFields.eraseOriginalWorkflow,
        sourceLanguage,
        targetLanguage,
      }),
    [
      formFields.blockMode,
      formFields.bubbleLayoutWorkflow,
      formFields.eraseOriginalWorkflow,
      sourceLanguage,
      targetLanguage,
    ],
  );
  const [selection, setSelection] = React.useState<ChapterSelectionMap>(() =>
    createInitialSelection(chapter, work, initialScope, resumeContext),
  );
  const chapterOrder = React.useMemo(
    () => (work ? work.chapters.map((item) => item.id) : [chapter.id]),
    [chapter.id, work],
  );
  const runSelection = React.useMemo(
    () => buildRunSelection(chapterOrder, selection),
    [chapterOrder, selection],
  );
  const overwriteRisk = React.useMemo(
    () => selectionCanOverwriteEdits(selection, chapter, work, resumeContext),
    [chapter, resumeContext, selection, work],
  );
  const hasResumeSelection = React.useMemo(
    () => selectionHasResume(selection, chapter, resumeContext),
    [chapter, resumeContext, selection],
  );
  return {
    formProps: {
      ...formFields,
      chapter,
      onSelectionChange: setSelection,
      selection,
      sourceLanguage,
      targetLanguage,
      work,
    },
    overwriteRisk,
    hasResumeSelection,
    runSelection,
  };
}

function selectionHasResume(
  selection: ChapterSelectionMap,
  currentChapter: ChapterSnapshot,
  resumeContext: TranslationResumeContext,
): boolean {
  for (const [chapterId, chapterSelection] of selection) {
    if (chapterId === currentChapter.id) {
      if (
        currentChapter.pages.some(
          (page) =>
            pageRunIntent(chapterSelection, page, resumeContext) === "resume",
        )
      ) {
        return true;
      }
      continue;
    }
    if (
      chapterSelection.kind === "pages" &&
      chapterSelection.pageIds.size >
        (chapterSelection.restartPageIds?.size ?? chapterSelection.pageIds.size)
    ) {
      return true;
    }
  }
  return false;
}

function useTranslationFormFields(
  uiSettings: UiSettings | undefined,
): Omit<
  TranslationOptionsFormProps,
  | "chapter"
  | "onSelectionChange"
  | "overwriteRisk"
  | "selection"
  | "sourceLanguage"
  | "targetLanguage"
  | "work"
> {
  const initial = resolveInitialTranslationFormValues(uiSettings);
  const [workflowMode, onWorkflowModeChange] = React.useState(
    initial.workflowMode,
  );
  const [cumulativeContextDetail, onCumulativeContextDetailChange] =
    React.useState<CumulativeContextDetail>(initial.cumulativeContextDetail);
  const [blockMode, onBlockModeChange] = React.useState<AnalysisBlockMode>(
    initial.blockMode,
  );
  const [autoFontMatching, onAutoFontMatchingChange] = React.useState(
    initial.autoFontMatching,
  );
  const [naturalTextLayout, onNaturalTextLayoutChange] = React.useState(
    initial.naturalTextLayout,
  );
  const [aiFontSizeMatching, onAiFontSizeMatchingChange] = React.useState(
    initial.aiFontSizeMatching,
  );
  const [eraseOriginalWorkflow, onEraseOriginalWorkflowChange] = React.useState(
    initial.eraseOriginalWorkflow,
  );
  const [bubbleLayoutWorkflow, onBubbleLayoutWorkflowChange] = React.useState(
    initial.bubbleLayoutWorkflow,
  );
  return {
    autoFontMatching,
    blockMode,
    bubbleLayoutWorkflow,
    cumulativeContextDetail,
    eraseOriginalWorkflow,
    aiFontSizeMatching,
    naturalTextLayout,
    onAutoFontMatchingChange,
    onBlockModeChange,
    onBubbleLayoutWorkflowChange,
    onCumulativeContextDetailChange,
    onEraseOriginalWorkflowChange,
    onAiFontSizeMatchingChange,
    onNaturalTextLayoutChange,
    onWorkflowModeChange,
    workflowMode,
  };
}

function resolveInitialTranslationFormValues(
  uiSettings: UiSettings | undefined,
) {
  const data = uiSettings ?? {};
  const completion = resolveInitialCompletionDefaults(uiSettings);
  return {
    workflowMode: data.translationWorkflowDefault ?? "cumulative",
    cumulativeContextDetail: data.cumulativeContextDetailDefault ?? "detailed",
    blockMode: data.blockModeDefault ?? "auto",
    autoFontMatching: data.autoFontMatchingDefault ?? false,
    naturalTextLayout: data.naturalTextLayoutDefault ?? false,
    aiFontSizeMatching:
      data.aiFontSizeMatchingDefault ?? data.fontSizeAutoFitDefault ?? true,
    eraseOriginalWorkflow: completion.eraseOriginal,
    bubbleLayoutWorkflow: completion.bubbleLayout,
  } satisfies {
    workflowMode: TranslationWorkflowMode;
    cumulativeContextDetail: CumulativeContextDetail;
    blockMode: AnalysisBlockMode;
    autoFontMatching: boolean;
    naturalTextLayout: boolean;
    aiFontSizeMatching: boolean;
    eraseOriginalWorkflow: boolean;
    bubbleLayoutWorkflow: boolean;
  };
}

function createInitialSelection(
  chapter: ChapterSnapshot,
  work: LibraryWorkSummary | null,
  initialScope: TranslationOptionsInitialScope,
  resumeContext: TranslationResumeContext,
): ChapterSelectionMap {
  if (initialScope === "work-all" && work) {
    return new Map(
      work.chapters.map((item) => [item.id, { kind: "all" }] as const),
    );
  }
  const pending = createPendingChapterSelection(chapter.pages, resumeContext);
  return pending ? new Map([[chapter.id, pending]]) : new Map();
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
  resumeContext: TranslationResumeContext,
): boolean {
  for (const [chapterId, chapterSelection] of selection) {
    if (chapterSelection.kind === "pending") continue;
    if (chapterId === currentChapter.id) {
      if (
        currentSelectionCanOverwrite(
          chapterSelection,
          currentChapter,
          resumeContext,
        )
      ) {
        return true;
      }
      continue;
    }
    const summary = work?.chapters.find((chapter) => chapter.id === chapterId);
    if (externalSelectionCanOverwrite(chapterSelection, summary)) {
      return true;
    }
  }
  return false;
}

function currentSelectionCanOverwrite(
  selection: ChapterSel,
  chapter: ChapterSnapshot,
  resumeContext: TranslationResumeContext,
): boolean {
  return chapter.pages.some(
    (page) =>
      pageRunIntent(selection, page, resumeContext) === "restart" &&
      (page.analysisStatus === "completed" || page.blocks.length > 0),
  );
}

function externalSelectionCanOverwrite(
  selection: ChapterSel,
  chapter: LibraryChapterSummary | undefined,
): boolean {
  const explicitlyRestarts =
    selection.kind === "pages" &&
    (selection.restartPageIds?.size ?? selection.pageIds.size) > 0;
  return (
    explicitlyRestarts ||
    chapter?.status === "completed" ||
    chapter?.status === "partial"
  );
}

export function resolveTranslationResumeContext(
  fields: Pick<
    TranslationOptionsFormProps,
    | "blockMode"
    | "eraseOriginalWorkflow"
    | "bubbleLayoutWorkflow"
    | "sourceLanguage"
    | "targetLanguage"
  >,
): TranslationResumeContext {
  return {
    blockMode: fields.blockMode,
    sourceLanguage: fields.sourceLanguage,
    targetLanguage: fields.targetLanguage,
    completionWorkflow: fields.eraseOriginalWorkflow
      ? fields.bubbleLayoutWorkflow
        ? "bubble-layout"
        : "erase-original"
      : undefined,
  };
}
