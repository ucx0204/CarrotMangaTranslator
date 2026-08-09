import React from "react";
import { useTranslation } from "react-i18next";
import { OverflowTooltipText } from "./OverflowTooltipText";
import { SelectMenu } from "./SelectMenu";
import type { SelectProps } from "./selectTypes";
import { useSelectController } from "./useSelectController";
import { ChevronDownIcon } from "./icons";
import styles from "./Select.module.css";

/** App-owned, keyboard-accessible single-value combobox. */
export function Select(props: SelectProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const {
    activeOptionId,
    activeValue,
    close,
    commit,
    handleNavigationKeyDown,
    hasSearch,
    listboxId,
    menuRef,
    open,
    openMenu,
    position,
    query,
    rootRef,
    setActiveValue,
    setQuery,
    triggerRef,
    visibleOptions,
  } = useSelectController(props);
  const selected = props.options.find((option) => option.value === props.value);
  const searchLabel = props.searchPlaceholder ?? t("select.search");
  return (
    <div
      ref={rootRef}
      className={rootClassName(props.className, open)}
      data-ui-select=""
    >
      <SelectTrigger
        ref={triggerRef}
        activeOptionId={activeOptionId}
        ariaDescribedBy={props.ariaDescribedBy}
        ariaLabel={props.ariaLabel}
        disabled={props.disabled}
        displayValue={
          selected?.label ?? props.placeholder ?? t("select.placeholder")
        }
        displayTooltip={selected?.tooltip}
        hasSearch={hasSearch}
        id={props.id}
        listboxId={listboxId}
        open={open}
        title={props.title}
        value={props.value}
        onClose={close}
        onKeyDown={handleNavigationKeyDown}
        onOpen={openMenu}
      />
      {open ? (
        <SelectMenu
          ref={menuRef}
          activeOptionId={activeOptionId}
          activeValue={activeValue}
          ariaLabel={props.ariaLabel}
          emptyText={t("select.noResults")}
          hasSearch={hasSearch}
          header={props.menuHeader}
          listboxId={listboxId}
          options={visibleOptions}
          position={position}
          query={query}
          searchLabel={searchLabel}
          selectedValue={props.value}
          onActiveValueChange={setActiveValue}
          onCommit={commit}
          onNavigationKeyDown={handleNavigationKeyDown}
          onQueryChange={setQuery}
        />
      ) : null}
    </div>
  );
}

type SelectTriggerProps = {
  activeOptionId: string | undefined;
  ariaDescribedBy: string | undefined;
  ariaLabel: string;
  disabled: boolean | undefined;
  displayValue: React.ReactNode;
  displayTooltip: string | undefined;
  hasSearch: boolean;
  id: string | undefined;
  listboxId: string;
  open: boolean;
  title: string | undefined;
  value: string;
  onClose: (restoreFocus?: boolean) => void;
  onKeyDown: (event: React.KeyboardEvent) => void;
  onOpen: () => void;
};

const SelectTrigger = React.forwardRef<HTMLButtonElement, SelectTriggerProps>(
  function SelectTrigger(
    {
      activeOptionId,
      ariaDescribedBy,
      ariaLabel,
      disabled,
      displayValue,
      displayTooltip,
      hasSearch,
      id,
      listboxId,
      open,
      title,
      value,
      onClose,
      onKeyDown,
      onOpen,
    },
    triggerRef,
  ): React.JSX.Element {
    return (
      <button
        ref={triggerRef}
        id={id}
        type="button"
        role="combobox"
        className={styles.trigger}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={!hasSearch && open ? activeOptionId : undefined}
        disabled={disabled}
        title={title}
        value={value}
        data-ui-select-trigger=""
        onClick={() => (open ? onClose(false) : onOpen())}
        onKeyDown={onKeyDown}
      >
        <OverflowTooltipText className={styles.value} content={displayTooltip}>
          {displayValue}
        </OverflowTooltipText>
        <ChevronDownIcon
          size={16}
          className={[styles.chevron, open ? styles.chevronOpen : ""]
            .filter(Boolean)
            .join(" ")}
        />
      </button>
    );
  },
);

function rootClassName(className: string | undefined, open: boolean): string {
  return [styles.root, open ? styles.open : "", className ?? ""]
    .filter(Boolean)
    .join(" ");
}
