import React from "react";
import { useTranslation } from "react-i18next";
import type {
  ChapterSnapshot,
  LibraryIndex,
} from "../../../shared/libraryTypes";
import type { InpaintingPostprocessOptions } from "../../../shared/inpaintingTypes";
import {
  buildAutoInpaintingSelection,
  createScopedAutoInpaintingSelection,
  type AutoInpaintingChapterSelection,
  type AutoInpaintingEntryScope,
} from "../lib/autoInpaintingSelection";
import { PageSelectionPicker } from "./ExportPagePicker";
import { Button } from "./ui/Button";
import { Modal } from "./ui/Modal";
import { ModalActionBar } from "./ui/ModalActionBar";
import { CheckboxField } from "./ui/CheckboxField";

export type AutoInpaintingOptionsModalProps = {
  chapter: ChapterSnapshot;
  currentPageId: string;
  initialScope: AutoInpaintingEntryScope;
  library: LibraryIndex;
  onStart: (
    selection: AutoInpaintingChapterSelection[],
    postprocess?: InpaintingPostprocessOptions,
  ) => void | Promise<void>;
  onClose: () => void;
};

export function AutoInpaintingOptionsModal({
  chapter,
  currentPageId,
  initialScope,
  library,
  onStart,
  onClose,
}: AutoInpaintingOptionsModalProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const state = useAutoInpaintingModalState({
    chapter,
    currentPageId,
    initialScope,
    library,
  });
  const [includeBubbleLayout, setIncludeBubbleLayout] = React.useState(true);
  const handleStart = (): void => {
    if (state.runSelection.length === 0) return;
    void onStart(state.runSelection, resolvePostprocess(includeBubbleLayout));
    onClose();
  };
  return (
    <Modal
      title={t("autoInpaintingOptions.title")}
      size={initialScope === "select" ? "lg" : "md"}
      onClose={onClose}
      fillHeight
      footer={
        <ModalActionBar
          actions={
            <>
              <Button onClick={onClose}>{t("common.cancel")}</Button>
              <Button
                variant="primary"
                onClick={handleStart}
                disabled={state.runSelection.length === 0}
              >
                {t("autoInpaintingOptions.start")}
              </Button>
            </>
          }
        />
      }
    >
      <AutoInpaintingScopeBody
        chapter={chapter}
        initialScope={initialScope}
        selection={state.selection}
        work={state.work}
        onSelectionChange={state.setSelection}
      />
      <BubblePostprocessToggle
        enabled={includeBubbleLayout}
        onToggle={() => setIncludeBubbleLayout((enabled) => !enabled)}
      />
    </Modal>
  );
}

function useAutoInpaintingModalState({
  chapter,
  currentPageId,
  initialScope,
  library,
}: Pick<
  AutoInpaintingOptionsModalProps,
  "chapter" | "currentPageId" | "initialScope" | "library"
>) {
  const work = React.useMemo(
    () => library.works.find((item) => item.id === chapter.workId) ?? null,
    [chapter.workId, library.works],
  );
  const [selection, setSelection] = React.useState(() =>
    createScopedAutoInpaintingSelection(
      chapter.id,
      currentPageId,
      initialScope,
    ),
  );
  const chapterOrder = React.useMemo(
    () => work?.chapterOrder ?? [chapter.id],
    [chapter.id, work],
  );
  const runSelection = React.useMemo(
    () => buildAutoInpaintingSelection(chapterOrder, selection),
    [chapterOrder, selection],
  );
  return { runSelection, selection, setSelection, work };
}

type AutoInpaintingScopeBodyProps = {
  chapter: ChapterSnapshot;
  initialScope: AutoInpaintingEntryScope;
  selection: ReturnType<typeof createScopedAutoInpaintingSelection>;
  work: LibraryIndex["works"][number] | null;
  onSelectionChange: React.Dispatch<
    React.SetStateAction<ReturnType<typeof createScopedAutoInpaintingSelection>>
  >;
};

function AutoInpaintingScopeBody({
  chapter,
  initialScope,
  selection,
  work,
  onSelectionChange,
}: AutoInpaintingScopeBodyProps): React.JSX.Element {
  const { t } = useTranslation("components");
  if (initialScope === "select" && work) {
    return (
      <PageSelectionPicker
        work={work}
        currentChapter={chapter}
        selection={selection}
        onChange={onSelectionChange}
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
    );
  }
  if (initialScope === "select") {
    return (
      <p className="translate-options-hint">
        {t("autoInpaintingOptions.workUnavailable")}
      </p>
    );
  }
  return (
    <p className="auto-inpainting-scope-summary">
      {initialScope === "current"
        ? t("autoInpaintingOptions.currentPageSummary")
        : t("autoInpaintingOptions.allPagesSummary", {
            count: chapter.pages.length,
          })}
    </p>
  );
}

function BubblePostprocessToggle({
  enabled,
  onToggle,
}: {
  enabled: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <CheckboxField
      variant="switch"
      className="auto-inpainting-postprocess-toggle"
      checked={enabled}
      label={
        <>
          <strong>{t("autoInpaintingOptions.bubbleLayout")}</strong>
          <small>{t("autoInpaintingOptions.bubbleLayoutHint")}</small>
        </>
      }
      onCheckedChange={onToggle}
    />
  );
}

function resolvePostprocess(
  includeBubbleLayout: boolean,
): InpaintingPostprocessOptions {
  return includeBubbleLayout
    ? {
        bubbleLayout: {
          enabled: true,
          policy: "balanced",
        },
      }
    : {
        bubbleLayout: {
          enabled: false,
          policy: "balanced",
        },
      };
}
