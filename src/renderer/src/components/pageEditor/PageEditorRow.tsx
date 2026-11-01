import React from "react";
import { useTranslation } from "react-i18next";
import { useSortable } from "@dnd-kit/sortable";
import { IconArrowRight, IconGripVertical } from "@tabler/icons-react";
import { Input } from "../ui/Field";
import { CheckboxField } from "../ui/CheckboxField";
import { IconButton } from "../ui/IconButton";
import { usePageThumbnail, type ObservePageThumbnail } from "../pageThumbnails";
import { pageNameParts } from "../../../../shared/pageOrganization";
import type { MangaPage } from "../../../../shared/libraryTypes";
import styles from "./PageEditor.module.css";

type RowProps = {
  page: MangaPage;
  index: number;
  name: string;
  selected: boolean;
  /** This page sits at a different position than when the dialog opened. */
  moved: boolean;
  error?: string;
  observe: ObservePageThumbnail;
  toggle: (id: string, shift: boolean) => void;
  edit: (id: string, value: string) => void;
  disabled: boolean;
  finishEdit: () => void;
};

export function PageEditorRow(props: RowProps): React.JSX.Element {
  const { page, index, selected, toggle, disabled } = props;
  const { t } = useTranslation("components");
  const input = React.useRef<HTMLInputElement>(null);
  const shift = React.useRef(false);
  const {
    setNodeRef,
    listeners,
    attributes,
    isDragging,
    isOver,
    activeIndex,
    overIndex,
  } = useSortable({ id: page.id, disabled });
  return (
    <tr
      ref={setNodeRef}
      data-page-id={page.id}
      data-selected={selected}
      data-drop={
        isOver && !isDragging
          ? activeIndex < overIndex
            ? "after"
            : "before"
          : undefined
      }
      onClick={(e) => {
        if (
          !disabled &&
          !(e.target as HTMLElement).closest("button, input, label")
        )
          toggle(page.id, e.shiftKey);
      }}
      data-dragging={isDragging}
      onPointerDownCapture={(e) => {
        shift.current = e.shiftKey;
      }}
      onKeyDownCapture={(e) => {
        shift.current = e.shiftKey;
        if (e.key === "F2") {
          e.preventDefault();
          input.current?.focus();
          input.current?.select();
        }
      }}
    >
      <td>
        <IconButton
          className={styles.grip}
          label={t("pageEditor.drag")}
          size="sm"
          disabled={disabled}
          {...attributes}
          {...listeners}
        >
          <IconGripVertical size={16} />
        </IconButton>
      </td>
      <td>
        <CheckboxField
          ariaLabel={`${t("pageEditor.select")} ${index + 1}`}
          checked={selected}
          disabled={disabled}
          onCheckedChange={() => toggle(page.id, shift.current)}
        />
      </td>
      <PageDetails {...props} input={input} />
    </tr>
  );
}

function PageEditorThumbnail({
  page,
  observe,
}: {
  page: MangaPage;
  observe: ObservePageThumbnail;
}): React.JSX.Element {
  const { frameRef, state, markLoaded, markErrored } =
    usePageThumbnail<HTMLSpanElement>(page, observe);
  const url = state.url;
  return (
    <span ref={frameRef} className={styles.thumbnail}>
      {url ? (
        <img
          src={url}
          alt=""
          onLoad={() => markLoaded(url)}
          onError={() => markErrored(url)}
        />
      ) : null}
    </span>
  );
}
function PageNameCell({
  input,
  page,
  index,
  name,
  error,
  edit,
  disabled,
  finishEdit,
}: {
  input: React.RefObject<HTMLInputElement | null>;
  page: MangaPage;
  index: number;
  name: string;
  error?: string;
  edit: (id: string, value: string) => void;
  disabled: boolean;
  finishEdit: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const parts = pageNameParts(page.name);
  const errorId = React.useId();
  return (
    <>
      <div
        className={styles.nameField}
        data-changed={name !== parts.base}
        data-invalid={Boolean(error)}
      >
        <Input
          ref={input}
          data-ui-framed-input=""
          aria-label={`${t("pageEditor.newName")} ${index + 1}`}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? errorId : undefined}
          value={name}
          disabled={disabled}
          onChange={(e) => edit(page.id, e.target.value)}
          onBlur={finishEdit}
          onKeyDown={(e) => moveFocusOnEnter(e)}
        />
        <span className={styles.extension}>{parts.extension}</span>
      </div>
      {error ? (
        <span id={errorId} className={styles.rowError}>
          {t(`pageEditor.errors.${error}`, {
            defaultValue: t("pageEditor.errors.invalid"),
          })}
        </span>
      ) : null}
    </>
  );
}

/** Enter/Tab walks the name column like a spreadsheet; Enter on the last row commits. */
function moveFocusOnEnter(e: React.KeyboardEvent<HTMLInputElement>): void {
  if (!["Enter", "Tab"].includes(e.key) || e.nativeEvent.isComposing) return;
  const row = e.currentTarget.closest("tr");
  const nextRow = e.shiftKey
    ? row?.previousElementSibling
    : row?.nextElementSibling;
  const next = nextRow?.querySelector<HTMLInputElement>(
    'input[type="text"], input:not([type])',
  );
  if (next) {
    e.preventDefault();
    next.focus();
    next.select();
  } else if (e.key === "Enter") {
    e.preventDefault();
    e.currentTarget.blur();
  }
}

function PageDetails({
  page,
  index,
  name,
  moved,
  error,
  observe,
  edit,
  finishEdit,
  disabled,
  input,
}: Omit<RowProps, "selected" | "toggle"> & {
  input: React.RefObject<HTMLInputElement | null>;
}): React.JSX.Element {
  const parts = pageNameParts(page.name);
  return (
    <>
      <td className={styles.order} data-changed={moved}>
        {index + 1}
      </td>
      <td>
        <PageEditorThumbnail page={page} observe={observe} />
      </td>
      <td className={styles.oldName} title={page.name}>
        {parts.base}
        <span className={styles.extension}>{parts.extension}</span>
      </td>
      <td className={styles.arrow} data-changed={name !== parts.base}>
        <IconArrowRight size={14} aria-hidden="true" />
      </td>
      <td>
        <PageNameCell
          input={input}
          page={page}
          index={index}
          name={name}
          error={error}
          edit={edit}
          finishEdit={finishEdit}
          disabled={disabled}
        />
      </td>
    </>
  );
}
