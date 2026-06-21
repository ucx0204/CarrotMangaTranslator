import React from "react";
import type { TranslationBlock } from "../../../shared/types";
import { normalizeRenderDirection } from "../../../shared/geometry";
import { BlockSpacingFields } from "./BlockSpacingFields";
import { ColorField } from "./ColorField";
import { FontSelect } from "./FontSelect";
import { useStickyTextareaHeight } from "../hooks/useStickyTextareaHeight";
import { Button, FieldSlider, IconButton, RangeInput } from "./ui";
import {
  AlignCenterIcon,
  AlignLeftIcon,
  AlignRightIcon,
  BoldIcon,
  CopyIcon,
  ItalicIcon,
  RestoreIcon,
  TrashIcon,
} from "./ui/icons";

type EditorPanelProps = {
  block: TranslationBlock | null;
  disabled: boolean;
  areaTranslateAvailable?: boolean;
  areaTranslateSelecting?: boolean;
  disableChapterFontApply?: boolean;
  onStartAreaTranslate?: () => void;
  onApplyFont?: (scope: "page" | "chapter", fontFamily?: string) => void;
  onUpdate: (patch: Partial<TranslationBlock>) => void;
  onDelete: () => void;
  onDuplicate: () => void;
};

export function EditorPanel({
  block,
  disabled,
  areaTranslateAvailable = false,
  areaTranslateSelecting = false,
  disableChapterFontApply = false,
  onStartAreaTranslate,
  onApplyFont,
  onUpdate,
  onDelete,
  onDuplicate,
}: EditorPanelProps): React.JSX.Element {
  const [fontFamilyDraft, setFontFamilyDraft] = React.useState<
    string | undefined
  >(block?.fontFamily);

  React.useEffect(() => {
    setFontFamilyDraft(block?.fontFamily);
  }, [block?.id, block?.fontFamily]);

  const { refCallback: translatedTextareaRef, reset: resetTranslatedHeight } =
    useStickyTextareaHeight("editor.textareaHeight.translated");
  const { refCallback: sourceTextareaRef, reset: resetSourceHeight } =
    useStickyTextareaHeight("editor.textareaHeight.source");
  const resetTextareaHeights = React.useCallback(() => {
    resetTranslatedHeight();
    resetSourceHeight();
  }, [resetTranslatedHeight, resetSourceHeight]);

  if (!block) {
    return (
      <section className="editor-panel muted">
        <h2>블록</h2>
        <button
          className={`area-translate-button ${areaTranslateSelecting ? "active" : ""}`}
          disabled={disabled || !areaTranslateAvailable}
          onClick={onStartAreaTranslate}
        >
          {areaTranslateSelecting ? "선택 취소" : "영역 번역"}
        </button>
      </section>
    );
  }

  const outlineColor = resolveColor(block.outlineColor, "#ffffff");
  const autoFitText = block.autoFitText ?? true;
  const fontSizePx = clampFontSize(block.fontSizePx);
  const renderDirection = normalizeRenderDirection(
    block.renderDirection,
    "horizontal",
  );

  return (
    <section className="editor-panel has-block">
      <h2>블록</h2>
      <div className="editor-group">
        <div className="editor-group-head">
          <h3>텍스트</h3>
          <IconButton
            size="sm"
            label="입력칸 높이 초기화"
            title="입력칸 높이 초기화"
            onClick={resetTextareaHeights}
          >
            <RestoreIcon size={14} />
          </IconButton>
        </div>
        <label>
          한국어
          <textarea
            ref={translatedTextareaRef}
            value={block.translatedText}
            disabled={disabled}
            onChange={(event) =>
              onUpdate({ translatedText: event.target.value })
            }
          />
        </label>
        <label>
          OCR
          <textarea
            ref={sourceTextareaRef}
            value={block.sourceText}
            disabled={disabled}
            onChange={(event) => onUpdate({ sourceText: event.target.value })}
          />
        </label>
      </div>
      <div className="editor-group">
        <div className="editor-group-head">
          <h3>서식</h3>
        </div>
        <div className="format-toolbar">
          <div className="block-style-group">
            <IconButton
              label="굵게"
              title="굵게"
              aria-pressed={Boolean(block.bold)}
              disabled={disabled}
              onClick={() => onUpdate({ bold: !block.bold })}
            >
              <BoldIcon size={18} />
            </IconButton>
            <IconButton
              label="기울임꼴"
              title="기울임꼴"
              aria-pressed={Boolean(block.italic)}
              disabled={disabled}
              onClick={() => onUpdate({ italic: !block.italic })}
            >
              <ItalicIcon size={18} />
            </IconButton>
          </div>
          <div className="block-style-group">
            <IconButton
              label="왼쪽 정렬"
              title="왼쪽 정렬"
              aria-pressed={block.textAlign === "left"}
              disabled={disabled}
              onClick={() => onUpdate({ textAlign: "left" })}
            >
              <AlignLeftIcon size={18} />
            </IconButton>
            <IconButton
              label="가운데 정렬"
              title="가운데 정렬"
              aria-pressed={block.textAlign === "center"}
              disabled={disabled}
              onClick={() => onUpdate({ textAlign: "center" })}
            >
              <AlignCenterIcon size={18} />
            </IconButton>
            <IconButton
              label="오른쪽 정렬"
              title="오른쪽 정렬"
              aria-pressed={block.textAlign === "right"}
              disabled={disabled}
              onClick={() => onUpdate({ textAlign: "right" })}
            >
              <AlignRightIcon size={18} />
            </IconButton>
          </div>
          <div className="dir-toggle">
            <button
              type="button"
              aria-pressed={renderDirection === "horizontal"}
              disabled={disabled}
              onClick={() => onUpdate({ renderDirection: "horizontal" })}
            >
              가로
            </button>
            <button
              type="button"
              aria-pressed={renderDirection === "vertical"}
              disabled={disabled}
              onClick={() => onUpdate({ renderDirection: "vertical" })}
            >
              세로
            </button>
          </div>
        </div>
        <div className="font-field">
          <FontSelect
            value={fontFamilyDraft}
            disabled={disabled}
            onChange={(fontFamily) => {
              setFontFamilyDraft(fontFamily);
              onUpdate({ fontFamily });
            }}
          />
          {onApplyFont ? (
            <div className="font-apply-row">
              <span className="font-apply-label">일괄 적용</span>
              <div className="font-apply-buttons">
                <Button
                  size="sm"
                  disabled={disabled}
                  onClick={() => onApplyFont("page", fontFamilyDraft)}
                  title="이 폰트를 이 페이지의 모든 블록에 적용"
                >
                  페이지
                </Button>
                <Button
                  size="sm"
                  disabled={disabled || disableChapterFontApply}
                  onClick={() => onApplyFont("chapter", fontFamilyDraft)}
                  title="이 폰트를 이 화의 모든 페이지·블록에 적용"
                >
                  전체
                </Button>
              </div>
            </div>
          ) : null}
        </div>
        <div className="font-size-row">
          <span className="font-size-label">크기</span>
          <RangeInput
            aria-label="글자 크기"
            min={10}
            max={160}
            step={1}
            value={fontSizePx}
            disabled={disabled || autoFitText}
            onChange={(event) =>
              onUpdate({
                fontSizePx: clampFontSize(Number(event.target.value)),
                autoFitText: false,
              })
            }
          />
          <input
            className="font-size-number"
            type="number"
            aria-label="글자 크기 값"
            min={10}
            max={160}
            step={1}
            value={fontSizePx}
            disabled={disabled || autoFitText}
            onChange={(event) =>
              onUpdate({
                fontSizePx: clampFontSize(Number(event.target.value)),
                autoFitText: false,
              })
            }
          />
          <label className="inline-toggle" title="텍스트 상자에 맞춰 자동 크기">
            <input
              type="checkbox"
              checked={autoFitText}
              disabled={disabled}
              onChange={(event) =>
                onUpdate({ autoFitText: event.target.checked })
              }
            />
            자동
          </label>
        </div>
        <FieldSlider
          label="기울기"
          valueLabel={`${block.rotationDeg ?? 0}°`}
          min={-30}
          max={30}
          step={1}
          value={block.rotationDeg ?? 0}
          disabled={disabled}
          onChange={(event) =>
            onUpdate({ rotationDeg: Number(event.target.value) })
          }
        />
        <FieldSlider
          label="투명도"
          valueLabel={`${Math.round(block.opacity * 100)}%`}
          min={0.1}
          max={1}
          step={0.01}
          value={block.opacity}
          disabled={disabled}
          onChange={(event) =>
            onUpdate({ opacity: Number(event.target.value) })
          }
        />
        <BlockSpacingFields
          block={block}
          disabled={disabled}
          onUpdate={onUpdate}
        />
      </div>
      <div className="editor-group">
        <div className="editor-group-head">
          <h3>색상</h3>
        </div>
        <div className="color-row" aria-label="블록 색상">
          <ColorField
            label="글자색"
            value={resolveColor(block.textColor, "#111111")}
            disabled={disabled}
            onChange={(textColor) => onUpdate({ textColor })}
          />
          <ColorField
            label="외곽선"
            value={outlineColor}
            disabled={disabled}
            onChange={(nextOutlineColor) =>
              onUpdate({ outlineColor: nextOutlineColor })
            }
          />
        </div>
        <FieldSlider
          label="외곽선"
          valueLabel={`${Math.round((block.outlineWidthScale ?? 1) * 100)}%`}
          min={0}
          max={2.5}
          step={0.1}
          value={block.outlineWidthScale ?? 1}
          disabled={disabled}
          onChange={(event) =>
            onUpdate({ outlineWidthScale: Number(event.target.value) })
          }
        />
      </div>
      <div className="block-actions">
        <Button
          fullWidth
          iconLeft={<CopyIcon size={15} />}
          onClick={onDuplicate}
          disabled={disabled}
        >
          복제
        </Button>
        <Button
          variant="danger"
          fullWidth
          iconLeft={<TrashIcon size={15} />}
          onClick={onDelete}
          disabled={disabled}
        >
          삭제
        </Button>
      </div>
    </section>
  );
}

function resolveColor(value: string | undefined, fallback: string): string {
  const text = String(value ?? "").trim();
  return /^#[0-9a-f]{6}$/i.test(text) ? text : fallback;
}

function clampFontSize(value: number): number {
  if (!Number.isFinite(value)) {
    return 24;
  }
  return Math.max(10, Math.min(160, Math.round(value)));
}
