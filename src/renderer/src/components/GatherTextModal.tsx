import React from "react";
import type { ChapterSnapshot, MangaPage } from "../../../shared/types";
import { mangaGateway } from "../api/mangaGateway";
import { toast } from "../lib/toastStore";
import {
  buildMatchOffsets,
  filterPagesByField,
  formatGatheredText,
  gatherText,
  matchOffsetKey,
  type GatherField,
  type GatherScope,
  type GatheredPage,
} from "../lib/gatherText";
import {
  useGatherTextSearch,
  type GatherTextSearch,
} from "../hooks/useGatherTextSearch";
import { HighlightedText } from "./HighlightedText";
import { Button, Modal } from "./ui";

const SCOPE_OPTIONS: { id: GatherScope; label: string }[] = [
  { id: "page", label: "이 페이지" },
  { id: "chapter", label: "전체 화" },
];

const FIELD_OPTIONS: { id: GatherField; label: string }[] = [
  { id: "both", label: "한국어+OCR" },
  { id: "translated", label: "한국어만" },
  { id: "source", label: "OCR만" },
];

type GatherTextModalProps = {
  chapter: ChapterSnapshot | null;
  page: MangaPage | null;
  onClose: () => void;
};

export function GatherTextModal({
  chapter,
  page,
  onClose,
}: GatherTextModalProps): React.JSX.Element {
  const [scope, setScope] = React.useState<GatherScope>("page");
  const [field, setField] = React.useState<GatherField>("both");
  const [excludeHeaders, setExcludeHeaders] = React.useState(false);

  const pages = React.useMemo(
    () => filterPagesByField(gatherText({ chapter, page, scope }), field),
    [chapter, page, scope, field],
  );
  const text = React.useMemo(
    () => formatGatheredText(pages, field, !excludeHeaders),
    [pages, field, excludeHeaders],
  );
  const hasContent = pages.length > 0;
  const defaultName = buildDefaultName(chapter, page, scope);
  const { handleCopy, handleSave } = useGatherTextActions(text, defaultName);
  const search = useGatherTextSearch(pages, field);

  return (
    <Modal
      title="텍스트 모아보기"
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
          onSave={() => void handleSave()}
          onCopy={() => void handleCopy()}
        />
      }
    >
      <div className="gather-text-controls">
        <SegmentedRow
          label="범위"
          options={SCOPE_OPTIONS}
          value={scope}
          onChange={setScope}
        />
        <SegmentedRow
          label="표시"
          options={FIELD_OPTIONS}
          value={field}
          onChange={setField}
        />
      </div>
      <GatheredPageList pages={pages} field={field} search={search} />
    </Modal>
  );
}

function useGatherTextActions(
  text: string,
  defaultName: string,
): { handleCopy: () => Promise<void>; handleSave: () => Promise<void> } {
  const handleCopy = React.useCallback(async () => {
    if (!text) {
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      toast.success("텍스트를 클립보드에 복사했습니다.");
    } catch (_error) {
      toast.error("클립보드 복사에 실패했습니다.");
    }
  }, [text]);

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
        toast.success("텍스트 파일을 저장했습니다.");
      }
    } catch (_error) {
      toast.error("텍스트 파일 저장에 실패했습니다.");
    }
  }, [text, defaultName]);

  return { handleCopy, handleSave };
}

function GatherTextFooter({
  search,
  excludeHeaders,
  onToggleExcludeHeaders,
  hasContent,
  onSave,
  onCopy,
}: {
  search: GatherTextSearch;
  excludeHeaders: boolean;
  onToggleExcludeHeaders: (value: boolean) => void;
  hasContent: boolean;
  onSave: () => void;
  onCopy: () => void;
}): React.JSX.Element {
  return (
    <div className="gather-text-footer">
      <div className="gather-text-search">
        <input
          type="search"
          value={search.query}
          placeholder="검색 후 Enter"
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
          페이지 머리말 제외
        </label>
        <Button onClick={onSave} disabled={!hasContent}>
          .txt로 저장
        </Button>
        <Button variant="primary" onClick={onCopy} disabled={!hasContent}>
          복사
        </Button>
      </div>
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
}: {
  pages: GatheredPage[];
  field: GatherField;
  search: GatherTextSearch;
}): React.JSX.Element {
  const offsets = React.useMemo(
    () => buildMatchOffsets(pages, field, search.query),
    [pages, field, search.query],
  );
  if (pages.length === 0) {
    return (
      <p className="muted-line gather-text-empty">표시할 텍스트가 없습니다.</p>
    );
  }
  return (
    <div className="gather-text-list">
      {pages.map((page) => (
        <section key={page.pageId} className="gather-text-page">
          <h3 className="gather-text-page-title">
            {page.index + 1}쪽 · {page.pageName}
          </h3>
          <div className="gather-text-blocks">
            {page.blocks.map((block) => (
              <GatheredBlock
                key={block.id}
                block={block}
                field={field}
                search={search}
                offsets={offsets}
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
}: {
  block: GatheredPage["blocks"][number];
  field: GatherField;
  search: GatherTextSearch;
  offsets: Map<string, number>;
}): React.JSX.Element {
  return (
    <div className="gather-text-block">
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
