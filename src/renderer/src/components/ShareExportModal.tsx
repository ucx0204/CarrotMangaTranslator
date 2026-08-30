import React from "react";
import { useTranslation } from "react-i18next";
import type {
  LibraryIndex,
  LibraryWorkSummary,
} from "../../../shared/libraryTypes";
import type { WorkShareExportRequest } from "../../../shared/shareTypes";
import { Button } from "./ui/Button";
import { Modal } from "./ui/Modal";
import { ModalActionBar } from "./ui/ModalActionBar";
import { SelectionCard } from "./ui/SelectionCard";
import { WorkSelect } from "./WorkSelect";

type ShareExportModalProps = {
  library: LibraryIndex;
  currentWorkId: string | null;
  initialRequest?: WorkShareExportRequest | null;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (request: WorkShareExportRequest) => void;
};

export function ShareExportModal({
  library,
  currentWorkId,
  initialRequest = null,
  busy,
  onCancel,
  onSubmit,
}: ShareExportModalProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const selection = useShareExportSelection(
    library,
    currentWorkId,
    initialRequest,
  );
  const {
    selectedChapterIds,
    selectedWork,
    setSelectedChapterIds,
    setWorkId,
    workId,
  } = selection;

  const selectedCount = selectedChapterIds.size;
  const pageCount = countSelectedPages(selectedWork, selectedChapterIds);
  const submitExport = (): void => {
    if (!selectedWork) {
      return;
    }
    onSubmit({
      workId: selectedWork.id,
      chapterIds: selectedWork.chapters
        .map((chapter) => chapter.id)
        .filter((chapterId) => selectedChapterIds.has(chapterId)),
    });
  };

  return (
    <Modal
      title={t("shareExport.title")}
      onClose={onCancel}
      closeDisabled={busy}
      footer={
        <ShareExportFooter
          busy={busy}
          onCancel={onCancel}
          onSubmit={submitExport}
          selectedChapterCount={selectedChapterIds.size}
          selectedWork={selectedWork}
        />
      }
    >
      <ShareExportWorkSection
        busy={busy}
        library={library}
        setWorkId={setWorkId}
        workId={workId}
      />

      <ShareExportChapterSection
        busy={busy}
        selectedChapterIds={selectedChapterIds}
        selectedWork={selectedWork}
        setSelectedChapterIds={setSelectedChapterIds}
      />

      <div className="modal-summary-line">
        {t("shareExport.summary", {
          chapterCount: selectedCount,
          pageCount,
        })}
      </div>
    </Modal>
  );
}

function useShareExportSelection(
  library: LibraryIndex,
  currentWorkId: string | null,
  initialRequest: WorkShareExportRequest | null,
) {
  const initialWorkId = resolveInitialShareWorkId(
    library,
    initialRequest?.workId ?? currentWorkId,
  );
  const [workId, setWorkId] = React.useState(initialWorkId);
  const selectedWork = React.useMemo(
    () => library.works.find((work) => work.id === workId) ?? null,
    [library.works, workId],
  );
  const [selectedChapterIds, setSelectedChapterIds] = React.useState<
    Set<string>
  >(
    () =>
      new Set(
        initialRequest?.workId === initialWorkId
          ? initialRequest.chapterIds
          : (selectedWork?.chapters.map((chapter) => chapter.id) ?? []),
      ),
  );
  const initialSelectionRef = React.useRef(Boolean(initialRequest));
  React.useEffect(() => {
    if (initialSelectionRef.current) {
      initialSelectionRef.current = false;
      return;
    }
    setSelectedChapterIds(createAllChapterSelection(selectedWork));
  }, [selectedWork]);
  return {
    selectedChapterIds,
    selectedWork,
    setSelectedChapterIds,
    setWorkId,
    workId,
  };
}

function ShareExportFooter({
  busy,
  onCancel,
  onSubmit,
  selectedChapterCount,
  selectedWork,
}: {
  busy: boolean;
  onCancel: () => void;
  onSubmit: () => void;
  selectedChapterCount: number;
  selectedWork: LibraryWorkSummary | null;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <ModalActionBar
      actions={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={busy || !selectedWork || selectedChapterCount === 0}
            onClick={onSubmit}
          >
            {t("shareExport.saveFile")}
          </Button>
        </>
      }
    />
  );
}

function ShareExportWorkSection({
  busy,
  library,
  setWorkId,
  workId,
}: {
  busy: boolean;
  library: LibraryIndex;
  setWorkId: React.Dispatch<React.SetStateAction<string>>;
  workId: string;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <section className="modal-section share-target-section">
      <label>
        {t("shareExport.targetWork")}
        <WorkSelect
          ariaLabel={t("shareExport.targetWork")}
          library={library}
          value={workId}
          disabled={busy || library.works.length === 0}
          onValueChange={setWorkId}
        />
      </label>
    </section>
  );
}

function resolveInitialShareWorkId(
  library: LibraryIndex,
  currentWorkId: string | null,
): string {
  return currentWorkId &&
    library.works.some((work) => work.id === currentWorkId)
    ? currentWorkId
    : (library.works[0]?.id ?? "");
}

function createAllChapterSelection(
  work: LibraryWorkSummary | null,
): Set<string> {
  return new Set(work?.chapters.map((chapter) => chapter.id) ?? []);
}

function countSelectedPages(
  work: LibraryWorkSummary | null,
  selectedChapterIds: Set<string>,
): number {
  return (
    work?.chapters.reduce(
      (sum, chapter) =>
        selectedChapterIds.has(chapter.id) ? sum + chapter.pageCount : sum,
      0,
    ) ?? 0
  );
}

function ShareExportChapterSection({
  busy,
  selectedChapterIds,
  selectedWork,
  setSelectedChapterIds,
}: {
  busy: boolean;
  selectedChapterIds: Set<string>;
  selectedWork: LibraryWorkSummary | null;
  setSelectedChapterIds: React.Dispatch<React.SetStateAction<Set<string>>>;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <section className="modal-section">
      <div className="modal-subheader">
        <h3>{t("shareExport.chapters")}</h3>
        <div className="inline-actions">
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              setSelectedChapterIds(createAllChapterSelection(selectedWork))
            }
            disabled={busy || !selectedWork}
          >
            {t("common.selectAll")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSelectedChapterIds(new Set())}
            disabled={busy || !selectedWork}
          >
            {t("common.clearAll")}
          </Button>
        </div>
      </div>

      <div className="draft-list">
        {selectedWork?.chapters.map((chapter) => (
          <SelectionCard
            key={chapter.id}
            className="share-check-item"
            variant="row"
            inputType="checkbox"
            checked={selectedChapterIds.has(chapter.id)}
            disabled={busy}
            onChange={(checked) => {
              setSelectedChapterIds((current) =>
                toggleChapterSelection(current, chapter.id, checked),
              );
            }}
          >
            <span>{chapter.title}</span>
            <small>{t("common.pageCount", { count: chapter.pageCount })}</small>
          </SelectionCard>
        )) ?? <p className="panel-empty">{t("shareExport.noWork")}</p>}
      </div>
    </section>
  );
}

function toggleChapterSelection(
  current: Set<string>,
  chapterId: string,
  selected: boolean,
): Set<string> {
  const next = new Set(current);
  if (selected) {
    next.add(chapterId);
  } else {
    next.delete(chapterId);
  }
  return next;
}
