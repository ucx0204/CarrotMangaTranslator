import { useCallback, useState } from "react";
import type { InpaintingMaskStroke } from "../../../../shared/inpaintingTypes";
import type { InpaintingTool } from "../../inpainting/inpaintingTypes";

export function useAppSessionUiState() {
  const [inpaintingMode, setInpaintingMode] = useState(false);
  const [inpaintingGuideOpen, setInpaintingGuideOpen] = useState(false);
  const [inpaintingTool, setInpaintingTool] = useState<InpaintingTool>("none");
  const [inpaintingBrushRadius, setInpaintingBrushRadius] = useState(28);
  const [inpaintingPaintColor, setInpaintingPaintColor] = useState("#ffffff");
  const [peekOriginal, setPeekOriginal] = useState(false);
  const [patternMaskStrokesByPage, setPatternMaskStrokesByPage] = useState<
    Record<string, InpaintingMaskStroke[]>
  >({});
  const [showBlockChrome, setShowBlockChrome] = useState(true);
  const [showTextBlocks, setShowTextBlocks] = useState(true);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  const [textViewOpen, setTextViewOpen] = useState(false);
  const [styleGuideOpen, setStyleGuideOpen] = useState(false);
  const [translateOptionsOpen, setTranslateOptionsOpen] = useState(false);
  const [translationFlowActive, setTranslationFlowActive] = useState(false);

  const resetChapterScopedUi = useCallback(() => {
    setInpaintingMode(false);
    setInpaintingGuideOpen(false);
    setStyleGuideOpen(false);
    setTranslateOptionsOpen(false);
    setPatternMaskStrokesByPage({});
  }, []);

  return {
    commandPaletteOpen,
    inpaintingBrushRadius,
    inpaintingGuideOpen,
    inpaintingMode,
    inpaintingPaintColor,
    inpaintingTool,
    patternMaskStrokesByPage,
    peekOriginal,
    resetChapterScopedUi,
    setCommandPaletteOpen,
    setInpaintingBrushRadius,
    setInpaintingGuideOpen,
    setInpaintingMode,
    setInpaintingPaintColor,
    setInpaintingTool,
    setPatternMaskStrokesByPage,
    setPeekOriginal,
    setShortcutHelpOpen,
    setShowBlockChrome,
    setShowTextBlocks,
    setStyleGuideOpen,
    setTextViewOpen,
    setTranslateOptionsOpen,
    setTranslationFlowActive,
    shortcutHelpOpen,
    showBlockChrome,
    showTextBlocks,
    styleGuideOpen,
    textViewOpen,
    translateOptionsOpen,
    translationFlowActive,
  };
}
