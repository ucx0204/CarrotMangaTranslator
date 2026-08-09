import React from "react";
import type { MenuPosition, SelectOption } from "./selectTypes";

const MENU_GAP = 6;
const VIEWPORT_MARGIN = 8;
const MENU_MAX_HEIGHT = 360;

export function resolveInitialActiveValue(
  options: readonly SelectOption[],
  selectedValue: string,
): string {
  const selected = options.find(
    (option) => option.value === selectedValue && !option.disabled,
  );
  return (
    selected?.value ?? options.find((option) => !option.disabled)?.value ?? ""
  );
}

export function filterSelectOptions(
  options: readonly SelectOption[],
  query: string,
): SelectOption[] {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return [...options];
  return options.filter((option) =>
    normalizeSearchText(
      option.searchText ?? reactNodeText(option.label),
    ).includes(normalizedQuery),
  );
}

export function reactNodeText(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) return node.map(reactNodeText).join(" ");
  if (React.isValidElement<{ children?: React.ReactNode }>(node)) {
    return reactNodeText(node.props.children);
  }
  return "";
}

export function safeDomId(value: string): string {
  return encodeURIComponent(value).replace(/%/gu, "_");
}

export function resolveMenuPosition(
  trigger: HTMLButtonElement,
  menu: HTMLDivElement,
): MenuPosition {
  const rect = trigger.getBoundingClientRect();
  const width = resolveMenuWidth(rect.width);
  const left = resolveMenuLeft(rect.left, width);
  const measuredHeight = Math.min(menu.scrollHeight, MENU_MAX_HEIGHT);
  const below = window.innerHeight - rect.bottom - MENU_GAP - VIEWPORT_MARGIN;
  const above = rect.top - MENU_GAP - VIEWPORT_MARGIN;
  const openAbove = below < Math.min(measuredHeight, 180) && above > below;
  const availableHeight = openAbove ? above : below;
  const maxHeight = Math.max(120, Math.min(MENU_MAX_HEIGHT, availableHeight));
  const top = openAbove
    ? Math.max(
        VIEWPORT_MARGIN,
        rect.top - MENU_GAP - Math.min(measuredHeight, maxHeight),
      )
    : rect.bottom + MENU_GAP;
  return { left, maxHeight, top, width };
}

export function menuPositionStyle(
  position: MenuPosition | null,
): React.CSSProperties {
  if (!position) return { opacity: 0, pointerEvents: "none" };
  return {
    left: position.left,
    top: position.top,
    width: position.width,
    maxHeight: position.maxHeight,
  };
}

function normalizeSearchText(value: string): string {
  return value.trim().toLocaleLowerCase().normalize("NFKC");
}

function resolveMenuWidth(triggerWidth: number): number {
  return Math.min(
    Math.max(triggerWidth, 220),
    window.innerWidth - VIEWPORT_MARGIN * 2,
  );
}

function resolveMenuLeft(triggerLeft: number, width: number): number {
  return Math.min(
    Math.max(VIEWPORT_MARGIN, triggerLeft),
    Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN),
  );
}
