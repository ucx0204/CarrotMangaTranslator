import React from "react";
import type { ConditionalBatchEngineOptions } from "../../../shared/conditionalBatchEngine";
import type { ConditionalBatchSchemeDraftV2 } from "../../../shared/conditionalBatchRules";
import type { ChapterSnapshot } from "../../../shared/libraryTypes";
import type { GlossaryEntry } from "../../../shared/workContextTypes";
import { useFonts } from "../fonts/useFonts";
import { useBlockFontReadinessForKey } from "../hooks/useBlockFontReadiness";
import {
  createConditionalBatchFontSizeResolver,
  createConditionalBatchTypographyLoadKey,
} from "../lib/conditionalBatchTypography";

export function useConditionalBatchTypography(
  chapter: ChapterSnapshot,
  glossary: readonly GlossaryEntry[],
  schemes: readonly ConditionalBatchSchemeDraftV2[],
): { ready: boolean; options: ConditionalBatchEngineOptions } {
  const { catalog, ready: catalogReady = true } = useFonts();
  const loadKey = React.useMemo(
    () => createConditionalBatchTypographyLoadKey(chapter, schemes, catalog),
    [chapter, schemes, catalog],
  );
  const ready = useBlockFontReadinessForKey(loadKey, catalogReady);
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
