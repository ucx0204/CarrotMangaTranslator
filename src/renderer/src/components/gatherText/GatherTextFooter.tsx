import React from "react";
import { useTranslation } from "react-i18next";
import type { ReviewExportFormat } from "../../../../shared/reviewTypes";
import type { GatherTextSearch } from "../../hooks/useGatherTextSearch";
import { Button } from "../ui/Button";

type GatherTextFooterProps = {
  search: GatherTextSearch;
  excludeHeaders: boolean;
  onToggleExcludeHeaders: (value: boolean) => void;
  hasContent: boolean;
  hasChapter: boolean;
  canImportTxt: boolean;
  reviewBusy: boolean;
  onSave: () => void;
  onCopy: () => void;
  onExportReview: (format: ReviewExportFormat) => void;
  onImportReview: () => void;
  onImportTxt: () => void;
};

export function GatherTextFooter({
  search,
  excludeHeaders,
  onToggleExcludeHeaders,
  hasContent,
  hasChapter,
  canImportTxt,
  reviewBusy,
  onSave,
  onCopy,
  onExportReview,
  onImportReview,
  onImportTxt,
}: GatherTextFooterProps): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="gather-text-footer">
      <div className="gather-text-search">
        <input
          type="search"
          value={search.query}
          placeholder={t("gatherText.searchPlaceholder")}
          onChange={(event) => search.setQuery(event.target.value)}
          onKeyDown={search.handleKeyDown}
        />
        {search.query ? (
          <span className="gather-text-search-count">
            {Math.min(search.activeIndex + 1, search.matchCount)}/
            {search.matchCount}
          </span>
        ) : null}
      </div>
      <div className="gather-text-footer-actions">
        <label className="inline-toggle">
          <input
            type="checkbox"
            checked={excludeHeaders}
            onChange={(event) => onToggleExcludeHeaders(event.target.checked)}
          />
          {t("gatherText.excludePageHeaders")}
        </label>
        <ReviewTableActions
          hasChapter={hasChapter}
          reviewBusy={reviewBusy}
          onExportReview={onExportReview}
          onImportReview={onImportReview}
        />
        <div className="gather-text-action-group">
          <Button onClick={onSave} disabled={!hasContent}>
            {t("gatherText.saveTxt")}
          </Button>
          <Button
            onClick={onImportTxt}
            disabled={!hasChapter || !canImportTxt}
            title={t("gatherText.importTxt.title")}
          >
            {t("gatherText.importTxt.button")}
          </Button>
          <Button variant="primary" onClick={onCopy} disabled={!hasContent}>
            {t("common.copy")}
          </Button>
        </div>
      </div>
    </div>
  );
}

function ReviewTableActions({
  hasChapter,
  reviewBusy,
  onExportReview,
  onImportReview,
}: Pick<
  GatherTextFooterProps,
  "hasChapter" | "reviewBusy" | "onExportReview" | "onImportReview"
>): React.JSX.Element {
  const { t } = useTranslation("components");
  const disabled = !hasChapter || reviewBusy;
  return (
    <div className="gather-text-action-group review">
      <span className="gather-text-group-label">
        {t("gatherText.review.title")}
      </span>
      <Button
        size="sm"
        aria-label={t("gatherText.review.exportCsv")}
        onClick={() => onExportReview("csv")}
        disabled={disabled}
      >
        CSV
      </Button>
      <Button
        size="sm"
        aria-label={t("gatherText.review.exportTsv")}
        onClick={() => onExportReview("tsv")}
        disabled={disabled}
      >
        TSV
      </Button>
      <Button size="sm" onClick={onImportReview} disabled={disabled}>
        {t("common.import")}
      </Button>
    </div>
  );
}
