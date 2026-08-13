/* eslint-disable max-lines-per-function, complexity, max-depth -- this source is serialized into an isolated untrusted page, so its bounded traversal stays self-contained */
import { WEB_IMPORT_MAX_DISCOVERED_URLS } from "../shared/webImportTypes";
import { canonicalizeWebImageUrl } from "./webImportUrlPolicy";

export type DiscoveredWebImage = {
  url: string;
  y: number;
  x: number;
  discoveryIndex: number;
};

type PageDiscoveryPayload = {
  title: string;
  candidates: DiscoveredWebImage[];
  truncated: boolean;
};

type FrameLocation = {
  frame: WebImportFrame;
  offsetY: number;
  offsetX: number;
  rank: number;
};

export type WebImportFrame = {
  readonly frames: readonly WebImportFrame[];
  isDestroyed: () => boolean;
  executeJavaScript: (script: string) => Promise<unknown>;
};

const FRAME_RECTS_SCRIPT = `(() => Array.from(document.querySelectorAll("iframe, frame"), (element) => {
  const rect = element.getBoundingClientRect();
  return { x: rect.left + window.scrollX, y: rect.top + window.scrollY };
}))()`;

export const WEB_IMPORT_SCROLL_SCRIPT = `(async () => {
  let previousHeight = 0;
  let previousImages = 0;
  let stablePasses = 0;
  for (let step = 0; step < 200; step += 1) {
    const height = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0);
    const images = document.images.length;
    const bottom = Math.min(height, Math.round((step + 1) * Math.max(window.innerHeight * 0.85, 400)));
    window.scrollTo({ top: bottom, behavior: "instant" });
    await new Promise((resolve) => setTimeout(resolve, 120));
    const nextHeight = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0);
    const nextImages = document.images.length;
    const atBottom = window.scrollY + window.innerHeight >= nextHeight - 4;
    if (atBottom && nextHeight === previousHeight && nextImages === previousImages) {
      stablePasses += 1;
    } else {
      stablePasses = 0;
    }
    previousHeight = nextHeight;
    previousImages = nextImages;
    if (stablePasses >= 3) break;
  }
  window.scrollTo({ top: 0, behavior: "instant" });
  await new Promise((resolve) => setTimeout(resolve, 80));
  return true;
})()`;

export const WEB_IMPORT_COLLECT_SCRIPT = `(${collectImagesInPage.toString()})()`;

export async function discoverWebImages(mainFrame: WebImportFrame): Promise<{
  title: string;
  candidates: DiscoveredWebImage[];
  truncated: boolean;
}> {
  const frames = await locateFrames(mainFrame);
  const combined: DiscoveredWebImage[] = [];
  let title = "";
  let truncated = false;
  for (const location of frames) {
    if (location.frame.isDestroyed()) {
      continue;
    }
    try {
      const payload = parsePageDiscoveryPayload(
        await location.frame.executeJavaScript(WEB_IMPORT_COLLECT_SCRIPT),
      );
      if (location.rank === 0) {
        title = payload.title;
      }
      truncated ||= payload.truncated;
      for (const candidate of payload.candidates) {
        combined.push({
          url: candidate.url,
          y: location.offsetY + candidate.y,
          x: location.offsetX + candidate.x,
          discoveryIndex:
            location.rank * WEB_IMPORT_MAX_DISCOVERED_URLS +
            candidate.discoveryIndex,
        });
        if (combined.length >= WEB_IMPORT_MAX_DISCOVERED_URLS) {
          truncated = true;
          break;
        }
      }
    } catch (_error) {
      // error-policy-allow: detached or script-blocked child frames are non-fatal.
      // A detached or script-blocked child frame is non-fatal to top-page discovery.
    }
    if (combined.length >= WEB_IMPORT_MAX_DISCOVERED_URLS) {
      break;
    }
  }
  return {
    title,
    candidates: sortAndDedupeDiscoveredImages(combined),
    truncated,
  };
}

export function sortAndDedupeDiscoveredImages(
  candidates: readonly DiscoveredWebImage[],
): DiscoveredWebImage[] {
  const sorted = [...candidates].sort(
    (left, right) =>
      left.y - right.y ||
      left.x - right.x ||
      left.discoveryIndex - right.discoveryIndex,
  );
  const seen = new Set<string>();
  const result: DiscoveredWebImage[] = [];
  for (const candidate of sorted) {
    const canonical = canonicalizeWebImageUrl(candidate.url);
    if (!canonical || seen.has(canonical)) {
      continue;
    }
    seen.add(canonical);
    result.push({ ...candidate, url: canonical });
  }
  return result;
}

async function locateFrames(
  mainFrame: WebImportFrame,
): Promise<FrameLocation[]> {
  const result: FrameLocation[] = [];
  let rank = 0;
  const visit = async (
    frame: WebImportFrame,
    offsetY: number,
    offsetX: number,
  ): Promise<void> => {
    const location: FrameLocation = { frame, offsetY, offsetX, rank };
    rank += 1;
    result.push(location);
    if (frame.isDestroyed() || frame.frames.length === 0) {
      return;
    }
    let rects: Array<{ x: number; y: number }> = [];
    try {
      const raw = await frame.executeJavaScript(FRAME_RECTS_SCRIPT);
      rects = parseFrameRects(raw);
    } catch (_error) {
      // error-policy-allow: child frames remain independently discoverable.
      // Descendants remain scannable even when their parent frame detaches.
    }
    for (const [index, child] of frame.frames.entries()) {
      const rect = rects[index] ?? { x: 0, y: 0 };
      await visit(child, offsetY + rect.y, offsetX + rect.x);
    }
  };
  await visit(mainFrame, 0, 0);
  return result;
}

