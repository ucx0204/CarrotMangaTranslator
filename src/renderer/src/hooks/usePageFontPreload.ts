import React from "react";
import type { MangaPage } from "../../../shared/libraryTypes";
import { FontsContext } from "../fonts/fontsContextValue";
import {
  createBlockFontLoadKey,
  loadBlockFontsForKey,
} from "../lib/blockFontLoading";
import type { BlockFontCatalog } from "../lib/fonts";

/** Load the visible page first, then warm only its neighbors while idle. */
export function usePageFontPreload(
  currentPage: MangaPage | null,
  neighborPages: readonly MangaPage[],
): void {
  const fonts = React.useContext(FontsContext);
  const catalog = fonts?.catalog;
  const ready = fonts?.ready ?? Boolean(fonts);
  const currentLoadKey = React.useMemo(
    () =>
      ready && catalog && currentPage
        ? createBlockFontLoadKey(currentPage.blocks, catalog)
        : null,
    [catalog, currentPage, ready],
  );
  const neighborLoadKeys = React.useMemo(
    () =>
      ready && catalog ? createPageFontLoadKeys(neighborPages, catalog) : [],
    [catalog, neighborPages, ready],
  );

  React.useEffect(() => {
    if (!ready || typeof document === "undefined" || !document.fonts) return;
    let cancelled = false;
    let cancelIdlePreload = (): void => undefined;
    const currentRequest = currentLoadKey
      ? loadBlockFontsForKey(document, currentLoadKey)
      : Promise.resolve();
    void currentRequest
      .then(() => {
        if (cancelled || neighborLoadKeys.length === 0) return;
        cancelIdlePreload = scheduleIdlePreload(() => {
          for (const loadKey of neighborLoadKeys) {
            void loadBlockFontsForKey(document, loadKey).catch(
              (error: unknown) => {
                console.warn("이웃 페이지 글꼴 미리 불러오기 실패", error);
              },
            );
          }
        });
      })
      .catch((error: unknown) => {
        console.warn("현재 페이지 글꼴 미리 불러오기 실패", error);
      });
    return () => {
      cancelled = true;
      cancelIdlePreload();
    };
  }, [currentLoadKey, neighborLoadKeys, ready]);
}

export function createPageFontLoadKeys(
  pages: readonly MangaPage[],
  catalog: BlockFontCatalog,
): string[] {
  return [
    ...new Set(
      pages.map((page) => createBlockFontLoadKey(page.blocks, catalog)),
    ),
  ];
}

function scheduleIdlePreload(callback: () => void): () => void {
  if (typeof window.requestIdleCallback === "function") {
    const requestId = window.requestIdleCallback(callback, { timeout: 600 });
    return () => window.cancelIdleCallback(requestId);
  }
  const timeoutId = window.setTimeout(callback, 0);
  return () => window.clearTimeout(timeoutId);
}
