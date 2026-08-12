import React from "react";
import { useTranslation } from "react-i18next";
import type {
  ChapterSnapshot,
  LibraryIndex,
} from "../../../shared/libraryTypes";
import {
  buildExportSelection,
  createDefaultExportSelection,
  type ExportChapterSelection,
  type ExportSelectionMap,
} from "../lib/exportSelection";
import { ExportPagePicker } from "./ExportPagePicker";
import { Modal } from "./ui/Modal";
import type { PageJobTargetSnapshot } from "../../../shared/pageRevision";
import type { PageImageExportFormat } from "../../../shared/pageImageExportTypes";
import { exportGateway } from "../api/exportGateway";
import {
  ExportOptionsFooter,
  ExportRenderOptions,
} from "./ExportRenderOptions";
import {
  ExportPreflightPanel,
  type ExportIssueNavigationHandler,
  type ExportPreflightState,
} from "./ExportPreflightPanel";

export type ExportOptionsModalProps = {
  chapter: ChapterSnapshot;
  currentPageId: string;
  jobActive: boolean;
  library: LibraryIndex;
  /** Return false when the native folder chooser is cancelled. */
  onStart: (
    selection: ExportChapterSelection[],
    expectedTargets?: PageJobTargetSnapshot[],
    options?: { omitText?: boolean; outputFormat?: PageImageExportFormat },
  ) => Promise<boolean>;
  onNavigateToIssue?: ExportIssueNavigationHandler;
  onClose: () => void;
};

export function ExportOptionsModal({
  chapter,
  currentPageId,
  jobActive,
  library,
  onStart,
  onClose,
  onNavigateToIssue,
}: ExportOptionsModalProps): React.JSX.Element {
  const work = useExportWork(library, chapter.workId);
  const [selection, setSelection] = React.useState(() =>
    createDefaultExportSelection(chapter.id, currentPageId),
  );
  const [omitText, setOmitText] = React.useState(false);
  const [outputFormat, setOutputFormat] =
    React.useState<PageImageExportFormat>("png");
  const chapterOrder = React.useMemo(
    () => work?.chapterOrder ?? [chapter.id],
    [chapter.id, work],
  );
  const exportSelection = React.useMemo(
    () => buildExportSelection(chapterOrder, selection),
    [chapterOrder, selection],
  );
  const preflight = useExportPreflight(
    work?.id ?? null,
    exportSelection,
    omitText,
    outputFormat,
  );
  const start = useExportStart({
    expectedTargets: preflight.result?.targets,
    exportSelection,
    omitText,
    outputFormat,
    onClose,
    onStart,
  });
  useCloseStartedExport(start.isStarting, jobActive, onClose);
  const startDisabled = resolveStartDisabled({
    exportSelection,
    jobActive,
    omitText,
    preflight,
    workAvailable: Boolean(work),
  });

  return (
    <ExportOptionsModalLayout
      chapter={chapter}
      omitText={omitText}
      onClose={onClose}
      onNavigateToIssue={onNavigateToIssue}
      outputFormat={outputFormat}
      preflight={preflight}
      selection={selection}
      setOmitText={setOmitText}
      setOutputFormat={setOutputFormat}
      setSelection={setSelection}
      start={start}
      startDisabled={startDisabled}
      work={work}
    />
  );
}

function ExportOptionsModalLayout({
  chapter,
  omitText,
  onClose,
  onNavigateToIssue,
  outputFormat,
  preflight,
  selection,
  setOmitText,
  setOutputFormat,
  setSelection,
  start,
  startDisabled,
  work,
}: {
  chapter: ChapterSnapshot;
  omitText: boolean;
  onClose: () => void;
  onNavigateToIssue?: ExportIssueNavigationHandler;
  outputFormat: PageImageExportFormat;
  preflight: ExportPreflightState;
  selection: ExportSelectionMap;
  setOmitText: React.Dispatch<React.SetStateAction<boolean>>;
  setOutputFormat: React.Dispatch<React.SetStateAction<PageImageExportFormat>>;
  setSelection: React.Dispatch<React.SetStateAction<ExportSelectionMap>>;
  start: ReturnType<typeof useExportStart>;
  startDisabled: boolean;
  work: LibraryIndex["works"][number] | null;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <Modal
      title={t("exportOptions.title")}
      size="lg"
      onClose={onClose}
      closeDisabled={start.isStarting}
      closeOnBackdrop
      footer={
        <ExportOptionsFooter
          isStarting={start.isStarting}
          startDisabled={startDisabled}
          onCancel={onClose}
          onStart={() => void start.run()}
          outputFormat={outputFormat}
        />
      }
    >
      <ExportOptionsContent
        chapter={chapter}
        isStarting={start.isStarting}
        omitText={omitText}
        outputFormat={outputFormat}
        onNavigateToIssue={onNavigateToIssue}
        preflight={preflight}
        selection={selection}
        setOmitText={setOmitText}
        setOutputFormat={setOutputFormat}
        setSelection={setSelection}
        work={work}
      />
      {start.failed ? (
        <p className="translate-options-hint" role="alert">
          {t("exportOptions.startFailed")}
        </p>
      ) : null}
    </Modal>
  );
}