function parseFrameRects(value: unknown): Array<{ x: number; y: number }> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (
      !isRecord(entry) ||
      !isFiniteNumber(entry.x) ||
      !isFiniteNumber(entry.y)
    ) {
      return [];
    }
    return [{ x: entry.x, y: entry.y }];
  });
}

function parsePageDiscoveryPayload(value: unknown): PageDiscoveryPayload {
  if (!isRecord(value) || !Array.isArray(value.candidates)) {
    throw new TypeError("Invalid web image discovery payload.");
  }
  const candidates = value.candidates.flatMap((entry) => {
    const discoveryIndex = isRecord(entry) ? entry.discoveryIndex : undefined;
    if (
      !isRecord(entry) ||
      typeof entry.url !== "string" ||
      !isFiniteNumber(entry.y) ||
      !isFiniteNumber(entry.x) ||
      typeof discoveryIndex !== "number" ||
      !Number.isSafeInteger(discoveryIndex) ||
      discoveryIndex < 0
    ) {
      return [];
    }
    return [
      {
        url: entry.url,
        y: entry.y,
        x: entry.x,
        discoveryIndex,
      },
    ];
  });
  return {
    title: typeof value.title === "string" ? value.title.slice(0, 240) : "",
    candidates,
    truncated: value.truncated === true,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function collectImagesInPage(): {
  title: string;
  candidates: Array<{
    url: string;
    y: number;
    x: number;
    discoveryIndex: number;
  }>;
  truncated: boolean;
} {
  const maxCandidates = 5_000;
  const maxElements = 50_000;
  const candidates: Array<{
    url: string;
    y: number;
    x: number;
    discoveryIndex: number;
  }> = [];
  const seen = new Set<string>();
  let discoveryIndex = 0;
  let visitedElements = 0;
  let truncated = false;

  const add = (raw: string | null | undefined, element: Element): void => {
    if (!raw || candidates.length >= maxCandidates) {
      truncated ||= candidates.length >= maxCandidates;
      return;
    }
    let url: URL;
    try {
      url = new URL(raw.trim(), document.baseURI);
    } catch (_error) {
      return;
    }
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      seen.has(url.href)
    ) {
      return;
    }
    seen.add(url.href);
    const rect = element.getBoundingClientRect();
    candidates.push({
      url: url.href,
      y: Math.max(0, rect.top + window.scrollY),
      x: Math.max(0, rect.left + window.scrollX),
      discoveryIndex,
    });
    discoveryIndex += 1;
  };

  const addSrcset = (raw: string | null, element: Element): void => {
    if (!raw) return;
    for (const part of raw.split(",")) {
      const candidate = part.trim().replace(/\s+(?:\d+(?:\.\d+)?[wx])$/i, "");
      add(candidate, element);
    }
  };

  const scanRoot = (root: Document | ShadowRoot): void => {
    const elements = root.querySelectorAll("*");
    for (const element of elements) {
      visitedElements += 1;
      if (visitedElements > maxElements || candidates.length >= maxCandidates) {
        truncated = true;
        return;
      }
      if (element instanceof HTMLImageElement) {
        add(element.currentSrc, element);
        add(element.src, element);
        addSrcset(element.srcset, element);
      } else if (
        element instanceof HTMLInputElement &&
        element.type.toLowerCase() === "image"
      ) {
        add(element.src, element);
      }
      if (element instanceof HTMLSourceElement) {
        addSrcset(element.srcset, element);
      }
      for (const attribute of [
        "data-src",
        "data-original",
        "data-lazy-src",
        "data-url",
      ]) {
        add(element.getAttribute(attribute), element);
      }
      for (const attribute of ["data-srcset", "data-lazy-srcset"]) {
        addSrcset(element.getAttribute(attribute), element);
      }
      if (element instanceof HTMLAnchorElement) {
        try {
          const linked = new URL(element.href, document.baseURI);
          if (/\.(?:jpe?g|png|webp)$/i.test(linked.pathname)) {
            add(linked.href, element);
          }
        } catch (_error) {
          // error-policy-allow: invalid page-authored anchor URLs are ignored.
          // Invalid anchor URLs are ignored.
        }
      }
      const background = getComputedStyle(element).backgroundImage;
      if (background && background !== "none") {
        const matcher = /url\((?:"([^"]+)"|'([^']+)'|([^)]*))\)/g;
        for (const match of background.matchAll(matcher)) {
          add(match[1] || match[2] || match[3], element);
        }
      }
      const shadowRoot = (element as HTMLElement).shadowRoot;
      if (shadowRoot) {
        scanRoot(shadowRoot);
      }
    }
  };

  scanRoot(document);
  return {
    title: document.title || "",
    candidates,
    truncated,
  };
}
