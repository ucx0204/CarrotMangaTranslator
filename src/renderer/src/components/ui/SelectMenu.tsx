import React from "react";
import { createPortal } from "react-dom";
import { OverflowTooltipText } from "./OverflowTooltipText";
import type { MenuPosition, SelectOption } from "./selectTypes";
import { menuPositionStyle, reactNodeText, safeDomId } from "./selectUtilities";
import styles from "./Select.module.css";

type SelectMenuProps = {
  activeOptionId: string | undefined;
  activeValue: string;
  ariaLabel: string;
  emptyText: string;
  hasSearch: boolean;
  header?: React.ReactNode;
  footer?: React.ReactNode;
  listboxId: string;
  options: SelectOption[];
  position: MenuPosition | null;
  query: string;
  searchLabel: string;
  selectedValue: string;
  onActiveValueChange: (value: string) => void;
  onCommit: (value: string) => void;
  onNavigationKeyDown: (event: React.KeyboardEvent) => void;
  onQueryChange: (value: string) => void;
};

export const SelectMenu = React.forwardRef<HTMLDivElement, SelectMenuProps>(
  function SelectMenu(
    {
      activeOptionId,
      activeValue,
      ariaLabel,
      emptyText,
      hasSearch,
      header,
      footer,
      listboxId,
      options,
      position,
      query,
      searchLabel,
      selectedValue,
      onActiveValueChange,
      onCommit,
      onNavigationKeyDown,
      onQueryChange,
    },
    menuRef,
  ): React.JSX.Element {
    return createPortal(
      <div
        ref={menuRef}
        className={styles.menu}
        style={menuPositionStyle(position)}
        data-ui-select-menu=""
      >
        {header ? <div className={styles.menuHeader}>{header}</div> : null}
        {hasSearch ? (
          <SelectSearch
            activeOptionId={activeOptionId}
            label={searchLabel}
            listboxId={listboxId}
            query={query}
            onNavigationKeyDown={onNavigationKeyDown}
            onQueryChange={onQueryChange}
          />
        ) : null}
        <SelectOptionList
          activeValue={activeValue}
          ariaLabel={ariaLabel}
          emptyText={emptyText}
          listboxId={listboxId}
          options={options}
          selectedValue={selectedValue}
          onActiveValueChange={onActiveValueChange}
          onCommit={onCommit}
        />
        {footer ? <div className={styles.menuFooter}>{footer}</div> : null}
      </div>,
      document.body,
    );
  },
);

function SelectSearch({
  activeOptionId,
  label,
  listboxId,
  query,
  onNavigationKeyDown,
  onQueryChange,
}: {
  activeOptionId: string | undefined;
  label: string;
  listboxId: string;
  query: string;
  onNavigationKeyDown: (event: React.KeyboardEvent) => void;
  onQueryChange: (value: string) => void;
}): React.JSX.Element {
  const searchRef = React.useRef<HTMLInputElement | null>(null);
  React.useEffect(() => {
    const frame = requestAnimationFrame(() => searchRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <div className={styles.searchWrap}>
      <input
        ref={searchRef}
        type="search"
        className={styles.search}
        value={query}
        aria-label={label}
        aria-controls={listboxId}
        aria-activedescendant={activeOptionId}
        placeholder={label}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={onNavigationKeyDown}
      />
    </div>
  );
}

type SelectOptionListProps = {
  activeValue: string;
  ariaLabel: string;
  emptyText: string;
  listboxId: string;
  options: SelectOption[];
  selectedValue: string;
  onActiveValueChange: (value: string) => void;
  onCommit: (value: string) => void;
};

function SelectOptionList(props: SelectOptionListProps): React.JSX.Element {
  return (
    <div
      id={props.listboxId}
      role="listbox"
      aria-label={props.ariaLabel}
      className={styles.options}
    >
      {props.options.length > 0 ? (
        props.options.map((option, index) => (
          <React.Fragment key={option.value}>
            {shouldShowGroup(props.options, index) ? (
              <div className={styles.groupLabel} role="presentation">
                {option.group}
              </div>
            ) : null}
            <SelectOptionRow
              active={option.value === props.activeValue}
              listboxId={props.listboxId}
              option={option}
              selected={option.value === props.selectedValue}
              onActiveValueChange={props.onActiveValueChange}
              onCommit={props.onCommit}
            />
          </React.Fragment>
        ))
      ) : (
        <div className={styles.empty}>{props.emptyText}</div>
      )}
    </div>
  );
}

function SelectOptionRow({
  active,
  listboxId,
  option,
  selected,
  onActiveValueChange,
  onCommit,
}: {
  active: boolean;
  listboxId: string;
  option: SelectOption;
  selected: boolean;
  onActiveValueChange: (value: string) => void;
  onCommit: (value: string) => void;
}): React.JSX.Element {
  return (
    <div
      id={`${listboxId}-${safeDomId(option.value)}`}
      role="option"
      aria-label={reactNodeText(option.label)}
      aria-selected={selected}
      aria-disabled={option.disabled || undefined}
      data-value={option.value}
      className={optionClassName({
        active,
        disabled: option.disabled,
        selected,
      })}
      onPointerMove={() => {
        if (!option.disabled) onActiveValueChange(option.value);
      }}
      onPointerDown={(event) => event.preventDefault()}
      onClick={() => onCommit(option.value)}
    >
      <span className={styles.optionText}>
        <OverflowTooltipText
          className={styles.optionLabel}
          content={option.tooltip}
        >
          {option.label}
        </OverflowTooltipText>
        {option.description ? (
          <span className={styles.optionDescription}>{option.description}</span>
        ) : null}
      </span>
      {option.preview ? (
        <span className={styles.optionPreview}>{option.preview}</span>
      ) : null}
      {option.actions ? (
        // Row actions must not commit the option, so their events stop here.
        <span
          className={styles.optionActions}
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          onPointerMove={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          {option.actions}
        </span>
      ) : null}
      <span
        className={styles.check}
        aria-hidden="true"
        data-visible={selected || undefined}
      >
        ✓
      </span>
    </div>
  );
}

function shouldShowGroup(options: SelectOption[], index: number): boolean {
  const group = options[index]?.group;
  return Boolean(group && group !== options[index - 1]?.group);
}

function optionClassName({
  active,
  disabled,
  selected,
}: {
  active: boolean;
  disabled: boolean | undefined;
  selected: boolean;
}): string {
  return [
    styles.option,
    active ? styles.optionActive : "",
    selected ? styles.optionSelected : "",
    disabled ? styles.optionDisabled : "",
  ]
    .filter(Boolean)
    .join(" ");
}
