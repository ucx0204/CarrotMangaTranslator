import React from "react";

type RichTranslationSpecialCharacters = {
  close: () => void;
  id: string;
  open: boolean;
  setOpen: React.Dispatch<React.SetStateAction<boolean>>;
  toggle: () => void;
};

export function useRichTranslationSpecialCharacters(
  blockId: string,
  editorRootRef: React.RefObject<HTMLDivElement | null>,
): RichTranslationSpecialCharacters {
  const [open, setOpen] = React.useState(false);
  const id = React.useId();
  const close = React.useCallback(() => setOpen(false), []);
  const toggle = React.useCallback(() => setOpen((current) => !current), []);
  React.useEffect(close, [blockId, close]);
  useDismissSpecialCharacters(open, editorRootRef, close);
  return { close, id, open, setOpen, toggle };
}

function useDismissSpecialCharacters(
  open: boolean,
  editorRootRef: React.RefObject<HTMLDivElement | null>,
  close: () => void,
): void {
  React.useEffect(() => {
    if (!open) return;
    const document = editorRootRef.current?.ownerDocument;
    if (!document) return;
    const closeOutside = (event: PointerEvent): void => {
      if (!editorRootRef.current?.contains(event.target as Node)) close();
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [close, editorRootRef, open]);
}
