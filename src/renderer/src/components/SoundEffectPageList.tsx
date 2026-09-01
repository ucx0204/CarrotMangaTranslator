import React from "react";
import { useTranslation } from "react-i18next";
import { PageListThumbnail } from "./pageList/PageListRowChrome";
import { usePageThumbnailObserver } from "./pageThumbnails";
import type { SoundEffectDraftPage } from "./soundEffectTranslationDraftModel";
import styles from "./SoundEffectTranslationModal.module.css";

export function SoundEffectPageList({
  activePageId,
  chapterTitle,
  pages,
  onSelectPage,
}: {
  activePageId: string;
  chapterTitle: string;
  pages: SoundEffectDraftPage[];
  onSelectPage: (pageId: string) => void;
}): React.JSX.Element {
  const listRef = React.useRef<HTMLDivElement | null>(null);
  const observeThumbnail = usePageThumbnailObserver(listRef);
  return (
    <aside className={styles.pageRail}>
      <strong className={styles.chapterTitle} title={chapterTitle}>
        {chapterTitle}
      </strong>
      <div className={styles.pageList} ref={listRef}>
        {pages.map((item) => (
          <SoundEffectPageListItem
            key={item.page.id}
            active={item.page.id === activePageId}
            item={item}
            observeThumbnail={observeThumbnail}
            onSelectPage={onSelectPage}
          />
        ))}
      </div>
    </aside>
  );
}

function SoundEffectPageListItem({
  active,
  item,
  observeThumbnail,
  onSelectPage,
}: {
  active: boolean;
  item: SoundEffectDraftPage;
  observeThumbnail: ReturnType<typeof usePageThumbnailObserver>;
  onSelectPage: (pageId: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const visible = item.regions.filter((region) => !region.deleted);
  const selected = visible.filter((region) => region.included).length;
  return (
    <button
      className={`${styles.pageButton} ${active ? styles.pageButtonActive : ""}`}
      aria-current={active ? "page" : undefined}
      aria-label={t("soundEffectReview.pageListLabel", {
        name: item.page.name,
        selected,
        total: visible.length,
      })}
      onClick={() => onSelectPage(item.page.id)}
      type="button"
    >
      <PageListThumbnail observeThumbnail={observeThumbnail} page={item.page} />
      <span className={styles.pageButtonCopy}>
        <strong title={item.page.name}>{item.page.name}</strong>
        <span>
          {t("soundEffectReview.pageSelection", {
            selected,
            total: visible.length,
          })}
        </span>
      </span>
    </button>
  );
}
