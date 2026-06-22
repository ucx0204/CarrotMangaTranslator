import React from "react";
import type {
  LibraryIndex,
  LibraryWorkSummary,
} from "../../../shared/libraryTypes";
import type { WorkShareExportRequest } from "../../../shared/shareTypes";
import { Button, Modal } from "./ui";

type ShareExportModalProps = {
  library: LibraryIndex;
  currentWorkId: string | null;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (request: WorkShareExportRequest) => void;
};

export function ShareExportModal({
  library,
  currentWorkId,
  busy,
  onCancel,
  onSubmit,
}: ShareExportModalProps): React.JSX.Element {
  const initialWorkId = resolveInitialShareWorkId(library, currentWorkId);
  const [workId, setWorkId] = React.useState(initialWorkId);
  const selectedWork = React.useMemo(
    () => library.works.find((work) => work.id === workId) ?? null,
    [library.works, workId],
  );
  const [selectedChapterIds, setSelectedChapterIds] = React.useState<
    Set<string>
  >(() => new Set(selectedWork?.chapters.map((chapter) => chapter.id) ?? []));

  React.useEffect(() => {
    setSelectedChapterIds(createAllChapterSelection(selectedWork));
  }, [selectedWork]);

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
      ariaLabel="공유하기"
      title="공유하기"
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
        <strong>{selectedCount}</strong>개 화 · <strong>{pageCount}</strong>
        페이지
      </div>
    </Modal>
  );
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
  return (
    <>
      <Button variant="ghost" onClick={onCancel} disabled={busy}>
        취소
      </Button>
      <Button
        variant="primary"
        disabled={busy || !selectedWork || selectedChapterCount === 0}
        onClick={onSubmit}
      >
        공유 파일 저장
      </Button>
    </>
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
  return (
    <section className="modal-section share-target-section">
      <label>
        공유 대상 작품
        <select
          value={workId}
          disabled={busy || library.works.length === 0}
          onChange={(event) => setWorkId(event.target.value)}
        >
          {library.works.map((work) => (
            <option key={work.id} value={work.id}>
              {work.title}
            </option>
          ))}
        </select>
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
  return (
    <section className="modal-section">
      <div className="modal-subheader">
        <h3>공유할 화</h3>
        <div className="inline-actions">
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              setSelectedChapterIds(createAllChapterSelection(selectedWork))
            }
            disabled={busy || !selectedWork}
          >
            전체 선택
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSelectedChapterIds(new Set())}
            disabled={busy || !selectedWork}
          >
            전체 해제
          </Button>
        </div>
      </div>

      <div className="draft-list">
        {selectedWork?.chapters.map((chapter) => (
          <label key={chapter.id} className="share-check-item">
            <input
              type="checkbox"
              checked={selectedChapterIds.has(chapter.id)}
              disabled={busy}
              onChange={(event) => {
                setSelectedChapterIds((current) =>
                  toggleChapterSelection(
                    current,
                    chapter.id,
                    event.target.checked,
                  ),
                );
              }}
            />
            <span>{chapter.title}</span>
            <small>{chapter.pageCount}페이지</small>
          </label>
        )) ?? <p className="panel-empty">공유할 작품이 없습니다.</p>}
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
