import React from "react";
import { useTranslation } from "react-i18next";
import type { RedactionWorkspaceController } from "./useRedactionWorkspace";
import { selectRedactionRange } from "./redactionSession";
import { changeRedactionView, navigateRedactionPage } from "./redactionWorkspaceModel";
import { useRedactionGridWindow } from "./useRedactionGridWindow";
import { RedactionThumbnail } from "./RedactionThumbnail";
import styles from "./RedactionWorkspace.module.css";

type Props = { form: RedactionWorkspaceController; ids: string[]; compact?: boolean; onOpen: (id: string) => void };
export function RedactionPageGrid({ form, ids, compact = false, onOpen }: Props): React.JSX.Element {
  const { t } = useTranslation("components");
  const { state, commit } = form;
  const { view, pages } = state.workspace;
  const size = compact ? 124 : view.thumbnailSize;
  const window = useRedactionGridWindow(ids.length, size, compact, compact ? 0 : view.gridOffset,
    (gridOffset) => { if (!compact) commit((current) => changeRedactionView(current, { gridOffset })); });
  const metadata = React.useMemo(() => new Map(pages.map((page, index) => [page.id, { page, number: index + 1 }])), [pages]);
  const anchor = React.useRef(view.currentId);
  const select = (id: string, shift: boolean, toggle: boolean) => {
    commit((current) => changeRedactionView(navigateRedactionPage(current, id), {
      selectedIds: selectRedactionRange(ids, current.workspace.view.selectedIds, anchor.current, id, shift, toggle),
    }));
    if (!shift) anchor.current = id;
  };
  React.useEffect(() => {
    if (compact) window.reveal(ids.indexOf(view.currentId));
  }, [compact, ids, view.currentId]);
  const focus = (index: number, extend: boolean) => {
    const id = ids[Math.max(0, Math.min(ids.length - 1, index))];
    if (!id) return;
    select(id, extend, false); window.reveal(index);
    requestAnimationFrame(() => {
      const options = window.viewport.current?.querySelectorAll<HTMLElement>("[data-page-id]");
      Array.from(options ?? []).find((element) => element.dataset.pageId === id)?.focus();
    });
  };
  return <div className={styles.gridViewport} ref={window.viewport} onScroll={window.onScroll}
    role="listbox" aria-multiselectable={!compact} aria-label={t("manualRedaction.pageList")} tabIndex={0}
    onKeyDown={(event) => handleGridKey(event, { ids, currentId: view.currentId, columns: window.columns, focus, selectAll: () => commit((current) => changeRedactionView(current, { selectedIds: ids })) })}>
    {!ids.length ? <p className={styles.empty}>{t("manualRedaction.emptyFilter")}</p> : null}
    <div className={styles.gridSpace} style={{ height: window.totalHeight }}>
      <div className={styles.gridRows} style={{ top: window.top, gridTemplateColumns: `repeat(${window.columns}, minmax(0, 1fr))`, gridAutoRows: window.rowHeight }}>
        {ids.slice(window.start, window.end).map((id) => {
          const item = metadata.get(id);
          if (!item) return null;
          return <RedactionThumbnail key={id} {...item} document={state.documents[id]} form={form} size={size}
            selected={view.selectedIds.includes(id)} current={view.currentId === id}
            onSelect={(event) => {
              if (compact && !event.shiftKey && !event.ctrlKey && !event.metaKey) onOpen(id);
              else select(id, event.shiftKey, event.ctrlKey || event.metaKey);
            }} onOpen={() => onOpen(id)} />;
        })}
      </div>
    </div>
  </div>;
}

function handleGridKey(event: React.KeyboardEvent, options: {
  ids: string[]; currentId: string; columns: number; focus: (index: number, extend: boolean) => void; selectAll: () => void;
}): void {
  if (event.nativeEvent.isComposing || event.altKey) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
    event.preventDefault(); event.stopPropagation(); options.selectAll(); return;
  }
  const deltas: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -options.columns, ArrowDown: options.columns };
  const index = Math.max(0, options.ids.indexOf(options.currentId));
  const next = event.key === "Home" ? 0 : event.key === "End" ? options.ids.length - 1 : deltas[event.key] === undefined ? null : index + deltas[event.key];
  if (next === null) return;
  event.preventDefault(); event.stopPropagation(); options.focus(next, event.shiftKey);
}