function resolveStartDisabled({
  exportSelection,
  jobActive,
  omitText,
  preflight,
  workAvailable,
}: {
  exportSelection: ExportChapterSelection[];
  jobActive: boolean;
  omitText: boolean;
  preflight: ExportPreflightState;
  workAvailable: boolean;
}): boolean {
  if (!workAvailable || jobActive || exportSelection.length === 0) return true;
  if (preflight.status !== "ready") return true;
  return (
    omitText &&
    preflight.result.issues.some(
      (issue) => issue.code === "inpainted-image-missing",
    )
  );
}

function ExportOptionsContent({
  chapter,
  isStarting,
  omitText,
  outputFormat,
  onNavigateToIssue,
  preflight,
  selection,
  setOmitText,
  setOutputFormat,
  setSelection,
  work,
}: {
  chapter: ChapterSnapshot;
  isStarting: boolean;
  omitText: boolean;
  outputFormat: PageImageExportFormat;
  onNavigateToIssue?: ExportOptionsModalProps["onNavigateToIssue"];
  preflight: ExportPreflightState;
  selection: ExportSelectionMap;
  setOmitText: React.Dispatch<React.SetStateAction<boolean>>;
  setOutputFormat: React.Dispatch<React.SetStateAction<PageImageExportFormat>>;
  setSelection: React.Dispatch<React.SetStateAction<ExportSelectionMap>>;
  work: LibraryIndex["works"][number] | null;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  if (!work) {
    return (
      <p className="translate-options-hint">
        {t("exportOptions.workUnavailable")}
      </p>
    );
  }
  return (
    <div className="export-options-stack">
      <ExportPagePicker
        work={work}
        currentChapter={chapter}
        selection={selection}
        onChange={setSelection}
      />
      <ExportRenderOptions
        disabled={isStarting}
        omitText={omitText}
        outputFormat={outputFormat}
        onOmitTextChange={setOmitText}
        onOutputFormatChange={setOutputFormat}
      />
      <ExportPreflightPanel
        preflight={preflight}
        onNavigateToIssue={onNavigateToIssue}
      />
    </div>
  );
}

function useExportStart({
  expectedTargets,
  exportSelection,
  omitText,
  outputFormat,
  onClose,
  onStart,
}: {
  expectedTargets?: PageJobTargetSnapshot[];
  exportSelection: ExportChapterSelection[];
  omitText: boolean;
  outputFormat: PageImageExportFormat;
  onClose: () => void;
  onStart: ExportOptionsModalProps["onStart"];
}): { failed: boolean; isStarting: boolean; run: () => Promise<void> } {
  const [isStarting, setIsStarting] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const run = React.useCallback(async (): Promise<void> => {
    if (isStarting || exportSelection.length === 0) return;
    setIsStarting(true);
    setFailed(false);
    try {
      if (
        await onStart(exportSelection, expectedTargets, {
          omitText,
          ...(outputFormat === "psd" ? { outputFormat } : {}),
        })
      ) {
        onClose();
      }
    } catch (error: unknown) {
      console.error(error);
      setFailed(true);
    } finally {
      setIsStarting(false);
    }
  }, [
    expectedTargets,
    exportSelection,
    isStarting,
    omitText,
    outputFormat,
    onClose,
    onStart,
  ]);
  return { failed, isStarting, run };
}

function useExportPreflight(
  workId: string | null,
  selections: ExportChapterSelection[],
  omitText: boolean,
  outputFormat: PageImageExportFormat,
): ExportPreflightState {
  const [state, setState] = React.useState<ExportPreflightState>({
    status: "idle",
    result: null,
    error: null,
  });
  React.useEffect(() => {
    if (!workId || selections.length === 0) {
      setState({ status: "idle", result: null, error: null });
      return;
    }
    let active = true;
    setState({ status: "loading", result: null, error: null });
    void exportGateway
      .preflightPageImages({
        workId,
        selections,
        ...(omitText ? { omitText: true } : {}),
        ...(outputFormat === "psd" ? { outputFormat } : {}),
      })
      .then((result) => {
        if (active) setState({ status: "ready", result, error: null });
      })
      .catch((error: unknown) => {
        console.error(error);
        if (active) {
          setState({
            status: "error",
            result: null,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    return () => {
      active = false;
    };
  }, [omitText, outputFormat, selections, workId]);
  return state;
}

function useExportWork(library: LibraryIndex, workId: string) {
  return React.useMemo(
    () => library.works.find((item) => item.id === workId) ?? null,
    [library.works, workId],
  );
}

function useCloseStartedExport(
  isStarting: boolean,
  jobActive: boolean,
  onClose: () => void,
): void {
  React.useEffect(() => {
    if (isStarting && jobActive) onClose();
  }, [isStarting, jobActive, onClose]);
}
