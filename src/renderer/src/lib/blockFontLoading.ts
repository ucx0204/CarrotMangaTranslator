import {
  DEFAULT_BLOCK_FONT_ID,
  isBuiltInBlockFontId,
} from "../../../shared/blockFontCatalog";
import { parseRichText } from "../../../shared/richTextMarkup";
import type { TranslationBlock } from "../../../shared/textTypes";
import {
  normalizeBlockFontFamily,
  resolveBlockFontFamily,
  type BlockFontCatalog,
} from "./fonts";

type BlockFontLoadRequest = {
  css: string;
  family: string;
  required: boolean;
};

export type BlockFontLoadReport = {
  failures: Array<{ css: string; error: unknown }>;
  missingFamilies: string[];
};

type BlockFontSet = {
  load: (font: string, text?: string) => Promise<FontFace[]>;
};

type BlockFontDocument = {
  fonts: BlockFontSet;
};

type BlockFontRequestOutcome = {
  faces?: FontFace[];
  error?: unknown;
};

type BlockFontRequestEntry = {
  status: "loading" | "ready";
  promise: Promise<BlockFontRequestOutcome>;
};

const BLOCK_FONT_LOAD_SAMPLE = "Aa가나다漢字かな";
const requestCacheByDocument = new WeakMap<
  BlockFontDocument,
  Map<string, BlockFontRequestEntry>
>();

export function createBlockFontLoadKey(
  blocks: readonly TranslationBlock[],
  catalog: BlockFontCatalog,
): string {
  return JSON.stringify(collectBlockFontLoadRequests(blocks, catalog));
}

export async function loadBlockFonts(
  targetDocument: BlockFontDocument,
  blocks: readonly TranslationBlock[],
  catalog: BlockFontCatalog,
): Promise<BlockFontLoadReport> {
  return loadBlockFontsForKey(
    targetDocument,
    createBlockFontLoadKey(blocks, catalog),
  );
}

export async function loadBlockFontsForKey(
  targetDocument: BlockFontDocument,
  loadKey: string,
): Promise<BlockFontLoadReport> {
  const requests = parseBlockFontLoadKey(loadKey);
  const outcomes = await Promise.all(
    requests.map((request) =>
      loadBlockFontRequest(targetDocument, request.css),
    ),
  );
  const failures: BlockFontLoadReport["failures"] = [];
  const missingFamilies = new Set<string>();
  requests.forEach((request, index) => {
    const outcome = outcomes[index] as BlockFontRequestOutcome;
    if ("error" in outcome) {
      failures.push({ css: request.css, error: outcome.error });
      return;
    }
    if (request.required && outcome.faces?.length === 0) {
      missingFamilies.add(request.family);
    }
  });
  return { failures, missingFamilies: [...missingFamilies] };
}

/** True only after every concrete face request in the key has settled. */
export function areBlockFontsReadyForKey(
  targetDocument: BlockFontDocument,
  loadKey: string,
): boolean {
  const requests = parseBlockFontLoadKey(loadKey);
  if (requests.length === 0) return true;
  const cache = requestCacheByDocument.get(targetDocument);
  return Boolean(
    cache &&
    requests.every((request) => cache.get(request.css)?.status === "ready"),
  );
}

/** Font declarations can change when the custom-font library is refreshed. */
export function clearBlockFontLoadCache(
  targetDocument: BlockFontDocument,
): void {
  requestCacheByDocument.delete(targetDocument);
}

function loadBlockFontRequest(
  targetDocument: BlockFontDocument,
  css: string,
): Promise<BlockFontRequestOutcome> {
  let cache = requestCacheByDocument.get(targetDocument);
  if (!cache) {
    cache = new Map();
    requestCacheByDocument.set(targetDocument, cache);
  }
  const existing = cache.get(css);
  if (existing) return existing.promise;

  const promise = Promise.resolve()
    .then(() => targetDocument.fonts.load(css, BLOCK_FONT_LOAD_SAMPLE))
    .then<BlockFontRequestOutcome, BlockFontRequestOutcome>(
      (faces) => {
        const current = cache.get(css);
        if (current) current.status = "ready";
        return { faces };
      },
      (error: unknown) => {
        // A transient load failure may recover on the next page visit.
        cache.delete(css);
        return { error };
      },
    );
  const entry: BlockFontRequestEntry = { promise, status: "loading" };
  cache.set(css, entry);
  return promise;
}

function collectBlockFontLoadRequests(
  blocks: readonly TranslationBlock[],
  catalog: BlockFontCatalog,
): BlockFontLoadRequest[] {
  const requests = new Map<string, BlockFontLoadRequest>();
  for (const block of blocks) {
    const displayText = block.translatedText || block.sourceText;
    if (!displayText.trim()) continue;
    const { runs } = parseRichText(
      displayText,
      Boolean(block.bold),
      Boolean(block.italic),
    );
    for (const run of runs) {
      const fontId = run.fontFamily ?? block.fontFamily;
      const family = resolveBlockFontFamily(fontId, catalog);
      const required = isManagedFont(
        resolveEffectiveFontId(fontId, catalog),
        catalog,
      );
      const css = `${run.italic ? "italic" : "normal"} ${run.bold ? 800 : 400} 16px ${family}`;
      requests.set(css, { css, family, required });
    }
  }
  return [...requests.values()].sort((left, right) =>
    left.css.localeCompare(right.css),
  );
}

function resolveEffectiveFontId(
  fontFamily: string | undefined,
  catalog: BlockFontCatalog,
): string {
  return (
    normalizeBlockFontFamily(fontFamily, catalog) ??
    catalog.preferences.defaultFontId
  );
}

function isManagedFont(id: string, catalog: BlockFontCatalog): boolean {
  return (
    id !== DEFAULT_BLOCK_FONT_ID &&
    (isBuiltInBlockFontId(id) ||
      catalog.customFonts.some((font) => font.id === id))
  );
}

function parseBlockFontLoadKey(loadKey: string): BlockFontLoadRequest[] {
  if (!loadKey) return [];
  const parsed: unknown = JSON.parse(loadKey);
  if (!Array.isArray(parsed) || !parsed.every(isBlockFontLoadRequest)) {
    throw new Error("Invalid block font load key.");
  }
  return parsed;
}

function isBlockFontLoadRequest(value: unknown): value is BlockFontLoadRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    "css" in value &&
    typeof value.css === "string" &&
    "family" in value &&
    typeof value.family === "string" &&
    "required" in value &&
    typeof value.required === "boolean"
  );
}
