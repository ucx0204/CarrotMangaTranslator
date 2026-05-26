import React from "react";
import { closestCenter, DndContext, DragOverlay, useDraggable, useDroppable, type DragEndEvent, type DragStartEvent } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type {
  LibraryIndex,
  LibraryWorkSummary,
  WorkShareImportEntry,
  WorkShareImportPreview,
  WorkShareImportRequest,
  WorkSharePreviewChapter
} from "../../../shared/types";
import { insertItemAt, moveItemById, useStandardDndSensors } from "../lib/dnd";

type LeftItem =
  | {
      key: string;
      source: "existing";
      chapterId: string;
      title: string;
      pageCount: number;
    }
  | {
      key: string;
      source: "package";
      packageChapterId: string;
      title: string;
      pageCount: number;
    };

export type ShareImportModalSubmit = {
  target: WorkShareImportRequest["target"];
  entries: WorkShareImportEntry[];
  remainingPackageChapters: WorkSharePreviewChapter[];
  deletedExistingChapters: Array<{ id: string; title: string }>;
};

type ShareImportModalProps = {
  library: LibraryIndex;
  preview: WorkShareImportPreview;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (payload: ShareImportModalSubmit) => void;
};

type ActiveDrag =
  | {
      type: "left";
      item: LeftItem;
    }
  | {
      type: "candidate";
      chapter: WorkSharePreviewChapter;
    };

const LEFT_DROPZONE_ID = "share-left-dropzone";
const CANDIDATE_PREFIX = "candidate:";

