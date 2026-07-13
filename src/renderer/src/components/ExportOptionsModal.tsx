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
} from "../lib/exportSelection";
import { ExportPagePicker } from "./ExportPagePicker";
import { Button, Modal } from "./ui";

export type ExportOptionsModalProps = {
  chapter: ChapterSnapshot;
  currentPageId: string;
  jobActive: boolean;
  library: LibraryIndex;
  /** Return false when the native folder chooser is cancelled. */
  onStart: (selection: ExportChapterSelection[]) => Promise<boolean>;
  onClose: () => void;
};

export function ExportOptionsModal({
  chapter,
  currentPageId,
  jobActive,
  library,
  onStart,
  onClose,
}: ExportOptionsModalProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const work = useExportWork(library, chapter.workId);
  const [selection, setSelection] = React.useState(() =>
    createDefaultExportSelection(chapter.id, currentPageId),
  );
  const [isStarting, setIsStarting] = React.useState(false);
  const [startFailed, setStartFailed] = React.useState(false);
  const chapterOrder = React.useMemo(
    () => work?.chapterOrder ?? [chapter.id],
    [chapter.id, work],
  );
  const exportSelection = React.useMemo(
    () => buildExportSelection(chapterOrder, selection),
    [chapterOrder, selection],
  );
  useCloseStartedExport(isStarting, jobActive, onClose);

  const handleStart = async (): Promise<void> => {
    if (isStarting || exportSelection.length === 0) {
      return;
    }
    setIsStarting(true);
    setStartFailed(false);
    try {
      const started = await onStart(exportSelection);
      if (started) {
        onClose();
      }
    } catch (error: unknown) {
      console.error(error);
      setStartFailed(true);
    } finally {
      setIsStarting(false);
    }
  };

  return (
    <Modal
      title={t("exportOptions.title")}
      size="lg"
      onClose={onClose}
      closeDisabled={isStarting}
      closeOnBackdrop
      footer={
        <ExportOptionsFooter
          isStarting={isStarting}
          startDisabled={!work || jobActive || exportSelection.length === 0}
          onCancel={onClose}
          onStart={() => void handleStart()}
        />
      }
    >
      {work ? (
        <ExportPagePicker
          work={work}
          currentChapter={chapter}
          selection={selection}
          onChange={setSelection}
        />
      ) : (
        <p className="translate-options-hint">
          {t("exportOptions.workUnavailable")}
        </p>
      )}
      {startFailed ? (
        <p className="translate-options-hint" role="alert">
          {t("exportOptions.startFailed")}
        </p>
      ) : null}
    </Modal>
  );
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

function ExportOptionsFooter({
  isStarting,
  startDisabled,
  onCancel,
  onStart,
}: {
  isStarting: boolean;
  startDisabled: boolean;
  onCancel: () => void;
  onStart: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <>
      <Button onClick={onCancel} disabled={isStarting}>
        {t("common.cancel")}
      </Button>
      <Button
        variant="primary"
        onClick={onStart}
        disabled={isStarting || startDisabled}
      >
        {isStarting ? t("exportOptions.starting") : t("exportOptions.start")}
      </Button>
    </>
  );
}
