import type React from "react";

export type SelectOption = {
  value: string;
  label: React.ReactNode;
  tooltip?: string;
  group?: string;
  searchText?: string;
  disabled?: boolean;
  description?: React.ReactNode;
  /**
   * Trailing controls for this row, e.g. favourite or delete. Pointer and key
   * events inside are isolated so using them never commits the option.
   */
  actions?: React.ReactNode;
  /** Preview text rendered beside the label, e.g. a font sample. */
  preview?: React.ReactNode;
};

export type SelectProps = {
  ariaLabel: string;
  ariaDescribedBy?: string;
  value: string;
  options: readonly SelectOption[];
  onValueChange: (value: string) => void;
  className?: string;
  disabled?: boolean;
  placeholder?: React.ReactNode;
  searchable?: boolean | "auto";
  searchPlaceholder?: string;
  menuHeader?: React.ReactNode;
  /** Pinned actions below the option list, e.g. "add" / "manage". */
  menuFooter?: React.ReactNode;
  id?: string;
  title?: string;
  /** Extra content rendered in the trigger after the value, e.g. a preview. */
  triggerExtra?: React.ReactNode;
};

export type MenuPosition = {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
};

export type SelectController = {
  activeOptionId: string | undefined;
  activeValue: string;
  close: (restoreFocus?: boolean) => void;
  commit: (value: string) => void;
  handleNavigationKeyDown: (event: React.KeyboardEvent) => void;
  hasSearch: boolean;
  listboxId: string;
  menuRef: React.RefObject<HTMLDivElement | null>;
  open: boolean;
  openMenu: () => void;
  position: MenuPosition | null;
  query: string;
  rootRef: React.RefObject<HTMLDivElement | null>;
  setActiveValue: React.Dispatch<React.SetStateAction<string>>;
  setQuery: React.Dispatch<React.SetStateAction<string>>;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  visibleOptions: SelectOption[];
  value: string;
};
