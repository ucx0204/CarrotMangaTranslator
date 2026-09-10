import React from "react";
import { useTranslation } from "react-i18next";
import { useEventCallback } from "../../hooks/useEventCallback";
import type { RedactionWorkspaceController } from "./useRedactionWorkspace";
import { selectRedactionRange } from "./redactionSession";
import { changeRedactionView } from "./redactionWorkspaceModel";
import { useRedactionGridWindow } from "./useRedactionGridWindow";
import { RedactionThumbnail } from "./RedactionThumbnail";
import styles from "./RedactionWorkspace.module.css";

type Props = {
  form: RedactionWorkspaceController;
  ids: string[];
  onOpen: (id: string, focusEditor?: boolean) => void;
};
const SIZE = 112;
const ROW_HEIGHT = SIZE + 54;

/** The former overview now has one presentation: the continuous editor's filmstrip. */
export function RedactionPageGrid(props: Props): React.JSX.Element {
  const { form, ids } = props;
  const { t } = useTranslation("components");
  const { state } = form;
  const { view, pages } = state.workspace;
  const { viewportRef, start, end, top, totalHeight, onScroll, reveal } =
    useRedactionGridWindow(
      ids.length,
      ROW_HEIGHT,
      view.gridOffset,
      (gridOffset) =>
        form.commit((current) => changeRedactionView(current, { gridOffset })),
    );
  const select = usePageSelection(props);
  const focus = useListFocus(ids, select, reveal, viewportRef);
  React.useEffect(() => {
    reveal(ids.indexOf(view.currentId));
  }, [ids, view.currentId, reveal]);
  const metadata = React.useMemo(
    () =>
      new Map(
        pages.map((page, index) => [page.id, { page, number: index + 1 }]),
      ),
    [pages],
  );
  return (
    <div
      className={styles.gridViewport}
      ref={viewportRef}
      onScroll={onScroll}
      role="listbox"
      aria-multiselectable="true"
      aria-label={t("manualRedaction.pageList")}
      tabIndex={0}
      onKeyDown={(event) => handleListKey(event, props, focus)}
    >
      {!ids.length ? (
        <p className={styles.empty}>{t("manualRedaction.emptyFilter")}</p>
      ) : null}
      <div className={styles.gridSpace} style={{ height: totalHeight }}>
        <div
          className={styles.gridRows}
          style={{ top, gridAutoRows: ROW_HEIGHT }}
        >
          {ids.slice(start, end).map((id) => {
            const item = metadata.get(id);
            if (!item) return null;
            return (
              <RedactionThumbnail
                key={id}
                {...item}
                document={state.documents[id]}
                form={form}
                size={SIZE}
                selected={view.selectedIds.includes(id)}
                current={view.currentId === id}
                onSelect={(event) =>
                  select(id, event.shiftKey, event.ctrlKey || event.metaKey)
                }
                onOpen={() => props.onOpen(id)}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
function usePageSelection({ form, ids, onOpen }: Props) {
  const anchorRef = React.useRef(form.state.workspace.view.currentId);
  return useEventCallback((id: string, shift: boolean, toggle: boolean) => {
    if (form.busy || form.drawing) return;
    form.commit((current) =>
      changeRedactionView(current, {
        selectedIds: selectRedactionRange(
          ids,
          current.workspace.view.selectedIds,
          anchorRef.current,
          id,
          shift,
          toggle,
        ),
      }),
    );
    if (!shift) anchorRef.current = id;
    onOpen(id, false);
  });
}
function handleListKey(
  event: React.KeyboardEvent,
  { form, ids }: Props,
  focus: (index: number, extend: boolean) => void,
): void {
  if (
    form.busy ||
    form.drawing ||
    event.nativeEvent.isComposing ||
    event.altKey
  )
    return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
    event.preventDefault();
    event.stopPropagation();
    form.commit((current) =>
      changeRedactionView(current, { selectedIds: ids }),
    );
    return;
  }
  const index = Math.max(0, ids.indexOf(form.state.workspace.view.currentId));
  const targets: Record<string, number> = {
    ArrowLeft: index - 1,
    ArrowRight: index + 1,
    ArrowUp: index - 1,
    ArrowDown: index + 1,
    Home: 0,
    End: ids.length - 1,
  };
  const target = targets[event.key];
  if (target === undefined) return;
  event.preventDefault();
  event.stopPropagation();
  focus(target, event.shiftKey);
}

function useListFocus(
  ids: string[],
  select: (id: string, shift: boolean, toggle: boolean) => void,
  reveal: (index: number) => void,
  viewportRef: React.RefObject<HTMLDivElement | null>,
) {
  return useEventCallback((index: number, extend: boolean) => {
    const id = ids[Math.max(0, Math.min(ids.length - 1, index))];
    if (!id) return;
    select(id, extend, false);
    reveal(index);
    requestAnimationFrame(() => {
      Array.from(
        viewportRef.current?.querySelectorAll<HTMLElement>("[data-page-id]") ??
          [],
      )
        .find((element) => element.dataset.pageId === id)
        ?.focus();
    });
  });
}
