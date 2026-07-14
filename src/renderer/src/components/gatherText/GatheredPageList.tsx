import React from "react";
import { useTranslation } from "react-i18next";
import { type GatherField, type GatheredPage } from "../../lib/gatherText";
import { buildMatchOffsets, matchOffsetKey } from "../../lib/gatherTextSearch";
import type { GatherTextSearch } from "../../hooks/useGatherTextSearch";
import type { BlockRef } from "../../lib/gatherTextFormat";
import { HighlightedText } from "../HighlightedText";
import { SelectionSurface } from "../ui/SelectionCard";
import type { GatherTextFormatSelection } from "./useGatherTextFormatSelection";

export function GatheredPageList({
  pages,
  field,
  search,
  formatSelection,
  onNavigateToBlock,
}: {
  pages: GatheredPage[];
  field: GatherField;
  search: GatherTextSearch;
  formatSelection: GatherTextFormatSelection | null;
  onNavigateToBlock?: (pageId: string, blockId: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const offsets = React.useMemo(
    () => buildMatchOffsets(pages, field, search.query),
    [field, pages, search.query],
  );
  if (!pages.length) {
    return (
      <p className="muted-line gather-text-empty">{t("gatherText.empty")}</p>
    );
  }
  return (
    <div className="gather-text-list">
      {pages.map((page) => (
        <section key={page.pageId} className="gather-text-page">
          <h3 className="gather-text-page-title">
            {t("gatherText.pageHeading", {
              index: page.index + 1,
              pageName: page.pageName,
            })}
          </h3>
          <div className="gather-text-blocks">
            {page.blocks.map((block) => (
              <GatheredBlock
                key={block.id}
                block={block}
                blockRef={{ pageId: page.pageId, blockId: block.id }}
                field={field}
                formatSelection={formatSelection}
                offsets={offsets}
                search={search}
                onNavigate={
                  onNavigateToBlock
                    ? () => onNavigateToBlock(page.pageId, block.id)
                    : undefined
                }
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function GatheredBlock({
  block,
  blockRef,
  field,
  formatSelection,
  offsets,
  search,
  onNavigate,
}: {
  block: GatheredPage["blocks"][number];
  blockRef: BlockRef;
  field: GatherField;
  formatSelection: GatherTextFormatSelection | null;
  offsets: Map<string, number>;
  search: GatherTextSearch;
  onNavigate?: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const selected = formatSelection?.isSelected(blockRef) ?? false;
  const selectionMode = formatSelection?.isSelectionMode ?? false;
  const blockText = (
    <GatheredBlockText
      block={block}
      field={field}
      offsets={offsets}
      search={search}
    />
  );
  if (!selectionMode) {
    return onNavigate ? (
      <button
        type="button"
        className="gather-text-block clickable"
        title={t("gatherText.navigateToPage")}
        onClick={onNavigate}
      >
        {blockText}
      </button>
    ) : (
      <article className="gather-text-block">{blockText}</article>
    );
  }
  return (
    <SelectionSurface
      as="article"
      className="gather-text-block selection-mode"
      selected={selected}
    >
      <label className="gather-text-block-select-target">
        <SelectionCheckbox
          blockRef={blockRef}
          label={block.translatedText || block.sourceText}
          selected={selected}
          selection={formatSelection}
        />
        {blockText}
      </label>
      <NavigateToBlockButton onNavigate={onNavigate} />
    </SelectionSurface>
  );
}

function SelectionCheckbox({
  blockRef,
  label,
  selected,
  selection,
}: {
  blockRef: BlockRef;
  label: string;
  selected: boolean;
  selection: GatherTextFormatSelection | null;
}): React.JSX.Element | null {
  const { t } = useTranslation("components");
  if (!selection?.isSelectionMode) return null;
  return (
    <input
      className="gather-text-block-checkbox"
      type="checkbox"
      checked={selected}
      aria-label={`${t("gatherText.selectBlock")}: ${label}`}
      onChange={() => selection.toggle(blockRef)}
    />
  );
}

function GatheredBlockText({
  block,
  field,
  offsets,
  search,
}: {
  block: GatheredPage["blocks"][number];
  field: GatherField;
  offsets: Map<string, number>;
  search: GatherTextSearch;
}): React.JSX.Element {
  return (
    <div className="gather-text-block-content">
      {field !== "translated" && block.sourceText ? (
        <p className="gather-text-source">
          <HighlightedText
            text={block.sourceText}
            query={search.query}
            startOrdinal={offsets.get(matchOffsetKey(block.id, "source")) ?? 0}
            activeIndex={search.activeIndex}
            activeRef={search.activeRef}
          />
        </p>
      ) : null}
      {field !== "source" && block.translatedText ? (
        <p className="gather-text-translated">
          <HighlightedText
            text={block.translatedText}
            query={search.query}
            startOrdinal={
              offsets.get(matchOffsetKey(block.id, "translated")) ?? 0
            }
            activeIndex={search.activeIndex}
            activeRef={search.activeRef}
          />
        </p>
      ) : null}
    </div>
  );
}

function NavigateToBlockButton({
  onNavigate,
}: {
  onNavigate?: () => void;
}): React.JSX.Element | null {
  const { t } = useTranslation("components");
  if (!onNavigate) return null;
  return (
    <button
      type="button"
      className="gather-text-block-navigate"
      title={t("gatherText.navigateToPage")}
      aria-label={t("gatherText.navigateToPage")}
      onClick={onNavigate}
    >
      ↗
    </button>
  );
}
