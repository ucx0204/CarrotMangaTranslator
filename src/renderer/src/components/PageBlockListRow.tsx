import React from "react";
import { IconChevronRight } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { TranslationBlock } from "../../../shared/textTypes";
import { IconButton } from "./ui/IconButton";

export function PageBlockListRow({
  block,
  disabled,
  index,
  selected,
  onOpenEditor,
  onSelect,
  onUpdate,
}: {
  block: TranslationBlock;
  disabled: boolean;
  index: number;
  selected: boolean;
  onOpenEditor: (blockId: string) => void;
  onSelect: (blockId: string) => void;
  onUpdate: (blockId: string, patch: Partial<TranslationBlock>) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <article
      className={`page-block-list-row ${selected ? "selected" : ""}`}
      data-page-block-id={block.id}
      onClick={() => onSelect(block.id)}
    >
      <header className="page-block-list-row-header">
        <span className="page-block-list-index">{index + 1}</span>
        <div className="page-block-list-badges">
          {block.reviewStatus === "needs_review" ? (
            <span className="page-block-badge review">
              {t("pageBlocks.needsReview")}
            </span>
          ) : null}
          {block.textRole === "sound" ? (
            <span className="page-block-badge sound">
              {t("pageBlocks.soundEffect")}
            </span>
          ) : null}
          {block.inpaintExcluded ? (
            <span className="page-block-badge excluded">
              {t("pageBlocks.inpaintExcluded")}
            </span>
          ) : null}
        </div>
        <IconButton
          className="page-block-detail-button"
          size="sm"
          label={t("pageBlocks.openDetails")}
          title={t("pageBlocks.openDetails")}
          onClick={(event) => {
            event.stopPropagation();
            onOpenEditor(block.id);
          }}
        >
          <IconChevronRight size={16} aria-hidden="true" />
        </IconButton>
      </header>
      <label className="page-block-source-field">
        <span>{t("pageBlocks.source")}</span>
        <span className="page-block-source-text">
          {block.sourceText || t("pageBlocks.emptySource")}
        </span>
      </label>
      <label className="page-block-translation-field">
        <span>{t("pageBlocks.translation")}</span>
        <textarea
          data-page-block-translation="true"
          disabled={disabled}
          value={block.translatedText}
          placeholder={t("pageBlocks.translationPlaceholder")}
          onClick={(event) => event.stopPropagation()}
          onFocus={() => onSelect(block.id)}
          onChange={(event) =>
            onUpdate(block.id, { translatedText: event.target.value })
          }
        />
      </label>
    </article>
  );
}
