import React from "react";
import type { LibraryIndex, WorkShareExportRequest } from "../../../shared/types";
import { Button, Modal } from "./ui";

type ShareExportModalProps = {
  library: LibraryIndex;
  currentWorkId: string | null;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (request: WorkShareExportRequest) => void;
};

export function ShareExportModal({ library, currentWorkId, busy, onCancel, onSubmit }: ShareExportModalProps): React.JSX.Element {
  const initialWorkId = currentWorkId && library.works.some((work) => work.id === currentWorkId) ? currentWorkId : library.works[0]?.id ?? "";
  const [workId, setWorkId] = React.useState(initialWorkId);
  const selectedWork = library.works.find((work) => work.id === workId) ?? null;
  const [selectedChapterIds, setSelectedChapterIds] = React.useState<Set<string>>(
    () => new Set(selectedWork?.chapters.map((chapter) => chapter.id) ?? [])
  );

  React.useEffect(() => {
    setSelectedChapterIds(new Set(selectedWork?.chapters.map((chapter) => chapter.id) ?? []));
  }, [selectedWork?.id]);

  const selectedCount = selectedChapterIds.size;
  const pageCount =
    selectedWork?.chapters.reduce((sum, chapter) => (selectedChapterIds.has(chapter.id) ? sum + chapter.pageCount : sum), 0) ?? 0;

  return (
    <Modal
      ariaLabel="공유하기"
      title="공유하기"
      onClose={onCancel}
      closeDisabled={busy}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            취소
          </Button>
          <Button
            variant="primary"
            disabled={busy || !selectedWork || selectedChapterIds.size === 0}
            onClick={() => {
              if (!selectedWork) {
                return;
              }
              onSubmit({
                workId: selectedWork.id,
                chapterIds: selectedWork.chapters.map((chapter) => chapter.id).filter((chapterId) => selectedChapterIds.has(chapterId))
              });
            }}
          >
            공유 파일 저장
          </Button>
        </>
      }
    >
        <section className="modal-section">
          <label>
            작품
            <select value={workId} disabled={busy || library.works.length === 0} onChange={(event) => setWorkId(event.target.value)}>
              {library.works.map((work) => (
                <option key={work.id} value={work.id}>
                  {work.title}
                </option>
              ))}
            </select>
          </label>
        </section>

        <section className="modal-section">
          <div className="modal-subheader">
            <h3>공유할 화</h3>
            <div className="inline-actions">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSelectedChapterIds(new Set(selectedWork?.chapters.map((chapter) => chapter.id) ?? []))}
                disabled={busy || !selectedWork}
              >
                전체 선택
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setSelectedChapterIds(new Set())} disabled={busy || !selectedWork}>
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
                    setSelectedChapterIds((current) => {
                      const next = new Set(current);
                      if (event.target.checked) {
                        next.add(chapter.id);
                      } else {
                        next.delete(chapter.id);
                      }
                      return next;
                    });
                  }}
                />
                <span>{chapter.title}</span>
                <small>{chapter.pageCount}페이지</small>
              </label>
            )) ?? <p className="panel-empty">공유할 작품이 없습니다.</p>}
          </div>
        </section>

        <div className="modal-summary-line">
          {selectedCount}개 화, {pageCount}페이지
        </div>
    </Modal>
  );
}
