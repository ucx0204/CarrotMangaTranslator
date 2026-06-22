import React from "react";
import { useFonts } from "../fonts/useFonts";
import { normalizeBlockFontFamily, resolveBlockFontOption } from "../lib/fonts";

export type FontSelectProps = {
  value: string | undefined;
  disabled?: boolean;
  onChange: (fontFamily: string | undefined) => void;
};

type FontLibrary = ReturnType<typeof useFonts>;
export type FontOption = FontLibrary["options"][number];

export type FontSelectModel = {
  activeIndex: number;
  busy: boolean;
  customIds: Set<string>;
  disabled: boolean;
  onAddFont: () => void;
  onListKeyDown: (event: React.KeyboardEvent) => void;
  onOptionCommit: (id: string) => void;
  onOptionHover: (index: number) => void;
  onRemoveFont: (id: string) => void;
  onTriggerKeyDown: (event: React.KeyboardEvent) => void;
  open: boolean;
  options: FontOption[];
  selected: FontOption;
  setOpen: React.Dispatch<React.SetStateAction<boolean>>;
};

type FontSelectModelResult = {
  listRef: React.RefObject<HTMLDivElement | null>;
  model: FontSelectModel;
  rootRef: React.RefObject<HTMLDivElement | null>;
};

type FontSelectHandlers = Pick<
  FontSelectModel,
  | "onAddFont"
  | "onListKeyDown"
  | "onOptionCommit"
  | "onOptionHover"
  | "onRemoveFont"
  | "onTriggerKeyDown"
>;

export function useFontSelectModel({
  value,
  disabled = false,
  onChange,
}: FontSelectProps): FontSelectModelResult {
  const { options, customFonts, registerFont, removeFont, busy } = useFonts();
  const customIds = React.useMemo(
    () => new Set(customFonts.map((font) => font.id)),
    [customFonts],
  );
  const selected = resolveBlockFontOption(value);
  const [open, setOpen] = React.useState(false);
  const [activeIndex, setActiveIndex] = React.useState(() =>
    Math.max(
      0,
      options.findIndex((option) => option.id === selected.id),
    ),
  );
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const listRef = React.useRef<HTMLDivElement | null>(null);
  const close = React.useCallback(() => setOpen(false), []);

  useCloseOnOutsidePointer(open, rootRef, close);
  useSelectedFontIndex(open, options, selected.id, setActiveIndex);
  useActiveFontScroll(open, activeIndex, listRef);

  const handlers = useFontSelectHandlers({
    activeIndex,
    close,
    disabled,
    onChange,
    options,
    registerFont,
    removeFont,
    setActiveIndex,
    setOpen,
  });

  return {
    listRef,
    model: {
      activeIndex,
      busy,
      customIds,
      disabled,
      open,
      options,
      selected,
      setOpen,
      ...handlers,
    },
    rootRef,
  };
}

function useFontSelectHandlers({
  activeIndex,
  close,
  disabled,
  onChange,
  options,
  registerFont,
  removeFont,
  setActiveIndex,
  setOpen,
}: {
  activeIndex: number;
  close: () => void;
  disabled: boolean;
  onChange: FontSelectProps["onChange"];
  options: FontOption[];
  registerFont: FontLibrary["registerFont"];
  removeFont: FontLibrary["removeFont"];
  setActiveIndex: React.Dispatch<React.SetStateAction<number>>;
  setOpen: React.Dispatch<React.SetStateAction<boolean>>;
}): FontSelectHandlers {
  const commit = React.useCallback(
    (id: string) => {
      onChange(normalizeBlockFontFamily(id));
      close();
    },
    [onChange, close],
  );
  const onTriggerKeyDown = React.useCallback(
    (event: React.KeyboardEvent) => {
      if (!disabled && isFontSelectOpenKey(event.key)) {
        event.preventDefault();
        setOpen(true);
      }
    },
    [disabled, setOpen],
  );
  const onListKeyDown = React.useCallback(
    (event: React.KeyboardEvent) =>
      handleFontListNavigation(event, {
        activeOptionId: options[activeIndex]?.id,
        close,
        commit,
        optionCount: options.length,
        setActiveIndex,
      }),
    [activeIndex, close, commit, options, setActiveIndex],
  );
  const onAddFont = React.useCallback(() => {
    close();
    void registerFont();
  }, [close, registerFont]);
  const onRemoveFont = React.useCallback(
    (id: string) => {
      void removeFont(id);
    },
    [removeFont],
  );

  return {
    onAddFont,
    onListKeyDown,
    onOptionCommit: commit,
    onOptionHover: setActiveIndex,
    onRemoveFont,
    onTriggerKeyDown,
  };
}

function useCloseOnOutsidePointer(
  open: boolean,
  rootRef: React.RefObject<HTMLDivElement | null>,
  close: () => void,
): void {
  React.useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        close();
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open, close, rootRef]);
}

function useSelectedFontIndex(
  open: boolean,
  options: FontOption[],
  selectedId: string,
  setActiveIndex: React.Dispatch<React.SetStateAction<number>>,
): void {
  React.useEffect(() => {
    if (open) {
      setActiveIndex(
        Math.max(
          0,
          options.findIndex((option) => option.id === selectedId),
        ),
      );
    }
  }, [open, selectedId, options, setActiveIndex]);
}

function useActiveFontScroll(
  open: boolean,
  activeIndex: number,
  listRef: React.RefObject<HTMLDivElement | null>,
): void {
  React.useEffect(() => {
    if (!open || !listRef.current) {
      return;
    }
    const node = listRef.current.children[activeIndex] as
      | HTMLElement
      | undefined;
    node?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex, listRef]);
}

function handleFontListNavigation(
  event: React.KeyboardEvent,
  options: {
    activeOptionId: string | undefined;
    close: () => void;
    commit: (id: string) => void;
    optionCount: number;
    setActiveIndex: React.Dispatch<React.SetStateAction<number>>;
  },
): void {
  if (event.key === "Escape") {
    event.preventDefault();
    options.close();
    return;
  }
  if (event.key === "ArrowDown") {
    event.preventDefault();
    options.setActiveIndex((index) =>
      Math.min(options.optionCount - 1, index + 1),
    );
    return;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    options.setActiveIndex((index) => Math.max(0, index - 1));
    return;
  }
  handleFontListPositionKey(event, options);
}

function handleFontListPositionKey(
  event: React.KeyboardEvent,
  options: {
    activeOptionId: string | undefined;
    commit: (id: string) => void;
    optionCount: number;
    setActiveIndex: React.Dispatch<React.SetStateAction<number>>;
  },
): void {
  if (event.key === "Home") {
    event.preventDefault();
    options.setActiveIndex(0);
    return;
  }
  if (event.key === "End") {
    event.preventDefault();
    options.setActiveIndex(options.optionCount - 1);
    return;
  }
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    if (options.activeOptionId) {
      options.commit(options.activeOptionId);
    }
  }
}

function isFontSelectOpenKey(key: string): boolean {
  return (
    key === "ArrowDown" || key === "ArrowUp" || key === "Enter" || key === " "
  );
}

export function resolveFontOptionClassName(
  selected: boolean,
  active: boolean,
): string {
  return [
    "font-select-option",
    selected ? "selected" : "",
    active ? "active" : "",
  ]
    .filter(Boolean)
    .join(" ");
}
