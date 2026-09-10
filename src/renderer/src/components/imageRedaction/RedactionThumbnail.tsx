import React from "react";
import { useTranslation } from "react-i18next";
import type { RedactionDocument, RedactionWorkspacePage } from "../../../../shared/imageRedactionWorkspace";
import { SelectionSurface } from "../ui/SelectionCard";
import { RedactionMaskCanvas } from "./RedactionMaskCanvas";
import type { RedactionWorkspaceController } from "./useRedactionWorkspace";
import { useRedactionPreview } from "./useRedactionPreview";
import styles from "./RedactionWorkspace.module.css";

type Props = {
  page: RedactionWorkspacePage; document: RedactionDocument; form: RedactionWorkspaceController;
  size: number; number: number; selected: boolean; current: boolean;
  onSelect: (event: React.MouseEvent<HTMLElement>) => void; onOpen: () => void;
};
export function RedactionThumbnail({ page, document, form, size, number, selected, current, onSelect, onOpen }: Props): React.JSX.Element {
  const { t } = useTranslation("components");
  const image = useRedactionPreview(form.previews, form.state.workspace.sessionId, page.id, 320);
  const { markPreview } = form;
  React.useEffect(() => { if (image.error) markPreview(page.id, "error"); }, [image.error, markPreview, page.id]);
  const width = Math.min(size - 12, size * page.width / page.height);
  const height = width * page.height / page.width;
  return (
    <SelectionSurface as="button" variant="thumbnail" className={styles.tile} selected={selected}
      disabled={form.busy || form.drawing} role="option" aria-selected={selected}
      aria-label={t("manualRedaction.pageLabel", { number, name: page.name, status: t(`manualRedaction.${document.decision}`) })}
      aria-current={current ? "page" : undefined} data-page-id={page.id} tabIndex={current ? 0 : -1}
      onClick={onSelect} onDoubleClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.repeat) { event.preventDefault(); event.stopPropagation(); onOpen(); }
      }}>
      <span className={styles.thumbnailViewport} style={{ height: size }}>
        {image.url ? <span className={styles.thumbnailStage} style={{ width, height }}>
          <img src={image.url} alt="" draggable={false} className={styles.sourceImage}
            onLoad={() => markPreview(page.id, "ready")} onError={() => markPreview(page.id, "error")} />
          <RedactionMaskCanvas thumbnail width={page.width} height={page.height} strokes={document.strokes}
            onFailure={() => markPreview(page.id, "error")} />
        </span> : <span>{t(image.error ? "manualRedaction.previewErrorShort" : "manualRedaction.loading")}</span>}
      </span>
      <span className={styles.tileName}>{number} · {page.name}</span>
      <span className={styles.tileStatus} data-status={form.failed.has(page.id) ? "error" : document.decision}>
        {selected ? "✓ " : ""}{t(`manualRedaction.${document.decision}`)}{document.strokes.length ? ` · ${t("manualRedaction.hasMask")}` : ""}
      </span>
    </SelectionSurface>
  );
}
