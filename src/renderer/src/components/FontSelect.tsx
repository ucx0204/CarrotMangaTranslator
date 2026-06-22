import React from "react";
import { resolveBlockFontFamily } from "../lib/fonts";
import {
  resolveFontOptionClassName,
  useFontSelectModel,
  type FontOption,
  type FontSelectModel,
  type FontSelectProps,
} from "./fontSelectModel";

export function FontSelect(props: FontSelectProps): React.JSX.Element {
  const { listRef, model, rootRef } = useFontSelectModel(props);
  return <FontSelectView listRef={listRef} model={model} rootRef={rootRef} />;
}

function FontSelectView({
  listRef,
  model,
  rootRef,
}: {
  listRef: React.RefObject<HTMLDivElement | null>;
  model: FontSelectModel;
  rootRef: React.RefObject<HTMLDivElement | null>;
}): React.JSX.Element {
  return (
    <div className={`font-select ${model.open ? "open" : ""}`} ref={rootRef}>
      <FontSelectTrigger model={model} />
      {model.open ? <FontSelectMenu listRef={listRef} model={model} /> : null}
    </div>
  );
}

function FontSelectTrigger({
  model,
}: {
  model: FontSelectModel;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="font-select-trigger"
      disabled={model.disabled}
      aria-haspopup="listbox"
      aria-expanded={model.open}
      onClick={() => model.setOpen((current) => !current)}
      onKeyDown={model.onTriggerKeyDown}
    >
      <span className="font-select-name">{model.selected.label}</span>
      <span
        className="font-select-sample"
        style={{ fontFamily: resolveBlockFontFamily(model.selected.id) }}
      >
        {model.selected.sample}
      </span>
      <ChevronIcon />
    </button>
  );
}

function FontSelectMenu({
  listRef,
  model,
}: {
  listRef: React.RefObject<HTMLDivElement | null>;
  model: FontSelectModel;
}): React.JSX.Element {
  return (
    <div className="font-select-menu">
      <div
        className="font-select-options"
        role="listbox"
        tabIndex={-1}
        ref={listRef}
        onKeyDown={model.onListKeyDown}
      >
        {model.options.map((option, index) => (
          <FontSelectOption
            key={option.id}
            active={index === model.activeIndex}
            busy={model.busy}
            custom={model.customIds.has(option.id)}
            onCommit={model.onOptionCommit}
            onHover={() => model.onOptionHover(index)}
            onRemove={model.onRemoveFont}
            option={option}
            selected={option.id === model.selected.id}
          />
        ))}
      </div>
      <button
        type="button"
        className="font-select-add"
        disabled={model.busy}
        onClick={model.onAddFont}
      >
        + TTF/OTF 폰트 등록
      </button>
    </div>
  );
}

function FontSelectOption({
  active,
  busy,
  custom,
  onCommit,
  onHover,
  onRemove,
  option,
  selected,
}: {
  active: boolean;
  busy: boolean;
  custom: boolean;
  onCommit: (id: string) => void;
  onHover: () => void;
  onRemove: (id: string) => void;
  option: FontOption;
  selected: boolean;
}): React.JSX.Element {
  return (
    <div
      role="option"
      aria-selected={selected}
      className={resolveFontOptionClassName(selected, active)}
      onPointerEnter={onHover}
      onClick={() => onCommit(option.id)}
    >
      <span className="font-select-option-label">{option.label}</span>
      <span
        className="font-select-option-sample"
        style={{ fontFamily: resolveBlockFontFamily(option.id) }}
      >
        {option.sample}
      </span>
      {custom ? (
        <CustomFontRemoveButton
          busy={busy}
          label={option.label}
          onRemove={() => onRemove(option.id)}
        />
      ) : null}
    </div>
  );
}

function CustomFontRemoveButton({
  busy,
  label,
  onRemove,
}: {
  busy: boolean;
  label: string;
  onRemove: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="font-select-remove"
      title="이 폰트 삭제"
      aria-label={`${label} 삭제`}
      disabled={busy}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onRemove();
      }}
    >
      ×
    </button>
  );
}

function ChevronIcon(): React.JSX.Element {
  return (
    <svg
      className="font-select-chevron"
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="m6 9 6 6 6-6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