export function ShareImportModal({ library, preview, busy, onCancel, onSubmit }: ShareImportModalProps): React.JSX.Element {
  const sensors = useStandardDndSensors();
  const [targetMode, setTargetMode] = React.useState<"new" | "existing">("new");
  const [newWorkTitle, setNewWorkTitle] = React.useState(preview.workTitle);
  const [existingWorkId, setExistingWorkId] = React.useState(library.works[0]?.id ?? "");
  const selectedWork = library.works.find((work) => work.id === existingWorkId) ?? null;
  const [newSelections, setNewSelections] = React.useState(
    preview.chapters.map((chapter) => ({
      packageChapterId: chapter.packageChapterId,
      title: chapter.title,
      enabled: true
    }))
  );
  const [leftItems, setLeftItems] = React.useState<LeftItem[]>(() => buildExistingItems(selectedWork));
  const [activeDrag, setActiveDrag] = React.useState<ActiveDrag | null>(null);

  React.useEffect(() => {
    if (targetMode === "existing") {
      setLeftItems(buildExistingItems(selectedWork));
    }
  }, [existingWorkId, selectedWork?.id, targetMode]);

  const availablePackageChapters = React.useMemo(
    () => preview.chapters.filter((chapter) => !leftItems.some((item) => item.source === "package" && item.packageChapterId === chapter.packageChapterId)),
    [leftItems, preview.chapters]
  );

  const deletedExistingChapters = React.useMemo(
    () =>
      selectedWork?.chapters
        .filter((chapter) => !leftItems.some((item) => item.source === "existing" && item.chapterId === chapter.id))
        .map((chapter) => ({ id: chapter.id, title: chapter.title })) ?? [],
    [leftItems, selectedWork?.chapters]
  );

  const appendPackageChapter = React.useCallback(
    (packageChapterId: string) => {
      setLeftItems((current) => {
        const chapter = preview.chapters.find((candidate) => candidate.packageChapterId === packageChapterId);
        if (!chapter || current.some((item) => item.source === "package" && item.packageChapterId === packageChapterId)) {
          return current;
        }
        return [...current, toLeftPackageItem(chapter)];
      });
    },
    [preview.chapters]
  );

  const appendAllPackageChapters = React.useCallback(() => {
    setLeftItems((current) => [
      ...current,
      ...preview.chapters
        .filter((chapter) => !current.some((item) => item.source === "package" && item.packageChapterId === chapter.packageChapterId))
        .map(toLeftPackageItem)
    ]);
  }, [preview.chapters]);

  const onDragStart = React.useCallback(
    (event: DragStartEvent) => {
      const id = String(event.active.id);
      if (id.startsWith(CANDIDATE_PREFIX)) {
        const packageChapterId = id.slice(CANDIDATE_PREFIX.length);
        const chapter = preview.chapters.find((candidate) => candidate.packageChapterId === packageChapterId);
        if (chapter) {
          setActiveDrag({ type: "candidate", chapter });
        }
        return;
      }
      const item = leftItems.find((candidate) => candidate.key === id);
      if (item) {
        setActiveDrag({ type: "left", item });
      }
    },
    [leftItems, preview.chapters]
  );

  const onDragEnd = React.useCallback(
    (event: DragEndEvent) => {
      const activeId = String(event.active.id);
      const overId = event.over ? String(event.over.id) : null;
      const activeType = event.active.data.current?.type;
      setActiveDrag(null);
      if (!overId || busy) {
        return;
      }

      if (activeType === "left") {
        if (overId === LEFT_DROPZONE_ID || overId.startsWith(CANDIDATE_PREFIX)) {
          return;
        }
        setLeftItems((current) => moveItemById(current, activeId, overId, (item) => item.key));
        return;
      }

      if (activeType === "candidate") {
        if (overId.startsWith(CANDIDATE_PREFIX)) {
          return;
        }
        const packageChapterId = event.active.data.current?.packageChapterId;
        if (typeof packageChapterId !== "string") {
          return;
        }
        setLeftItems((current) => {
          const chapter = preview.chapters.find((candidate) => candidate.packageChapterId === packageChapterId);
          if (!chapter || current.some((item) => item.source === "package" && item.packageChapterId === packageChapterId)) {
            return current;
          }
          const overIndex = overId === LEFT_DROPZONE_ID ? current.length : current.findIndex((item) => item.key === overId);
          return insertItemAt(current, toLeftPackageItem(chapter), overIndex < 0 ? current.length : overIndex);
        });
      }
    },
    [busy, preview.chapters]
  );

  return (
    <div className="modal-backdrop">
      <div className="modal-card share-import-modal">
        <div className="modal-header">
          <h2>가져오기</h2>
          <button className="ghost-button" onClick={onCancel} disabled={busy}>
            닫기
          </button>
        </div>

        <section className="modal-section share-target-section">
          <div className="share-package-title">
            <strong>{preview.workTitle}</strong>
            <span>{preview.chapters.length}개 화</span>
          </div>
          <div className="share-target-grid">
            <label className={`share-target-card ${targetMode === "new" ? "active" : ""}`}>
              <input type="radio" checked={targetMode === "new"} disabled={busy} onChange={() => setTargetMode("new")} />
              <span>새 작품 만들기</span>
            </label>
            <label className={`share-target-card ${targetMode === "existing" ? "active" : ""}`}>
              <input
                type="radio"
                checked={targetMode === "existing"}
                disabled={busy || library.works.length === 0}
                onChange={() => setTargetMode("existing")}
              />
              <span>기존 작품에 적용</span>
            </label>
          </div>
          {targetMode === "new" ? (
            <label>
              새 작품 제목
              <input value={newWorkTitle} disabled={busy} onChange={(event) => setNewWorkTitle(event.target.value)} />
            </label>
          ) : (
            <label>
              기존 작품
              <select value={existingWorkId} disabled={busy || library.works.length === 0} onChange={(event) => setExistingWorkId(event.target.value)}>
                {library.works.map((work) => (
                  <option key={work.id} value={work.id}>
                    {work.title}
                  </option>
                ))}
              </select>
            </label>
          )}
        </section>

        {targetMode === "new" ? (
          <section className="modal-section">
            <div className="modal-subheader">
              <h3>가져올 화</h3>
              <div className="inline-actions">
                <button className="ghost-button" onClick={() => setNewSelections((current) => current.map((item) => ({ ...item, enabled: true })))} disabled={busy}>
                  전체 선택
                </button>
                <button className="ghost-button" onClick={() => setNewSelections((current) => current.map((item) => ({ ...item, enabled: false })))} disabled={busy}>
                  전체 해제
                </button>
              </div>
            </div>
            <div className="draft-list">
              {preview.chapters.map((chapter) => {
                const selection = newSelections.find((item) => item.packageChapterId === chapter.packageChapterId)!;
                return (
                  <div key={chapter.packageChapterId} className="draft-item">
                    <label className="checkbox-row">
                      <input
                        type="checkbox"
                        checked={selection.enabled}
                        disabled={busy}
                        onChange={(event) => {
                          setNewSelections((current) =>
                            current.map((item) =>
                              item.packageChapterId === chapter.packageChapterId ? { ...item, enabled: event.target.checked } : item
                            )
                          );
                        }}
                      />
                      <span>{chapter.pageCount}페이지</span>
                    </label>
                    <input
                      value={selection.title}
                      disabled={busy || !selection.enabled}
                      onChange={(event) => {
                        const title = event.target.value;
                        setNewSelections((current) =>
                          current.map((item) => (item.packageChapterId === chapter.packageChapterId ? { ...item, title } : item))
                        );
                      }}
                    />
                  </div>
                );
              })}
            </div>
          </section>
        ) : (
          <section className="modal-section">
            <div className="share-merge-toolbar">
              <div className="share-stat-row">
                <span>최종 {leftItems.length}개</span>
                <span className={deletedExistingChapters.length ? "danger-stat" : ""}>삭제 예정 {deletedExistingChapters.length}개</span>
                <span>남은 후보 {availablePackageChapters.length}개</span>
              </div>
              <button className="ghost-button" onClick={appendAllPackageChapters} disabled={busy || availablePackageChapters.length === 0}>
                모두 추가
              </button>
            </div>

            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={onDragStart} onDragCancel={() => setActiveDrag(null)} onDragEnd={onDragEnd}>
              <div className="share-merge-grid">
                <ShareFinalPane items={leftItems} busy={busy} activeDrag={activeDrag} setLeftItems={setLeftItems} />

                <div className="share-pane candidate-pane">
                  <div className="share-pane-header">
                    <strong>공유 파일 후보</strong>
                    <span>{availablePackageChapters.length}개 남음</span>
                  </div>
                  <div className="share-item-list candidate-list">
                    {availablePackageChapters.map((chapter) => (
                      <CandidateChapterCard key={chapter.packageChapterId} chapter={chapter} busy={busy} onAdd={() => appendPackageChapter(chapter.packageChapterId)} />
                    ))}
                    {availablePackageChapters.length === 0 ? <p className="panel-empty">모든 공유 화가 최종 목록에 있습니다.</p> : null}
                  </div>
                </div>
              </div>
              <DragOverlay>
                {activeDrag ? (
                  activeDrag.type === "left" ? (
                    <FinalChapterPreview item={activeDrag.item} index={Math.max(0, leftItems.findIndex((item) => item.key === activeDrag.item.key)) + 1} />
                  ) : (
                    <CandidatePreview chapter={activeDrag.chapter} />
                  )
                ) : null}
              </DragOverlay>
            </DndContext>

            {deletedExistingChapters.length > 0 ? (
              <div className="share-warning-strip">삭제 예정: {deletedExistingChapters.map((chapter) => chapter.title).join(", ")}</div>
            ) : null}
          </section>
        )}

        <div className="modal-actions">
          <button onClick={onCancel} disabled={busy}>
            취소
          </button>
          <button className="primary" disabled={busy || !canSubmit()} onClick={() => onSubmit(buildSubmitPayload())}>
            가져오기 적용
          </button>
        </div>
      </div>
    </div>
  );

  function canSubmit(): boolean {
    if (targetMode === "new") {
      return Boolean(newWorkTitle.trim() && newSelections.some((item) => item.enabled && item.title.trim()));
    }
    return Boolean(existingWorkId && leftItems.length > 0 && leftItems.every((item) => item.title.trim()));
  }

  function buildSubmitPayload(): ShareImportModalSubmit {
    if (targetMode === "new") {
      return {
        target: { mode: "new", title: newWorkTitle },
        entries: newSelections
          .filter((item) => item.enabled)
          .map((item) => ({
            source: "package",
            packageChapterId: item.packageChapterId,
            title: item.title
          })),
        remainingPackageChapters: [],
        deletedExistingChapters: []
      };
    }

    return {
      target: { mode: "existing", workId: existingWorkId },
      entries: leftItems.map(toImportEntry),
      remainingPackageChapters: availablePackageChapters,
      deletedExistingChapters
    };
  }
}

