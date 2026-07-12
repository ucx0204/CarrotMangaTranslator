/* eslint-disable max-lines, max-lines-per-function */
import React from "react";
import { useTranslation } from "react-i18next";
import type { ChapterSnapshot, MangaPage } from "../../../shared/libraryTypes";
import type { ReviewExportFormat } from "../../../shared/reviewTypes";
import { mangaGateway } from "../api/mangaGateway";
import { toast } from "../lib/toastStore";
import {
  buildTranslatedTextImport,
  decodeImportedTextContent,
  filterPagesByField,
  formatGatheredText,
  gatherText,
  type GatherField,
  type GatherScope,
  type GatheredPage,
  type TranslatedTextImportUpdate,
} from "../lib/gatherText";
import { buildMatchOffsets, matchOffsetKey } from "../lib/gatherTextSearch";
import {
  useGatherTextSearch,
  type GatherTextSearch,
} from "../hooks/useGatherTextSearch";
import { HighlightedText } from "./HighlightedText";
import { Button, Modal } from "./ui";

type GatherTextModalProps = {
  chapter: ChapterSnapshot | null;
  page: MangaPage | null;
  onClose: () => void;
  onChapterUpdated?: (chapter: ChapterSnapshot) => void;
  onApplyTranslatedText?: (updates: TranslatedTextImportUpdate[]) => void;
  onNavigateToBlock?: (pageId: string, blockId: string) => void;
  readingDirection?: "ltr" | "rtl";
};

export function GatherTextModal({
  chapter,
  page,
  onClose,
  onChapterUpdated,
  onApplyTranslatedText,
  onNavigateToBlock,
  readingDirection = "rtl",
}: GatherTextModalProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const [scope, setScope] = React.useState<GatherScope>("page");
  const [field, setField] = React.useState<GatherField>("both");
  const [excludeHeaders, setExcludeHeaders] = React.useState(false);
  const [reviewWarnings, setReviewWarnings] = React.useState<string[]>([]);
  const [reviewBusy, setReviewBusy] = React.useState(false);
  const reviewFileInputRef = React.useRef<HTMLInputElement | null>(null);
  const txtFileInputRef = React.useRef<HTMLInputElement | null>(null);

  const pages = React.useMemo(
    () =>
      filterPagesByField(
        gatherText({ chapter, page, scope, direction: readingDirection }),
        field,
      ),
    [chapter, page, scope, field, readingDirection],
  );
  const text = React.useMemo(
    () => formatGatheredText(pages, field, !excludeHeaders),
    [pages, field, excludeHeaders],
  );
  const hasContent = pages.length > 0;
  const defaultName = buildDefaultName(chapter, page, scope);
  const { handleCopy, handleSave } = useGatherTextActions(text, defaultName);
  const { handleExportReview, handleImportReviewFile } = useReviewTextActions({
    chapter,
    onChapterUpdated,
    setReviewBusy,
    setReviewWarnings,
  });
  const handleImportTxtFile = useTxtImportAction({
    chapter,
    page,
    scope,
    readingDirection,
    onApplyTranslatedText,
    setReviewWarnings,
  });
  const search = useGatherTextSearch(pages, field);

  return (
    <Modal
      title={t("gatherText.title")}
      size="lg"
      onClose={onClose}
      closeOnBackdrop
      bodyClassName="gather-text-body"
      footer={
        <GatherTextFooter
          search={search}
          excludeHeaders={excludeHeaders}
          onToggleExcludeHeaders={setExcludeHeaders}
          hasContent={hasContent}
          hasChapter={Boolean(chapter)}
          canImportTxt={Boolean(onApplyTranslatedText)}
          reviewBusy={reviewBusy}
          onSave={() => void handleSave()}
          onCopy={() => void handleCopy()}
          onExportReview={(format) => void handleExportReview(format)}
          onImportReview={() => reviewFileInputRef.current?.click()}
          onImportTxt={() => txtFileInputRef.current?.click()}
        />
      }
    >
      <input
        ref={reviewFileInputRef}
        type="file"
        accept=".csv,.tsv,text/csv,text/tab-separated-values"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) {
            void handleImportReviewFile(file);
          }
        }}
      />
      <input
        ref={txtFileInputRef}
        type="file"
        accept=".txt,text/plain"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) {
            void handleImportTxtFile(file);
          }
        }}
      />
      <div className="gather-text-controls">
        <SegmentedRow
          label={t("gatherText.scope")}
          options={
            [
              { id: "page", label: t("common.thisPage") },
              { id: "chapter", label: t("gatherText.entireChapter") },
            ] satisfies { id: GatherScope; label: string }[]
          }
          value={scope}
          onChange={setScope}
        />
        <SegmentedRow
          label={t("gatherText.display")}
          options={
            [
              { id: "both", label: t("gatherText.fields.both") },
              { id: "translated", label: t("gatherText.fields.translated") },
              { id: "source", label: t("gatherText.fields.source") },
            ] satisfies { id: GatherField; label: string }[]
          }
          value={field}
          onChange={setField}
        />
      </div>
      {reviewWarnings.length > 0 ? (
        <details className="gather-review-warnings">
          <summary>
            {t("gatherText.reviewWarnings", {
              count: reviewWarnings.length,
            })}
          </summary>
          <ul>
            {reviewWarnings.slice(0, 80).map((warning, index) => (
              <li key={`${warning}-${index}`}>{warning}</li>
            ))}
          </ul>
        </details>
      ) : null}
      <GatheredPageList
        pages={pages}
        field={field}
        search={search}
        onNavigateToBlock={onNavigateToBlock}
      />
    </Modal>
  );
}

