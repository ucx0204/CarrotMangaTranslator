import React from "react";
import type { ConditionalBatchEngineOptions } from "../../../shared/conditionalBatchEngine";
import type { ChapterSnapshot } from "../../../shared/libraryTypes";
import type { GlossaryEntry } from "../../../shared/workContextTypes";
import { useFonts } from "../fonts/useFonts";
import { useBlockFontReadiness } from "../hooks/useBlockFontReadiness";
import { createConditionalBatchFontSizeResolver } from "../lib/conditionalBatchTypography";

export function useConditionalBatchTypography(
  chapter: ChapterSnapshot,
  glossary: readonly GlossaryEntry[],
): { ready: boolean; options: ConditionalBatchEngineOptions } {
  const { catalog, ready: catalogReady = true } = useFonts();
  const blocks = React.useMemo(
    () => chapter.pages.flatMap((page) => page.blocks),
    [chapter],
  );
  const ready = useBlockFontReadiness(blocks, catalog, catalogReady);
  // Never retain measurements made with a fallback face while fonts loaded.
  const options = React.useMemo(
    () => ({
      glossary,
      resolveFontSizePx: ready
        ? createConditionalBatchFontSizeResolver(catalog)
        : undefined,
    }),
    [catalog, glossary, ready],
  );
  return { ready, options };
}