function ShareFinalPane({
  items,
  busy,
  activeDrag,
  setLeftItems
}: {
  items: LeftItem[];
  busy: boolean;
  activeDrag: ActiveDrag | null;
  setLeftItems: React.Dispatch<React.SetStateAction<LeftItem[]>>;
}): React.JSX.Element {
  const { isOver, setNodeRef } = useDroppable({
    id: LEFT_DROPZONE_ID,
    disabled: busy
  });

  return (
    <div ref={setNodeRef} className={`share-pane final-pane ${isOver || activeDrag ? "drop-ready" : ""}`}>
      <div className="share-pane-header">
        <strong>최종 적용 목록</strong>
        <span>드래그로 순서 변경</span>
      </div>
      <SortableContext items={items.map((item) => item.key)} strategy={verticalListSortingStrategy}>
        <div className="share-item-list final-list">
          {items.map((item, index) => (
            <SortableFinalChapterCard
              key={item.key}
              item={item}
              index={index}
              busy={busy}
              onTitleChange={(title) => setLeftItems((current) => current.map((candidate) => (candidate.key === item.key ? { ...candidate, title } : candidate)))}
              onDelete={() => setLeftItems((current) => current.filter((candidate) => candidate.key !== item.key))}
            />
          ))}
          {items.length === 0 ? <p className="panel-empty">왼쪽 목록이 비어 있습니다.</p> : null}
        </div>
      </SortableContext>
    </div>
  );
}

