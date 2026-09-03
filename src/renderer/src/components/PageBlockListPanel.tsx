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
  const view = usePageBlockListView({
    onChangeSelection,
    onSelectBlock,
    page,
    readingDirection,
    selectedBlockId,
    selectedBlockIdsProp,
  });
  useScrollSelectedBlockIntoView(scrollRef, selectedBlockId);

  return (
    <section className="page-block-list-panel">
      <PageBlockListHeader
        blockCount={view.orderedBlocks.length}
        disabled={disabled}
        needsReviewCount={view.needsReviewCount}
        reviewOnly={view.reviewOnly}
        selectedCount={view.selectedBlockIds.length}
        onReviewOnlyChange={view.setReviewOnly}
        onSortReadingOrder={onSortReadingOrder}
      />
      <div className="page-block-list-scroll" ref={scrollRef}>
        {view.visibleBlocks.length > 0 ? (
          view.visibleBlocks.map((block) => {
            const readingIndex = view.readingIndexById.get(block.id) ?? 0;
            return (
              <PageBlockListRow
                key={block.id}
                block={block}
                disabled={disabled}
                expanded={block.id === selectedBlockId}
                index={readingIndex}
                last={readingIndex === view.orderedBlocks.length - 1}
                selected={view.selectedIds.has(block.id)}
                onMoveEarlier={(blockId) => onMoveBlock(blockId, -1)}
                onMoveLater={(blockId) => onMoveBlock(blockId, 1)}
                onOpenEditor={onOpenEditor}
                onSelect={view.selectBlock}
                onUpdate={onUpdateBlock}
              />
            );
          })
        ) : (
          <p className="muted-line page-block-list-empty">
            {t(
              view.reviewOnly ? "pageBlocks.noReviewItems" : "pageBlocks.empty",
            )}
          </p>
        )}
      </div>
    </section>
  );
}

function usePageBlockListView({
  onChangeSelection,
  onSelectBlock,
  page,
  readingDirection,
  selectedBlockId,
  selectedBlockIdsProp,
}: Pick<
  PageBlockListPanelProps,
  | "onChangeSelection"
  | "onSelectBlock"
  | "page"
  | "readingDirection"
  | "selectedBlockId"
> & {
  selectedBlockIdsProp: string[] | undefined;
}) {
  const [reviewOnly, setReviewOnly] = React.useState(false);
  const selectedBlockIds = React.useMemo(
    () => selectedBlockIdsProp ?? (selectedBlockId ? [selectedBlockId] : []),
    [selectedBlockId, selectedBlockIdsProp],
  );
  const orderedBlocks = React.useMemo(
    () => resolvePageBlocksForReading(page, readingDirection),
    [page, readingDirection],
  );
  const readingIndexById = React.useMemo(
    () => new Map(orderedBlocks.map((block, index) => [block.id, index])),
    [orderedBlocks],
  );
  const selectedIds = React.useMemo(
    () => new Set(selectedBlockIds),
    [selectedBlockIds],
  );
  const needsReviewCount = orderedBlocks.filter(
    (block) => block.reviewStatus === "needs_review",
  ).length;
  const visibleBlocks = reviewOnly
    ? orderedBlocks.filter((block) => block.reviewStatus === "needs_review")
    : orderedBlocks;
  const selectBlock = usePageBlockListSelection({
    onChangeSelection: onChangeSelection ?? NOOP_SELECTION_CHANGE,
    onSelectBlock,
    orderedBlocks,
    selectedBlockId,
    selectedBlockIds,
    selectedIds,
  });
  return {
    needsReviewCount,
    orderedBlocks,
    readingIndexById,
    reviewOnly,
    selectedBlockIds,
    selectedIds,
    selectBlock,
    setReviewOnly,
    visibleBlocks,
  };
}

function useScrollSelectedBlockIntoView(
  scrollRef: React.RefObject<HTMLDivElement | null>,
  selectedBlockId: string | null,
): void {
  React.useEffect(() => {
    if (!selectedBlockId) return;
    const row = Array.from(
      scrollRef.current?.querySelectorAll<HTMLElement>(
        "[data-page-block-id]",
      ) ?? [],
    ).find((node) => node.dataset.pageBlockId === selectedBlockId);
    row?.scrollIntoView({ block: "nearest" });
  }, [scrollRef, selectedBlockId]);
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
  needsReviewCount,
  reviewOnly,
  selectedCount,
  onReviewOnlyChange,
  onSortReadingOrder,
}: {
  blockCount: number;
  disabled: boolean;
  needsReviewCount: number;
  reviewOnly: boolean;
  selectedCount: number;
  onReviewOnlyChange: (reviewOnly: boolean) => void;
  onSortReadingOrder: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <header className="page-block-list-panel-header">
      <div>
        <div className="page-block-list-title-row">
          <h2>{t("pageBlocks.title")}</h2>
          <span>{t("pageBlocks.count", { count: blockCount })}</span>
        </div>
        {blockCount > 0 ? (
          <span className="page-block-review-progress">
            {t(
              needsReviewCount > 0
                ? "pageBlocks.reviewProgress"
                : "pageBlocks.reviewComplete",
              { count: needsReviewCount },
            )}
          </span>
        ) : null}
        {selectedCount > 1 ? (
          <span>{t("pageBlocks.selectedCount", { count: selectedCount })}</span>
        ) : null}
      </div>
      {blockCount > 0 ? (
        <div className="page-block-list-header-actions">
          <Button
            aria-pressed={reviewOnly}
            onClick={() => onReviewOnlyChange(!reviewOnly)}
            size="sm"
          >
            {t(reviewOnly ? "pageBlocks.showAll" : "pageBlocks.reviewOnly")}
          </Button>
          {blockCount > 1 ? (
            <Button
              className="page-block-order-sort"
              disabled={disabled}
              onClick={onSortReadingOrder}
              size="sm"
            >
              {t("pageBlocks.sortReadingOrder")}
            </Button>
          ) : null}
        </div>
      ) : null}
    </header>
  );
}
