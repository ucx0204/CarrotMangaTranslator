import React from "react";
import { useTranslation } from "react-i18next";
import type { MangaPage } from "../../../shared/libraryTypes";
import type { TranslationBlock } from "../../../shared/textTypes";
import {
  sortBlocksForReading,
  type BlockReadingDirection,
} from "../../../shared/blockReadingOrder";
import { PageBlockListRow } from "./PageBlockListRow";

type PageBlockListPanelProps = {
  disabled: boolean;
  page: MangaPage;
  readingDirection: BlockReadingDirection;
  selectedBlockId: string | null;
  onOpenEditor: (blockId: string) => void;
  onSelectBlock: (blockId: string) => void;
  onUpdateBlock: (blockId: string, patch: Partial<TranslationBlock>) => void;
};

export function PageBlockListPanel({
  disabled,
  page,
  readingDirection,
  selectedBlockId,
  onOpenEditor,
  onSelectBlock,
  onUpdateBlock,
}: PageBlockListPanelProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const orderedBlocks = React.useMemo(
    () => sortBlocksForReading(page.blocks, readingDirection),
    [page.blocks, readingDirection],
  );

  React.useEffect(() => {
    if (!selectedBlockId) return;
    const row = Array.from(
      scrollRef.current?.querySelectorAll<HTMLElement>(
        "[data-page-block-id]",
      ) ?? [],
    ).find((node) => node.dataset.pageBlockId === selectedBlockId);
    row?.scrollIntoView({ block: "nearest" });
  }, [selectedBlockId]);

  return (
    <section className="page-block-list-panel">
      <PageBlockListHeader blockCount={orderedBlocks.length} />
      <div className="page-block-list-scroll" ref={scrollRef}>
        {orderedBlocks.length > 0 ? (
          orderedBlocks.map((block, index) => (
            <PageBlockListRow
              key={block.id}
              block={block}
              disabled={disabled}
              index={index}
              selected={block.id === selectedBlockId}
              onOpenEditor={onOpenEditor}
              onSelect={onSelectBlock}
              onUpdate={onUpdateBlock}
            />
          ))
        ) : (
          <p className="muted-line page-block-list-empty">
            {t("pageBlocks.empty")}
          </p>
        )}
      </div>
    </section>
  );
}

function PageBlockListHeader({
  blockCount,
}: {
  blockCount: number;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <header className="page-block-list-panel-header">
      <div>
        <h2>{t("pageBlocks.title")}</h2>
        <span>{t("pageBlocks.count", { count: blockCount })}</span>
      </div>
    </header>
  );
}
