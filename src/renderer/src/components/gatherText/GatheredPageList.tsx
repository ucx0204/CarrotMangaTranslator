import React from "react";
import { useTranslation } from "react-i18next";
import { type GatherField, type GatheredPage } from "../../lib/gatherText";
import { buildMatchOffsets, matchOffsetKey } from "../../lib/gatherTextSearch";
import type { GatherTextSearch } from "../../hooks/useGatherTextSearch";
import { HighlightedText } from "../HighlightedText";

export function GatheredPageList({
  pages,
  field,
  search,
  onNavigateToBlock,
}: {
  pages: GatheredPage[];
  field: GatherField;
  search: GatherTextSearch;
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
                field={field}
                search={search}
                offsets={offsets}
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
  field,
  search,
  offsets,
  onNavigate,
}: {
  block: GatheredPage["blocks"][number];
  field: GatherField;
  search: GatherTextSearch;
  offsets: Map<string, number>;
  onNavigate?: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const content = (
    <>
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
    </>
  );
  return onNavigate ? (
    <button
      type="button"
      className="gather-text-block clickable"
      title={t("gatherText.navigateToPage")}
      onClick={onNavigate}
    >
      {content}
    </button>
  ) : (
    <div className="gather-text-block">{content}</div>
  );
}
