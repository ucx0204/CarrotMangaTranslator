import { readFile, stat } from "node:fs/promises";
import {
  BUILT_IN_BLOCK_FONTS,
  isRetiredBuiltInBlockFontId,
} from "../../shared/blockFontCatalog";
import { hashStableValue } from "../../shared/blockFingerprint";
import {
  McpFontEntrySchema,
  type McpFontEntry,
} from "../../shared/mcpTypographyRead";
import type { McpFontCatalog } from "../application/mcpTypographyReadService";
import { getAppPaths, type AppPaths } from "../appPaths";
import { loadBuiltInFontMatchingCandidates } from "../builtInFontMatchingCatalog";
import { createCustomFontLibrary } from "../customFonts";
import {
  inspectCustomFontBuffer,
  type CustomFontInspection,
} from "../customFontInspection";
import { logError } from "../logger";

type Library = ReturnType<typeof createCustomFontLibrary>;
const locales = ["ko", "en", "ja", "zh-Hans", "zh-Hant"] as const;

/** Queries reuse the registry normalizers but never migrate or create font directories. */
export async function readMcpFontCatalog(
  paths: Pick<AppPaths, "fontsDir"> = getAppPaths(),
): Promise<McpFontCatalog> {
  const library = createCustomFontLibrary({
    getFontsDirectory: () => paths.fontsDir,
    readOnlyQueries: true,
    reportError: (_message, error) => {
      throw error;
    },
  });
  const saved = library.getFontLibrarySnapshot();
  const candidates = locales.flatMap((locale) =>
    loadBuiltInFontMatchingCandidates(locale, (_message, detail) =>
      logError("MCP built-in font inspection unavailable", detail),
    ),
  );
  const byId = new Map(
    candidates.map((candidate) => [candidate.fontId, candidate]),
  );
  const fonts: McpFontEntry[] = BUILT_IN_BLOCK_FONTS.filter(
    (font) => !isRetiredBuiltInBlockFontId(font.id),
  ).map((font) => {
    const candidate = byId.get(font.id);
    return {
      fontId: font.id,
      label: font.label,
      source: "built-in",
      availability: candidate ? "available" : "unavailable",
      matchingRole: candidate ? "built-in-candidate" : "unavailable",
      locales: [...(candidate?.supportedLocales ?? [font.locale])],
      baseWeight: candidate?.weight ?? null,
      baseItalic: candidate?.italic ?? null,
      hidden: false,
      favorite: false,
      defaultFont: false,
    };
  });
  for (const font of saved.customFonts) {
    const inspection = await inspectRegisteredFont(library, font.id);
    fonts.push({
      fontId: font.id,
      label: font.label,
      source: "custom",
      availability: inspection ? "available" : "unverified",
      matchingRole: "custom-font",
      locales: [...(inspection?.supportedLocales ?? [])],
      baseWeight: inspection?.weight ?? null,
      baseItalic: inspection?.italic ?? null,
      hidden: false,
      favorite: false,
      defaultFont: false,
    });
  }
  const projected = fonts.map((font) =>
    McpFontEntrySchema.parse({
      ...font,
      hidden: saved.preferences.hiddenIds.includes(font.fontId),
      favorite: saved.preferences.favoriteIds.includes(font.fontId),
      defaultFont: saved.preferences.defaultFontId === font.fontId,
    }),
  );
  return {
    snapshot: hashStableValue({
      fonts: projected,
      preferences: saved.preferences,
    }),
    fonts: projected,
  };
}

async function inspectRegisteredFont(
  library: Library,
  id: string,
): Promise<CustomFontInspection | null> {
  const path = library.resolveCustomFontFilePath(id);
  if (!path) return null;
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size < 12 || info.size > 32 * 1024 * 1024)
      return null;
    const bytes = await readFile(path);
    if (bytes.length !== info.size) return null;
    return inspectCustomFontBuffer(bytes);
  } catch (error) {
    logError("MCP custom font inspection unavailable", error);
    return null;
  }
}
