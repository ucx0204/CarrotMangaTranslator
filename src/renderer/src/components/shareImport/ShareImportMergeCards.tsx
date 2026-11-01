import React from "react";
import { useTranslation } from "react-i18next";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { PlusIcon, TrashIcon } from "../ui/icons";
import type { LeftItem } from "./shareImportTypes";
import { Button } from "../ui/Button";
import { Input } from "../ui/Field";

export function SortableFinalChapterCard({
  busy,
  index,
  item,
  onDelete,
  onTitleChange,
}: {
  busy: boolean;
  index: number;
  item: LeftItem;
  onDelete: () => void;
  onTitleChange: (title: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.key, disabled: busy });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      className={`share-final-item ${item.source} ${isDragging ? "dragging" : ""}`}
      style={style}
    >
      <Button
        ref={setActivatorNodeRef}
        className="drag-handle"
        disabled={busy}
        aria-label={t("shareImport.moveItem", { title: item.title })}
        title={t("common.dragToMove")}
        {...attributes}
        {...listeners}
        variant="bare"
      >
        <span className="drag-grip" aria-hidden="true" />
      </Button>
      <span className="item-order">{index + 1}</span>
      <span className={`source-badge ${item.source}`}>
        {t(
          item.source === "existing"
            ? "shareImport.source.existing"
            : "shareImport.source.shared",
        )}
      </span>
      <Input
        className="share-title-input"
        aria-label={t("import.chapterTitle")}
        value={item.title}
        disabled={busy}
        onChange={(event) => onTitleChange(event.target.value)}
      />
      <span className="page-count-chip">
        {t("common.pageCount", { count: item.pageCount })}
      </span>
      <Button
        className="icon-danger-button"
        disabled={busy}
        onClick={onDelete}
        aria-label={t("shareImport.deleteItem", { title: item.title })}
        title={t("common.delete")}
        variant="bare"
      >
        <TrashIcon size={15} />
      </Button>
    </div>
  );
}

export function CandidateChapterCard({
  busy,
  item,
  onAdd,
}: {
  busy: boolean;
  item: LeftItem;
  onAdd: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.key, disabled: busy });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      className={`candidate-card ${isDragging ? "dragging" : ""}`}
      style={style}
    >
      <Button
        ref={setActivatorNodeRef}
        className="drag-handle"
        disabled={busy}
        aria-label={t("shareImport.addToFinal", { title: item.title })}
        title={t("shareImport.dragToAdd")}
        {...attributes}
        {...listeners}
        variant="bare"
      >
        <span className="drag-grip" aria-hidden="true" />
      </Button>
      <div className="candidate-main">
        <strong>{item.title}</strong>
        <small>{t("common.pageCount", { count: item.pageCount })}</small>
      </div>
      <Button
        className="icon-add-button"
        disabled={busy}
        onClick={onAdd}
        aria-label={t("shareImport.addItem", { title: item.title })}
        title={t("common.add")}
        variant="bare"
      >
        <PlusIcon size={16} />
      </Button>
    </div>
  );
}

export function FinalChapterPreview({
  index,
  item,
}: {
  index: number;
  item: LeftItem;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className={`share-final-item drag-preview ${item.source}`}>
      <span className="drag-handle preview-handle">
        <span className="drag-grip" aria-hidden="true" />
      </span>
      <span className="item-order">{index}</span>
      <span className={`source-badge ${item.source}`}>
        {t(
          item.source === "existing"
            ? "shareImport.source.existing"
            : "shareImport.source.shared",
        )}
      </span>
      <strong className="preview-title">{item.title}</strong>
      <span className="page-count-chip">
        {t("common.pageCount", { count: item.pageCount })}
      </span>
    </div>
  );
}

export function CandidatePreview({
  item,
}: {
  item: LeftItem;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="candidate-card drag-preview">
      <span className="drag-handle preview-handle">
        <span className="drag-grip" aria-hidden="true" />
      </span>
      <div className="candidate-main">
        <strong>{item.title}</strong>
        <small>{t("common.pageCount", { count: item.pageCount })}</small>
      </div>
      <span className="icon-add-button preview-icon">
        <PlusIcon size={16} />
      </span>
    </div>
  );
}
