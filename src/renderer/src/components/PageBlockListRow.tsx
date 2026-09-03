import React from "react";
import {
  IconChevronDown,
  IconChevronRight,
  IconChevronUp,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { TranslationBlock } from "../../../shared/textTypes";
import { Button } from "./ui/Button";
import { IconButton } from "./ui/IconButton";

type PageBlockListRowProps = {
  block: TranslationBlock;
  disabled: boolean;
  expanded: boolean;
  index: number;
  last: boolean;
  selected: boolean;
  onOpenEditor: (blockId: string) => void;
  onMoveEarlier: (blockId: string) => void;
  onMoveLater: (blockId: string) => void;
  onSelect: (
    blockId: string,
    modifiers?: { additive: boolean; range: boolean },
  ) => void;
  onUpdate: (blockId: string, patch: Partial<TranslationBlock>) => void;
};

export function PageBlockListRow({
  block,
  disabled,
  expanded,
  index,
  last,
  selected,
  onOpenEditor,
  onMoveEarlier,
  onMoveLater,
  onSelect,
  onUpdate,
}: PageBlockListRowProps): React.JSX.Element {
  return (
    <article
      className={`page-block-list-row ${selected ? "selected" : ""} ${expanded ? "expanded" : "compact"}`.trim()}
      data-page-block-id={block.id}
      onClick={(event) =>
        onSelect(block.id, {
          additive: event.ctrlKey || event.metaKey,
          range: event.shiftKey,
        })
      }
    >
      <PageBlockListRowHeader
        block={block}
        disabled={disabled}
        index={index}
        last={last}
        onMoveEarlier={onMoveEarlier}
        onMoveLater={onMoveLater}
        onOpenEditor={onOpenEditor}
      />
      {expanded ? (
        <PageBlockTextFields
          block={block}
          disabled={disabled}
          onSelect={onSelect}
          onUpdate={onUpdate}
        />
      ) : (
        <PageBlockCompactSummary block={block} onSelect={onSelect} />
      )}
    </article>
  );
}

function PageBlockCompactSummary({
  block,
  onSelect,
}: Pick<PageBlockListRowProps, "block" | "onSelect">): React.JSX.Element {
  const { t } = useTranslation("components");
  const preview =
    block.translatedText || block.sourceText || t("pageBlocks.emptySource");
  return (
    <Button
      className="page-block-summary-button"
      variant="ghost"
      fullWidth
      aria-expanded={false}
      onClick={(event) => {
        event.stopPropagation();
        onSelect(block.id, {
          additive: event.ctrlKey || event.metaKey,
          range: event.shiftKey,
        });
      }}
    >
      <span className="page-block-summary-kind">
        {t(
          block.translatedText ? "pageBlocks.translation" : "pageBlocks.source",
        )}
      </span>
      <span className="page-block-summary-preview">{preview}</span>
    </Button>
  );
}

function PageBlockListRowHeader({
  block,
  disabled,
  index,
  last,
  onMoveEarlier,
  onMoveLater,
  onOpenEditor,
}: Pick<
  PageBlockListRowProps,
  | "block"
  | "disabled"
  | "index"
  | "last"
  | "onMoveEarlier"
  | "onMoveLater"
  | "onOpenEditor"
>): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <header className="page-block-list-row-header">
      <span className="page-block-list-index">{index + 1}</span>
      <PageBlockBadges block={block} />
      <IconButton
        className="page-block-order-button"
        size="sm"
        disabled={disabled || index === 0}
        label={t("pageBlocks.moveEarlier")}
        title={t("pageBlocks.moveEarlier")}
        onClick={(event) => {
          event.stopPropagation();
          onMoveEarlier(block.id);
        }}
      >
        <IconChevronUp size={15} aria-hidden="true" />
      </IconButton>
      <IconButton
        className="page-block-order-button"
        size="sm"
        disabled={disabled || last}
        label={t("pageBlocks.moveLater")}
        title={t("pageBlocks.moveLater")}
        onClick={(event) => {
          event.stopPropagation();
          onMoveLater(block.id);
        }}
      >
        <IconChevronDown size={15} aria-hidden="true" />
      </IconButton>
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
  );
}

function PageBlockBadges({
  block,
}: {
  block: TranslationBlock;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
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
  );
}

function PageBlockTextFields({
  block,
  disabled,
  onSelect,
  onUpdate,
}: Pick<
  PageBlockListRowProps,
  "block" | "disabled" | "onSelect" | "onUpdate"
>): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <>
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
    </>
  );
}