function SortableFinalChapterCard({
  item,
  index,
  busy,
  onTitleChange,
  onDelete
}: {
  item: LeftItem;
  index: number;
  busy: boolean;
  onTitleChange: (title: string) => void;
  onDelete: () => void;
}): React.JSX.Element {
  const { attributes, listeners, setActivatorNodeRef, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.key,
    disabled: busy,
    data: { type: "left" }
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition
  };

  return (
    <div ref={setNodeRef} className={`share-final-item ${item.source} ${isDragging ? "dragging" : ""}`} style={style}>
      <button
        ref={setActivatorNodeRef}
        className="drag-handle"
        disabled={busy}
        aria-label={`${item.title} 순서 이동`}
        title="드래그해서 이동"
        {...attributes}
        {...listeners}
      >
        <span className="drag-grip" aria-hidden="true" />
      </button>
      <span className="item-order">{index + 1}</span>
      <span className={`source-badge ${item.source}`}>{item.source === "existing" ? "기존" : "공유"}</span>
      <input className="share-title-input" value={item.title} disabled={busy} onChange={(event) => onTitleChange(event.target.value)} />
      <span className="page-count-chip">{item.pageCount}p</span>
      <button className="icon-danger-button" disabled={busy} onClick={onDelete} aria-label={`${item.title} 삭제`} title="삭제">
        ×
      </button>
    </div>
  );
}

function CandidateChapterCard({ chapter, busy, onAdd }: { chapter: WorkSharePreviewChapter; busy: boolean; onAdd: () => void }): React.JSX.Element {
  const { attributes, listeners, setActivatorNodeRef, setNodeRef, isDragging } = useDraggable({
    id: `${CANDIDATE_PREFIX}${chapter.packageChapterId}`,
    disabled: busy,
    data: {
      type: "candidate",
      packageChapterId: chapter.packageChapterId
    }
  });

  return (
    <div ref={setNodeRef} className={`candidate-card ${isDragging ? "dragging" : ""}`}>
      <button
        ref={setActivatorNodeRef}
        className="drag-handle"
        disabled={busy}
        aria-label={`${chapter.title} 최종 목록에 추가`}
        title="드래그해서 추가"
        {...attributes}
        {...listeners}
      >
        <span className="drag-grip" aria-hidden="true" />
      </button>
      <div className="candidate-main">
        <strong>{chapter.title}</strong>
        <small>{chapter.pageCount}페이지</small>
      </div>
      <button className="icon-add-button" disabled={busy} onClick={onAdd} aria-label={`${chapter.title} 추가`} title="추가">
        +
      </button>
    </div>
  );
}

function FinalChapterPreview({ item, index }: { item: LeftItem; index: number }): React.JSX.Element {
  return (
    <div className={`share-final-item drag-preview ${item.source}`}>
      <span className="drag-handle preview-handle">
        <span className="drag-grip" aria-hidden="true" />
      </span>
      <span className="item-order">{index}</span>
      <span className={`source-badge ${item.source}`}>{item.source === "existing" ? "기존" : "공유"}</span>
      <strong className="preview-title">{item.title}</strong>
      <span className="page-count-chip">{item.pageCount}p</span>
    </div>
  );
}

function CandidatePreview({ chapter }: { chapter: WorkSharePreviewChapter }): React.JSX.Element {
  return (
    <div className="candidate-card drag-preview">
      <span className="drag-handle preview-handle">
        <span className="drag-grip" aria-hidden="true" />
      </span>
      <div className="candidate-main">
        <strong>{chapter.title}</strong>
        <small>{chapter.pageCount}페이지</small>
      </div>
      <span className="icon-add-button preview-icon">+</span>
    </div>
  );
}

function buildExistingItems(work: LibraryWorkSummary | null): LeftItem[] {
  return (
    work?.chapters.map((chapter) => ({
      key: `existing:${chapter.id}`,
      source: "existing" as const,
      chapterId: chapter.id,
      title: chapter.title,
      pageCount: chapter.pageCount
    })) ?? []
  );
}

function toLeftPackageItem(chapter: WorkSharePreviewChapter): LeftItem {
  return {
    key: `package:${chapter.packageChapterId}`,
    source: "package",
    packageChapterId: chapter.packageChapterId,
    title: chapter.title,
    pageCount: chapter.pageCount
  };
}

function toImportEntry(item: LeftItem): WorkShareImportEntry {
  if (item.source === "existing") {
    return {
      source: "existing",
      chapterId: item.chapterId,
      title: item.title
    };
  }
  return {
    source: "package",
    packageChapterId: item.packageChapterId,
    title: item.title
  };
}
