import React from "react";
import { useTranslation } from "react-i18next";
import type {
  ChapterSnapshot,
  LibraryIndex,
} from "../../../shared/libraryTypes";
import {
  buildAutoInpaintingSelection,
  createDefaultAutoInpaintingSelection,
  type AutoInpaintingChapterSelection,
} from "../lib/autoInpaintingSelection";
import { PageSelectionPicker } from "./ExportPagePicker";
import { Button, Modal } from "./ui";

export type AutoInpaintingOptionsModalProps = {
  chapter: ChapterSnapshot;
  currentPageId: string;
  library: LibraryIndex;
  onStart: (
    selection: AutoInpaintingChapterSelection[],
  ) => void | Promise<void>;
  onClose: () => void;
};

export function AutoInpaintingOptionsModal({
  chapter,
  currentPageId,
  library,
  onStart,
  onClose,
}: AutoInpaintingOptionsModalProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const work = React.useMemo(
    () => library.works.find((item) => item.id === chapter.workId) ?? null,
    [chapter.workId, library.works],
  );
  const [selection, setSelection] = React.useState(() =>
    createDefaultAutoInpaintingSelection(chapter.id, currentPageId),
  );
  const chapterOrder = React.useMemo(
    () => work?.chapterOrder ?? [chapter.id],
    [chapter.id, work],
  );
  const runSelection = React.useMemo(
    () => buildAutoInpaintingSelection(chapterOrder, selection),
    [chapterOrder, selection],
  );

  const handleStart = (): void => {
    if (runSelection.length === 0) {
      return;
    }
    void onStart(runSelection);
    onClose();
  };

  return (
    <Modal
      title={t("autoInpaintingOptions.title")}
      size="lg"
      onClose={onClose}
      closeOnBackdrop
      footer={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button
            variant="primary"
            onClick={handleStart}
            disabled={runSelection.length === 0}
          >
            {t("autoInpaintingOptions.start")}
          </Button>
        </>
      }
    >
      {work ? (
        <PageSelectionPicker
          work={work}
          currentChapter={chapter}
          selection={selection}
          onChange={setSelection}
          copy={{
            prompt: t("autoInpaintingOptions.prompt"),
            currentChapter: t("autoInpaintingOptions.currentChapter"),
            chapterSummary: (count) =>
              t("autoInpaintingOptions.chapterSummary", { count }),
            noSelectedPages: t("autoInpaintingOptions.noSelectedPages"),
            selectionSummary: (chapterCount, pageCount) =>
              t("autoInpaintingOptions.selectionSummary", {
                chapterCount,
                pageCount,
              }),
          }}
        />
      ) : (
        <p className="translate-options-hint">
          {t("autoInpaintingOptions.workUnavailable")}
        </p>
      )}
    </Modal>
  );
}
