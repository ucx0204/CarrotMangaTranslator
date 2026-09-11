import React from "react";
import { useTranslation } from "react-i18next";
import type { RedactionDocument } from "../../../../shared/imageRedactionWorkspace";
import type { RedactionPageMetadata } from "./redactionSession";
import { SelectionSurface } from "../ui/SelectionCard";
import { RedactionMaskCanvas } from "./RedactionMaskCanvas";
import type { RedactionWorkspaceController } from "./redactionWorkspaceTypes";
import { useRedactionPreview } from "./useRedactionPreview";
import { useRedactionImageReadiness } from "./useRedactionImageReadiness";
import styles from "./RedactionWorkspace.module.css";

type Props = {
  page: RedactionPageMetadata;
  document: RedactionDocument;
  form: Pick<
    RedactionWorkspaceController,
    "state" | "busy" | "drawing" | "failed" | "previews" | "markPreview"
  >;
  size: number;
  number: number;
  selected: boolean;
  current: boolean;
  onSelect: (event: React.MouseEvent<HTMLElement>) => void;
  onOpen: () => void;
};
export function RedactionThumbnail(props: Props): React.JSX.Element {
  const { t } = useTranslation("components");
  const { page, document, form, number, selected, current, onSelect, onOpen } =
    props;
  const error = form.failed.has(page.id);
  const status = error ? "previewErrorShort" : document.decision;
  return (
    <SelectionSurface
      as="button"
      variant="thumbnail"
      className={styles.tile}
      selected={selected}
      disabled={form.busy || form.drawing}
      role="option"
      aria-selected={selected}
      aria-label={t("manualRedaction.pageLabel", {
        number,
        name: page.name,
        status: t(`manualRedaction.${status}`),
      })}
      aria-current={current ? "page" : undefined}
      data-page-id={page.id}
      tabIndex={current ? 0 : -1}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onKeyDown={(event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat && !event.nativeEvent.isComposing) onOpen();
      }}
    >
      <ThumbnailImage {...props} />
      <span className={styles.tileCaption}>
        <span className={styles.tileName}>
          {number} · {page.name}
        </span>
        <span
          className={styles.tileStatus}
          data-status={error ? "error" : document.decision}
          aria-hidden="true"
        >
          {t(`manualRedaction.${status}`)}
        </span>
      </span>
      {selected ? (
        <span className={styles.selectionMark} aria-hidden="true">
          {t("manualRedaction.selectedBadge")}
        </span>
      ) : null}
    </SelectionSurface>
  );
}
function ThumbnailImage({
  page,
  document,
  form,
  size,
}: Props): React.JSX.Element {
  const { t } = useTranslation("components");
  const image = useRedactionPreview(
    form.previews,
    form.state.workspace.sessionId,
    page.id,
    320,
  );
  const readiness = useRedactionImageReadiness({
    source: "thumbnail",
    form,
    pageId: page.id,
    requestKey: image.key,
    url: image.url,
    error: image.error,
    strokes: document.strokes,
  });
  const width = Math.min(size - 12, (size * page.width) / page.height);
  const height = (width * page.height) / page.width;
  return (
    <span className={styles.thumbnailViewport} style={{ height: size }}>
      {image.url ? (
        <span
          key={image.key}
          className={styles.thumbnailStage}
          style={{ width, height }}
        >
          <img
            src={image.url}
            alt=""
            draggable={false}
            className={styles.sourceImage}
            onLoad={readiness.decoded}
            onError={() => readiness.reject()}
          />
          <RedactionMaskCanvas
            thumbnail
            width={page.width}
            height={page.height}
            strokes={document.strokes}
            onReady={readiness.masked}
            onFailure={readiness.reject}
          />
        </span>
      ) : (
        <span>
          {t(
            image.error
              ? "manualRedaction.previewErrorShort"
              : "manualRedaction.loading",
          )}
        </span>
      )}
    </span>
  );
}