/**
 * Re-imports a "번역문만" txt export: parses the page headers, maps each line
 * back onto the translated blocks in reading order, and overwrites only the
 * lines that changed.
 */
function useTxtImportAction({
  chapter,
  page,
  scope,
  readingDirection,
  onApplyTranslatedText,
  setReviewWarnings,
}: {
  chapter: ChapterSnapshot | null;
  page: MangaPage | null;
  scope: GatherScope;
  readingDirection: "ltr" | "rtl";
  onApplyTranslatedText?: (updates: TranslatedTextImportUpdate[]) => void;
  setReviewWarnings: (warnings: string[]) => void;
}): (file: File) => Promise<void> {
  const { t } = useTranslation("components");
  const { t: tRenderer } = useTranslation("renderer");
  return React.useCallback(
    async (file: File) => {
      if (!chapter || !onApplyTranslatedText) {
        return;
      }
      try {
        const content = decodeImportedTextContent(await file.arrayBuffer());
        const translatedPages = filterPagesByField(
          gatherText({ chapter, page, scope, direction: readingDirection }),
          "translated",
        );
        const result = buildTranslatedTextImport(
          translatedPages,
          content,
          tRenderer,
        );
        setReviewWarnings(result.warnings);
        if (result.updates.length === 0) {
          toast.info(
            result.matchedPageCount > 0
              ? t("gatherText.importTxt.noChanges")
              : t("gatherText.importTxt.noApplicableText"),
          );
          return;
        }
        const confirmed = window.confirm(
          t("gatherText.importTxt.confirm", {
            count: result.updates.length,
          }),
        );
        if (!confirmed) {
          return;
        }
        onApplyTranslatedText(result.updates);
        toast.success(
          t("gatherText.importTxt.updated", {
            count: result.updates.length,
          }),
        );
        if (result.warnings.length > 0) {
          toast.info(
            t("gatherText.importTxt.warnings", {
              count: result.warnings.length,
            }),
          );
        }
      } catch (error) {
        console.error(error);
        toast.error(t("gatherText.importTxt.failed"));
      }
    },
    [
      chapter,
      onApplyTranslatedText,
      page,
      readingDirection,
      scope,
      setReviewWarnings,
      t,
      tRenderer,
    ],
  );
}

