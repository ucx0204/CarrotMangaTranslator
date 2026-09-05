import React from "react";
import type { TranslationBlock } from "../../../shared/textTypes";
import {
  areBlockFontsReadyForKey,
  createBlockFontLoadKey,
  loadBlockFontsForKey,
} from "../lib/blockFontLoading";
import type { BlockFontCatalog } from "../lib/fonts";

export function useBlockFontReadiness(
  blocks: readonly TranslationBlock[],
  catalog: BlockFontCatalog,
  catalogReady: boolean,
): boolean {
  const loadKey = React.useMemo(
    () => createBlockFontLoadKey(blocks, catalog),
    [blocks, catalog],
  );
  const [settledLoadKey, setSettledLoadKey] = React.useState<string | null>(
    null,
  );
  const fontSetAvailable =
    typeof document !== "undefined" && Boolean(document.fonts);
  const cached =
    catalogReady &&
    fontSetAvailable &&
    areBlockFontsReadyForKey(document, loadKey);
  const ready =
    catalogReady && (!fontSetAvailable || cached || settledLoadKey === loadKey);
  React.useEffect(() => {
    if (!catalogReady || !fontSetAvailable || ready) return;
    if (areBlockFontsReadyForKey(document, loadKey)) {
      setSettledLoadKey(loadKey);
      return;
    }
    let active = true;
    void loadBlockFontsForKey(document, loadKey)
      .then((report) => {
        if (!active) return;
        reportBlockFontLoadIssue(report);
        setSettledLoadKey(loadKey);
      })
      .catch((error: unknown) => {
        if (!active) return;
        console.error("페이지 글꼴을 불러오지 못했습니다.", error);
        // Do not leave the page permanently blank when browser font loading
        // itself fails; render once with the browser's fallback stack.
        setSettledLoadKey(loadKey);
      });
    return () => {
      active = false;
    };
  }, [catalogReady, fontSetAvailable, loadKey, ready]);
  return ready;
}

function reportBlockFontLoadIssue(
  report: Awaited<ReturnType<typeof loadBlockFontsForKey>>,
): void {
  if (report.failures.length === 0 && report.missingFamilies.length === 0) {
    return;
  }
  console.error("일부 페이지 글꼴을 불러오지 못했습니다.", report);
}
