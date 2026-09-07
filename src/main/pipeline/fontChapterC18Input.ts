import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { OverlayItem } from "./types";
import type { FontChapterC18Page } from "./fontChapterC18Types";
import { estimatePageSourceFontSizes } from "./sourceFontSizeEstimator";

export function fontChapterItemIdentity(item: OverlayItem): string {
  return JSON.stringify([
    item.id,
    item.sourceText ?? item.jp ?? "",
    item.direction,
    [item.bbox.x, item.bbox.y, item.bbox.w, item.bbox.h],
  ]);
}

export async function buildFontChapterC18Input(
  entries: readonly FontChapterC18Page[],
  signal: AbortSignal,
) {
  const pages = [];
  const identities = new Map<string, { pageId: string; identity: string }>();
  for (const [index, entry] of entries.entries()) {
    signal.throwIfAborted();
    const pageId = `P${String(index + 1).padStart(6, "0")}`;
    const items = entry.items.filter(isSourceDialogue);
    const estimates = await estimatePageSourceFontSizes({
      enabled: true,
      items,
      page: entry.page,
      signal,
    });
    const candidates = items.map((item, i) => {
      const candidateId = `D${String(i + 1).padStart(6, "0")}`;
      identities.set(`${pageId}/${candidateId}`, {
        pageId: entry.page.id,
        identity: fontChapterItemIdentity(item),
      });
      const { x, y, w, h } = item.bbox;
      return {
        candidateId,
        sourceText: item.sourceText ?? item.jp ?? "",
        direction: item.direction,
        estimate: estimates[i] ?? null,
        bbox: {
          x1: (x * entry.page.width) / 1000,
          y1: (y * entry.page.height) / 1000,
          x2: ((x + w) * entry.page.width) / 1000,
          y2: ((y + h) * entry.page.height) / 1000,
        },
      };
    });
    const bytes = await readFile(entry.page.imagePath);
    pages.push({
      pageId,
      imagePath: entry.page.imagePath,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      width: entry.page.width,
      height: entry.page.height,
      candidates,
    });
  }
  return { pages, identities };
}

function isSourceDialogue(item: OverlayItem): boolean {
  return (
    item.textRole !== "sfx" &&
    !item.fontRole?.startsWith("sfx_") &&
    Boolean((item.sourceText ?? item.jp ?? "").trim())
  );
}
