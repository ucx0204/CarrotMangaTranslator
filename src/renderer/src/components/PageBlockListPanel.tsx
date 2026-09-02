import React from "react";
import { useTranslation } from "react-i18next";
import type { MangaPage } from "../../../shared/libraryTypes";
import type { TranslationBlock } from "../../../shared/textTypes";
import {
  resolvePageBlocksForReading,
  type BlockReadingDirection,
} from "../../../shared/blockReadingOrder";
import { PageBlockListRow } from "./PageBlockListRow";
import { Button } from "./ui/Button";

type PageBlockListPanelProps = {
  disabled: boolean;
  page: MangaPage;
  readingDirection: BlockReadingDirection;
  selectedBlockId: string | null;
  selectedBlockIds?: string[];
  onChangeSelection?: (
    blockIds: string[],
    primaryBlockId: string | null,
  ) => void;
  onMoveBlock?: (blockId: string, direction: -1 | 1) => void;
  onOpenEditor: (blockId: string) => void;
  onSelectBlock: (blockId: string) => void;
  onSortReadingOrder?: () => void;
  onUpdateBlock: (blockId: string, patch: Partial<TranslationBlock>) => void;
};

export function PageBlockListPanel({
  disabled,
  page,
  readingDirection,
  selectedBlockId,
  selectedBlockIds: selectedBlockIdsProp,
  onChangeSelection = NOOP_SELECTION_CHANGE,
  onMoveBlock = NOOP_MOVE_BLOCK,
  onOpenEditor,
  onSelectBlock,
  onSortReadingOrder = NOOP,
  onUpdateBlock,
}: PageBlockListPanelProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const selectedBlockIds = React.useMemo(
    () => selectedBlockIdsProp ?? (selectedBlockId ? [selectedBlockId] : []),
    [selectedBlockId, selectedBlockIdsProp],
  );
  const orderedBlocks = React.useMemo(
    () => resolvePageBlocksForReading(page, readingDirection),
    [page, readingDirection],
  );
  const selectedIds = React.useMemo(
    () => new Set(selectedBlockIds),
    [selectedBlockIds],
  );
  const selectBlock = usePageBlockListSelection({
    onChangeSelection,
    onSelectBlock,
    orderedBlocks,
    selectedBlockId,
    selectedBlockIds,
    selectedIds,
  });

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
      <PageBlockListHeader
        blockCount={orderedBlocks.length}
        disabled={disabled}
        selectedCount={selectedBlockIds.length}
        onSortReadingOrder={onSortReadingOrder}
      />
      <div className="page-block-list-scroll" ref={scrollRef}>
        {orderedBlocks.length > 0 ? (
          orderedBlocks.map((block, index) => (
            <PageBlockListRow
              key={block.id}
              block={block}
              disabled={disabled}
              index={index}
              last={index === orderedBlocks.length - 1}
              selected={selectedIds.has(block.id)}
              onMoveEarlier={(blockId) => onMoveBlock(blockId, -1)}
              onMoveLater={(blockId) => onMoveBlock(blockId, 1)}
              onOpenEditor={onOpenEditor}
              onSelect={selectBlock}
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

function usePageBlockListSelection({
  onChangeSelection,
  onSelectBlock,
  orderedBlocks,
  selectedBlockId,
  selectedBlockIds,
  selectedIds,
}: {
  onChangeSelection: NonNullable<PageBlockListPanelProps["onChangeSelection"]>;
  onSelectBlock: PageBlockListPanelProps["onSelectBlock"];
  orderedBlocks: TranslationBlock[];
  selectedBlockId: string | null;
  selectedBlockIds: string[];
  selectedIds: ReadonlySet<string>;
}): PageBlockListPanelProps["onSelectBlock"] {
  const selectionAnchorRef = React.useRef<string | null>(selectedBlockId);
  return React.useCallback(
    (blockId, modifiers = { additive: false, range: false }) => {
      const order = orderedBlocks.map((block) => block.id);
      const rangeIds = resolveSelectionRange(
        order,
        selectionAnchorRef.current,
        blockId,
        modifiers.range,
      );
      if (rangeIds) {
        onChangeSelection(
          modifiers.additive
            ? [...new Set([...selectedBlockIds, ...rangeIds])]
            : rangeIds,
          blockId,
        );
        return;
      }
      selectionAnchorRef.current = blockId;
      if (!modifiers.additive) {
        onSelectBlock(blockId);
        return;
      }
      const next = selectedIds.has(blockId)
        ? selectedBlockIds.filter((id) => id !== blockId)
        : [...selectedBlockIds, blockId];
      onChangeSelection(
        next,
        next.includes(blockId) ? blockId : (next[0] ?? null),
      );
    },
    [
      onChangeSelection,
      onSelectBlock,
      orderedBlocks,
      selectedBlockIds,
      selectedIds,
    ],
  );
}

function resolveSelectionRange(
  order: string[],
  anchorId: string | null,
  targetId: string,
  range: boolean,
): string[] | null {
  if (!range || !anchorId) return null;
  const anchorIndex = order.indexOf(anchorId);
  const targetIndex = order.indexOf(targetId);
  if (anchorIndex < 0 || targetIndex < 0) return null;
  const start = Math.min(anchorIndex, targetIndex);
  const end = Math.max(anchorIndex, targetIndex);
  return order.slice(start, end + 1);
}

const NOOP = (): void => undefined;
const NOOP_MOVE_BLOCK = (): void => undefined;
const NOOP_SELECTION_CHANGE = (): void => undefined;

function PageBlockListHeader({
  blockCount,
  disabled,
  selectedCount,
  onSortReadingOrder,
}: {
  blockCount: number;
  disabled: boolean;
  selectedCount: number;
  onSortReadingOrder: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <header className="page-block-list-panel-header">
      <div>
        <h2>{t("pageBlocks.title")}</h2>
        <span>{t("pageBlocks.count", { count: blockCount })}</span>
        {selectedCount > 1 ? (
          <span>{t("pageBlocks.selectedCount", { count: selectedCount })}</span>
        ) : null}
      </div>
      <Button
        className="page-block-order-sort"
        disabled={disabled || blockCount < 2}
        onClick={onSortReadingOrder}
        size="sm"
      >
        {t("pageBlocks.sortReadingOrder")}
      </Button>
    </header>
  );
}
