import type React from "react";

export type SelectOption = {
  value: string;
  label: React.ReactNode;
  tooltip?: string;
  group?: string;
  searchText?: string;
  disabled?: boolean;
  description?: React.ReactNode;
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
  id?: string;
  title?: string;
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
