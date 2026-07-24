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
  ready: Promise<unknown>;
};

type BlockFontDocument = {
  fonts: BlockFontSet;
};

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
  const settled = await Promise.allSettled(
    requests.map(async (request) => ({
      request,
      faces: await targetDocument.fonts.load(request.css, "Aa가나다漢字かな"),
    })),
  );
  const failures: BlockFontLoadReport["failures"] = [];
  const missingFamilies = new Set<string>();
  settled.forEach((result, index) => {
    const request = requests[index];
    if (!request) return;
    if (result.status === "rejected") {
      failures.push({ css: request.css, error: result.reason });
      return;
    }
    if (request.required && result.value.faces.length === 0) {
      missingFamilies.add(request.family);
    }
  });
  await targetDocument.fonts.ready;
  return { failures, missingFamilies: [...missingFamilies] };
}

function collectBlockFontLoadRequests(
  blocks: readonly TranslationBlock[],
  catalog: BlockFontCatalog,
): BlockFontLoadRequest[] {
  const requests = new Map<string, BlockFontLoadRequest>();
  for (const block of blocks) {
    const displayText = block.translatedText || block.sourceText;
    if (!displayText.trim()) continue;
    const family = resolveBlockFontFamily(block.fontFamily, catalog);
    const required = isManagedFont(
      resolveEffectiveFontId(block, catalog),
      catalog,
    );
    const { runs } = parseRichText(
      displayText,
      Boolean(block.bold),
      Boolean(block.italic),
    );
    for (const run of runs) {
      const css = `${run.italic ? "italic" : "normal"} ${run.bold ? 800 : 400} 16px ${family}`;
      requests.set(css, { css, family, required });
    }
  }
  return [...requests.values()].sort((left, right) =>
    left.css.localeCompare(right.css),
  );
}

function resolveEffectiveFontId(
  block: TranslationBlock,
  catalog: BlockFontCatalog,
): string {
  return (
    normalizeBlockFontFamily(block.fontFamily, catalog) ??
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
