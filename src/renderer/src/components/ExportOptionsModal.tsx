import React from "react";
import { useTranslation } from "react-i18next";
import type {
  ChapterSnapshot,
  LibraryIndex,
} from "../../../shared/libraryTypes";
import type { PageJobTargetSnapshot } from "../../../shared/pageRevision";
import {
  buildExportSelection,
  createDefaultExportSelection,
  type ExportChapterSelection,
  type ExportSelectionMap,
} from "../lib/exportSelection";
import type {
  ManualPsdExportOptions,
  ManualRasterExportOptions,
} from "../hooks/useExportPageImagesAction";
import { exportGateway } from "../api/exportGateway";
import { ExportPagePicker } from "./ExportPagePicker";
import {
  ExportOptionsFooter,
  ExportRenderOptions,
  type ExportModalKind,
} from "./ExportRenderOptions";
import {
  ExportPreflightPanel,
  type ExportIssueNavigationHandler,
  type ExportPreflightState,
} from "./ExportPreflightPanel";
import { Modal } from "./ui/Modal";

export type ExportOptionsModalProps = {
  chapter: ChapterSnapshot;
  currentPageId: string;
  jobActive: boolean;
  kind?: ExportModalKind;
  library: LibraryIndex;
  onStart: (
    selection: ExportChapterSelection[],
    expectedTargets?: PageJobTargetSnapshot[],
    options?: ManualRasterExportOptions | ManualPsdExportOptions,
  ) => Promise<boolean>;
  onNavigateToIssue?: ExportIssueNavigationHandler;
  onClose: () => void;
};

const DEFAULT_RASTER_OPTIONS: ManualRasterExportOptions = {
  outputFormat: "source",
  jpegQuality: 95,
  webpQuality: 90,
  preserveSourceNames: true,
  destinationMode: "timestamped",
  collisionPolicy: "replace",
};

const DEFAULT_PSD_OPTIONS: ManualPsdExportOptions = {
  collisionPolicy: "replace",
};

// eslint-disable-next-line max-lines-per-function -- modal state, preflight, and start locking form one export submission lifecycle
export function ExportOptionsModal({
  chapter,
  currentPageId,
  jobActive,
  kind = "raster",
  library,
  onStart,
  onClose,
  onNavigateToIssue,
}: ExportOptionsModalProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const work = useExportWork(library, chapter.workId);
  const [selection, setSelection] = React.useState(() =>
    createDefaultExportSelection(chapter.id, currentPageId),
  );
  const [options, setOptions] = React.useState<
    ManualRasterExportOptions | ManualPsdExportOptions
  >(() => (kind === "psd" ? DEFAULT_PSD_OPTIONS : DEFAULT_RASTER_OPTIONS));
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
    kind,
    options,
  );
  const start = useExportStart({
    expectedTargets: preflight.result?.targets,
    exportSelection,
    options,
    onClose,
    onStart,
  });
  useCloseStartedExport(start.isStarting, jobActive, onClose);
  const startDisabled = resolveStartDisabled({
    exportSelection,
    jobActive,
    omitText: options.omitText === true,
    preflight,
    workAvailable: Boolean(work),
  });

  return (
    <Modal
      title={t(
        kind === "psd" ? "exportOptions.titlePsd" : "exportOptions.title",
      )}
      size="lg"
      onClose={onClose}
      closeDisabled={start.isStarting}
      closeOnBackdrop
      footer={
        <ExportOptionsFooter
          isStarting={start.isStarting}
          kind={kind}
          startDisabled={startDisabled}
          onCancel={onClose}
          onStart={() => void start.run()}
        />
      }
    >
      <ExportOptionsContent
        chapter={chapter}
        isStarting={start.isStarting}
        kind={kind}
        onNavigateToIssue={onNavigateToIssue}
        options={options}
        preflight={preflight}
        selection={selection}
        setOptions={setOptions}
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

function ExportOptionsContent({
  chapter,
  isStarting,
  kind,
  onNavigateToIssue,
  options,
  preflight,
  selection,
  setOptions,
  setSelection,
  work,
}: {
  chapter: ChapterSnapshot;
  isStarting: boolean;
  kind: ExportModalKind;
  onNavigateToIssue?: ExportOptionsModalProps["onNavigateToIssue"];
  options: ManualRasterExportOptions | ManualPsdExportOptions;
  preflight: ExportPreflightState;
  selection: ExportSelectionMap;
  setOptions: React.Dispatch<
    React.SetStateAction<ManualRasterExportOptions | ManualPsdExportOptions>
  >;
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
        kind={kind}
        options={options}
        onChange={setOptions}
      />
      <ExportPreflightPanel
        preflight={preflight}
        onNavigateToIssue={onNavigateToIssue}
      />
    </div>
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

function useExportStart({
  expectedTargets,
  exportSelection,
  options,
  onClose,
  onStart,
}: {
  expectedTargets?: PageJobTargetSnapshot[];
  exportSelection: ExportChapterSelection[];
  options: ManualRasterExportOptions | ManualPsdExportOptions;
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
      if (await onStart(exportSelection, expectedTargets, options)) onClose();
    } catch (error: unknown) {
      console.error(error);
      setFailed(true);
    } finally {
      setIsStarting(false);
    }
  }, [expectedTargets, exportSelection, isStarting, onClose, onStart, options]);
  return { failed, isStarting, run };
}

function useExportPreflight(
  workId: string | null,
  selections: ExportChapterSelection[],
  kind: ExportModalKind,
  options: ManualRasterExportOptions | ManualPsdExportOptions,
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
    const request =
      kind === "psd"
        ? {
            workId,
            selections,
            outputFormat: "psd" as const,
            ...(options.omitText ? { omitText: true } : {}),
          }
        : {
            workId,
            selections,
            ...(options as ManualRasterExportOptions),
          };
    void exportGateway
      .preflightPageImages(request)
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
  }, [kind, options, selections, workId]);
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