function useGatherTextActions(
  text: string,
  defaultName: string,
): { handleCopy: () => Promise<void>; handleSave: () => Promise<void> } {
  const { t } = useTranslation("components");
  const handleCopy = React.useCallback(async () => {
    if (!text) {
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t("gatherText.copySuccess"));
    } catch (_error) {
      toast.error(t("gatherText.copyFailed"));
    }
  }, [t, text]);

  const handleSave = React.useCallback(async () => {
    if (!text) {
      return;
    }
    try {
      const result = await mangaGateway.saveTextFile({
        defaultName,
        content: text,
      });
      if (result?.saved) {
        toast.success(t("gatherText.saveSuccess"));
      }
    } catch (_error) {
      toast.error(t("gatherText.saveFailed"));
    }
  }, [defaultName, t, text]);

  return { handleCopy, handleSave };
}

function useReviewTextActions({
  chapter,
  onChapterUpdated,
  setReviewBusy,
  setReviewWarnings,
}: {
  chapter: ChapterSnapshot | null;
  onChapterUpdated?: (chapter: ChapterSnapshot) => void;
  setReviewBusy: (busy: boolean) => void;
  setReviewWarnings: (warnings: string[]) => void;
}): {
  handleExportReview: (format: ReviewExportFormat) => Promise<void>;
  handleImportReviewFile: (file: File) => Promise<void>;
} {
  const { t } = useTranslation("components");
  const handleExportReview = React.useCallback(
    async (format: ReviewExportFormat) => {
      if (!chapter) {
        return;
      }
      try {
        const result = await mangaGateway.exportReviewText({
          chapterId: chapter.id,
          format,
          includeBom: true,
        });
        if (result?.saved) {
          toast.success(t("gatherText.review.saveSuccess"));
        }
      } catch (error) {
        console.error(error);
        toast.error(t("gatherText.review.saveFailed"));
      }
    },
    [chapter, t],
  );

  const handleImportReviewFile = React.useCallback(
    async (file: File) => {
      if (!chapter) {
        return;
      }
      const confirmed = window.confirm(t("gatherText.review.importConfirm"));
      if (!confirmed) {
        return;
      }
      setReviewBusy(true);
      setReviewWarnings([]);
      try {
        const content = decodeImportedTextContent(await file.arrayBuffer());
        const result = await mangaGateway.importReviewText({
          chapterId: chapter.id,
          content,
          format: file.name.toLowerCase().endsWith(".tsv") ? "tsv" : "csv",
          updateSourceText: false,
          requireSourceMatch: false,
        });
        onChapterUpdated?.(result.chapter);
        setReviewWarnings(result.warnings);
        toast.success(
          t("gatherText.review.updated", {
            count: result.updatedBlockCount,
          }),
        );
        if (result.warnings.length > 0) {
          toast.info(
            t("gatherText.review.warnings", {
              count: result.warnings.length,
            }),
          );
        }
      } catch (error) {
        console.error(error);
        toast.error(t("gatherText.review.importFailed"));
      } finally {
        setReviewBusy(false);
      }
    },
    [chapter, onChapterUpdated, setReviewBusy, setReviewWarnings, t],
  );

  return { handleExportReview, handleImportReviewFile };
}

function GatherTextFooter({
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
}: {
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
}): React.JSX.Element {
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
}: {
  hasChapter: boolean;
  reviewBusy: boolean;
  onExportReview: (format: ReviewExportFormat) => void;
  onImportReview: () => void;
}): React.JSX.Element {
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

function SegmentedRow<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { id: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}): React.JSX.Element {
  return (
    <div className="gather-text-control">
      <span>{label}</span>
      <div className="settings-mode-group" role="tablist" aria-label={label}>
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            className={`settings-preset-button ${value === option.id ? "active" : ""}`}
            aria-pressed={value === option.id}
            onClick={() => onChange(option.id)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function GatheredPageList({
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
    [pages, field, search.query],
  );
  if (pages.length === 0) {
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
  if (!onNavigate) {
    return <div className="gather-text-block">{content}</div>;
  }
  return (
    <button
      type="button"
      className="gather-text-block clickable"
      title={t("gatherText.navigateToPage")}
      onClick={onNavigate}
    >
      {content}
    </button>
  );
}

function buildDefaultName(
  chapter: ChapterSnapshot | null,
  page: MangaPage | null,
  scope: GatherScope,
): string {
  const base = chapter?.title?.trim() || "manga-text";
  if (scope === "page" && page) {
    return `${base} - ${page.name}`;
  }
  return base;
}
