import React from "react";
import { useTranslation } from "react-i18next";
import type { BBox } from "../../../shared/textTypes";
import { FontsContext } from "../fonts/fontsContextValue";
import { DEFAULT_BLOCK_FONT_CATALOG } from "../lib/fonts";
import { PageArtwork } from "./PageArtwork";
import { SoundEffectCandidateOverlay } from "./SoundEffectCandidateOverlay";
import { usePageThumbnail, type ObservePageThumbnail } from "./pageThumbnails";
import {
  bboxStyle,
  type ResizeDirection,
  type SelectedSoundEffectDraftRegion,
  type SoundEffectDraftPage,
} from "./soundEffectTranslationDraftModel";
import { useContainedPageSize } from "./useContainedPageSize";
import { useSoundEffectPageEditor } from "./useSoundEffectPageEditor";
import styles from "./SoundEffectTranslationModal.module.css";

type PagePreviewProps = {
  item: SoundEffectDraftPage;
  selectedRegion: SelectedSoundEffectDraftRegion;
  showTranslations: boolean;
  onCreateRegion: (bbox: BBox) => void;
  onSelectedRegionChange: (selection: SelectedSoundEffectDraftRegion) => void;
  onToggleRegion: (regionId: string) => void;
  onUpdateRegion: (regionId: string, bbox: BBox) => void;
};

export function SoundEffectPagePreview(
  props: PagePreviewProps,
): React.JSX.Element {
  const fontContext = React.useContext(FontsContext);
  const { frameRef, state } = usePageThumbnail<HTMLDivElement>(
    props.item.page,
    observeImmediately,
  );
  const viewportRef = React.useRef<HTMLDivElement | null>(null);
  const visualSize = useContainedPageSize(viewportRef, props.item.page);
  return (
    <div className={styles.preview}>
      <SoundEffectPreviewHeader pageName={props.item.page.name} />
      <div className={styles.previewViewport} ref={viewportRef}>
        <div className={styles.thumbnailLoader} ref={frameRef} />
        {state.url ? (
          <SoundEffectPageStage
            {...props}
            catalog={fontContext?.catalog ?? DEFAULT_BLOCK_FONT_CATALOG}
            imageSrc={state.url}
            visualSize={visualSize}
          />
        ) : (
          <SoundEffectPreviewPlaceholder
            failed={state.status === "error"}
            pageName={props.item.page.name}
          />
        )}
      </div>
    </div>
  );
}

function SoundEffectPageStage({
  item,
  selectedRegion,
  showTranslations,
  catalog,
  imageSrc,
  visualSize,
  onCreateRegion,
  onSelectedRegionChange,
  onToggleRegion,
  onUpdateRegion,
}: PagePreviewProps & {
  catalog: React.ComponentProps<typeof PageArtwork>["fontCatalog"];
  imageSrc: string;
  visualSize: { width: number; height: number };
}): React.JSX.Element {
  const stageRef = React.useRef<HTMLDivElement | null>(null);
  const editor = useSoundEffectPageEditor({
    stageRef,
    visualSize,
    onCreateRegion,
    onUpdateRegion,
  });
  return (
    <div
      ref={stageRef}
      className={styles.pageCanvas}
      style={{ width: visualSize.width, height: visualSize.height }}
      data-preview-page-id={item.page.id}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        editor.beginCreate(event);
        onSelectedRegionChange(null);
      }}
    >
      <div className={styles.artworkHost}>
        <PageArtwork
          fontCatalog={catalog}
          imageSrc={imageSrc}
          page={showTranslations ? item.page : { ...item.page, blocks: [] }}
          showBlockChrome={showTranslations}
          visualSize={visualSize}
        />
      </div>
      <SoundEffectCandidateList
        editor={editor}
        item={item}
        selectedRegion={selectedRegion}
        onSelectedRegionChange={onSelectedRegionChange}
        onToggleRegion={onToggleRegion}
      />
      {editor.creationBbox ? (
        <div
          className={styles.creationBox}
          style={bboxStyle(editor.creationBbox)}
          aria-hidden="true"
        />
      ) : null}
    </div>
  );
}

function SoundEffectCandidateList({
  editor,
  item,
  selectedRegion,
  onSelectedRegionChange,
  onToggleRegion,
}: {
  editor: ReturnType<typeof useSoundEffectPageEditor>;
  item: SoundEffectDraftPage;
  selectedRegion: SelectedSoundEffectDraftRegion;
  onSelectedRegionChange: (selection: SelectedSoundEffectDraftRegion) => void;
  onToggleRegion: (regionId: string) => void;
}): React.JSX.Element {
  const selectedId =
    selectedRegion?.pageId === item.page.id ? selectedRegion.regionId : null;
  const selectedAtPointerDownRef = React.useRef<string | null>(null);
  return (
    <>
      {item.regions
        .filter((region) => !region.deleted)
        .map((region, index) => (
          <SoundEffectCandidateOverlay
            key={region.id}
            index={index}
            region={region}
            selected={selectedId === region.id}
            onClick={(event) => {
              if (editor.suppressClickRef.current) {
                editor.suppressClickRef.current = false;
                selectedAtPointerDownRef.current = null;
                return;
              }
              const wasSelected =
                event.detail === 0
                  ? selectedId === region.id
                  : selectedAtPointerDownRef.current === region.id;
              selectedAtPointerDownRef.current = null;
              onSelectedRegionChange({
                pageId: item.page.id,
                regionId: region.id,
              });
              if (wasSelected) onToggleRegion(region.id);
            }}
            onPointerDown={(event) => {
              event.stopPropagation();
              if (event.button !== 0) return;
              selectedAtPointerDownRef.current =
                selectedId === region.id ? region.id : null;
              onSelectedRegionChange({
                pageId: item.page.id,
                regionId: region.id,
              });
              editor.beginMove(event, region.id, region.bbox);
            }}
            onResizePointerDown={(event, direction: ResizeDirection) => {
              event.stopPropagation();
              selectedAtPointerDownRef.current = null;
              onSelectedRegionChange({
                pageId: item.page.id,
                regionId: region.id,
              });
              editor.beginResize(event, region.id, region.bbox, direction);
            }}
          />
        ))}
    </>
  );
}

function SoundEffectPreviewHeader({
  pageName,
}: {
  pageName: string;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <header className={styles.previewHeader}>
      <strong>{pageName}</strong>
      <span className={styles.legend}>
        <span>
          <i className={styles.legendIncluded} />
          {t("soundEffectReview.included")}
        </span>
        <span>
          <i className={styles.legendExcluded} />
          {t("soundEffectReview.excluded")}
        </span>
      </span>
    </header>
  );
}

function SoundEffectPreviewPlaceholder({
  failed,
  pageName,
}: {
  failed: boolean;
  pageName: string;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <span className={styles.previewPlaceholder} role="status">
      {failed ? t("chapterPicker.thumbnailLoadFailed") : pageName}
    </span>
  );
}

const observeImmediately: ObservePageThumbnail = (_element, onVisible) => {
  onVisible();
  return () => undefined;
};
