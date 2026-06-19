import React from "react";
import type { ChapterSnapshot, MangaPage } from "../../../shared/types";
import { mangaGateway } from "../api/mangaGateway";
import { toast } from "../lib/toastStore";
import {
  filterPagesByField,
  formatGatheredText,
  gatherText,
  type GatherField,
  type GatherScope,
  type GatheredPage,
} from "../lib/gatherText";
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

  const pages = React.useMemo(
    () => filterPagesByField(gatherText({ chapter, page, scope }), field),
    [chapter, page, scope, field],
  );
  const text = React.useMemo(
    () => formatGatheredText(pages, field),
    [pages, field],
  );
  const hasContent = pages.length > 0;
  const defaultName = buildDefaultName(chapter, page, scope);
  const { handleCopy, handleSave } = useGatherTextActions(text, defaultName);

  return (
    <Modal
      title="텍스트 모아보기"
      size="lg"
      onClose={onClose}
      closeOnBackdrop
      bodyClassName="gather-text-body"
      footer={
        <>
          <Button onClick={() => void handleSave()} disabled={!hasContent}>
            .txt로 저장
          </Button>
          <Button
            variant="primary"
            onClick={() => void handleCopy()}
            disabled={!hasContent}
          >
            복사
          </Button>
        </>
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
      <GatheredPageList pages={pages} field={field} />
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
}: {
  pages: GatheredPage[];
  field: GatherField;
}): React.JSX.Element {
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
              <div key={block.id} className="gather-text-block">
                {field !== "translated" && block.sourceText ? (
                  <p className="gather-text-source">{block.sourceText}</p>
                ) : null}
                {field !== "source" && block.translatedText ? (
                  <p className="gather-text-translated">
                    {block.translatedText}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        </section>
      ))}
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
