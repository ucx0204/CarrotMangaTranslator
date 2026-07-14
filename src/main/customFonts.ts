import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { randomUUID } from "node:crypto";
import {
  BUILT_IN_BLOCK_FONTS,
  DEFAULT_BLOCK_FONT_ID,
} from "../shared/blockFontCatalog";
import type {
  CustomFont,
  FontLibrarySnapshot,
  FontPreferences,
} from "../shared/libraryTypes";
import { getAppPaths } from "./appPaths";
import { logError } from "./logger";

const ALLOWED_EXTENSIONS = new Set([".ttf", ".otf"]);
const MAX_CUSTOM_FONT_BYTES = 32 * 1024 * 1024;
const MAX_FONTS = 200;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function fontsDir(): string {
  const dir = getAppPaths().fontsDir;
  mkdirSync(dir, { recursive: true });
  return dir;
}

function indexPath(): string {
  return join(fontsDir(), "index.json");
}

function preferencesPath(): string {
  return join(fontsDir(), "preferences.json");
}

export const DEFAULT_FONT_PREFERENCES: FontPreferences = {
  favoriteIds: [],
  orderedIds: [],
  defaultFontId: DEFAULT_BLOCK_FONT_ID,
};

function isPathInside(rootPath: string, targetPath: string): boolean {
  const child = relative(rootPath, targetPath);
  return (
    child === "" || (!!child && !child.startsWith("..") && !isAbsolute(child))
  );
}

function normalizeUuid(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const id = value.toLowerCase();
  return UUID_PATTERN.test(id) ? id : null;
}

function isSafeFontFileName(id: string, fileName: string): boolean {
  if (!fileName || fileName.includes("\0") || basename(fileName) !== fileName) {
    return false;
  }
  const ext = extname(fileName).toLowerCase();
  return ALLOWED_EXTENSIONS.has(ext) && fileName === `${id}${ext}`;
}

function resolveFontFilePath(
  fontsRoot: string,
  id: string,
  fileName: string,
): string | null {
  if (!isSafeFontFileName(id, fileName)) {
    return null;
  }
  const resolvedRoot = resolve(fontsRoot);
  const filePath = resolve(resolvedRoot, fileName);
  return isPathInside(resolvedRoot, filePath) ? filePath : null;
}

function normalizeCustomFont(value: unknown): CustomFont | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const font = value as Record<string, unknown>;
  const id = normalizeUuid(font.id);
  if (
    !id ||
    typeof font.label !== "string" ||
    typeof font.family !== "string" ||
    typeof font.fileName !== "string"
  ) {
    return null;
  }
  if (
    font.family !== `MGTUser-${id}` ||
    !isSafeFontFileName(id, font.fileName)
  ) {
    return null;
  }
  return {
    id,
    label: sanitizeLabel(font.label),
    family: `MGTUser-${id}`,
    fileName: font.fileName,
  };
}

function resolveExistingFontFilePath(
  font: CustomFont,
  fontsRoot = fontsDir(),
): string | null {
  const filePath = resolveFontFilePath(fontsRoot, font.id, font.fileName);
  if (!filePath) {
    return null;
  }

  try {
    if (!statSync(filePath).isFile()) {
      return null;
    }
    const realRoot = realpathSync(resolve(fontsRoot));
    const realFilePath = realpathSync(filePath);
    return isPathInside(realRoot, realFilePath) ? filePath : null;
  } catch (_error) {
    return null;
  }
}

export function listCustomFonts(): CustomFont[] {
  try {
    const path = indexPath();
    if (!existsSync(path)) {
      return [];
    }
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(parsed)) {
      return [];
    }
    const root = fontsDir();
    return parsed
      .map(normalizeCustomFont)
      .filter((font): font is CustomFont => Boolean(font))
      .filter((font) => Boolean(resolveExistingFontFilePath(font, root)));
  } catch (error) {
    logError("Failed to read custom fonts index", error);
    return [];
  }
}

function saveIndex(fonts: CustomFont[]): void {
  const safeFonts = fonts
    .map(normalizeCustomFont)
    .filter((font): font is CustomFont => Boolean(font));
  const targetPath = indexPath();
  const tempPath = `${targetPath}.${process.pid}.tmp`;
  writeFileSync(tempPath, JSON.stringify(safeFonts, null, 2), "utf8");
  renameSync(tempPath, targetPath);
}

function knownFontIds(customFonts: readonly CustomFont[]): Set<string> {
  return new Set([
    DEFAULT_BLOCK_FONT_ID,
    ...BUILT_IN_BLOCK_FONTS.map((font) => font.id),
    ...customFonts.map((font) => font.id),
  ]);
}

function normalizeKnownIds(
  value: unknown,
  knownIds: ReadonlySet<string>,
): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (
      typeof candidate === "string" &&
      knownIds.has(candidate) &&
      !seen.has(candidate)
    ) {
      seen.add(candidate);
      result.push(candidate);
    }
  }
  return result;
}

export function normalizeFontPreferences(
  value: unknown,
  customFonts: readonly CustomFont[] = listCustomFonts(),
): FontPreferences {
  const data =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const knownIds = knownFontIds(customFonts);
  const defaultFontId =
    typeof data.defaultFontId === "string" && knownIds.has(data.defaultFontId)
      ? data.defaultFontId
      : DEFAULT_BLOCK_FONT_ID;
  return {
    favoriteIds: normalizeKnownIds(data.favoriteIds, knownIds),
    orderedIds: normalizeKnownIds(data.orderedIds, knownIds),
    defaultFontId,
  };
}

export function readFontPreferences(
  customFonts: readonly CustomFont[] = listCustomFonts(),
): FontPreferences {
  const path = preferencesPath();
  if (!existsSync(path)) {
    return { ...DEFAULT_FONT_PREFERENCES };
  }
  try {
    return normalizeFontPreferences(
      JSON.parse(readFileSync(path, "utf8")),
      customFonts,
    );
  } catch (error) {
    logError("Failed to read font preferences", error);
    return { ...DEFAULT_FONT_PREFERENCES };
  }
}

export function saveFontPreferences(
  value: unknown,
  customFonts: readonly CustomFont[] = listCustomFonts(),
): FontPreferences {
  const preferences = normalizeFontPreferences(value, customFonts);
  const targetPath = preferencesPath();
  const tempPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tempPath, JSON.stringify(preferences, null, 2), "utf8");
    renameSync(tempPath, targetPath);
  } finally {
    if (existsSync(tempPath)) {
      rmSync(tempPath, { force: true });
    }
  }
  return preferences;
}

export function getFontLibrarySnapshot(): FontLibrarySnapshot {
  const customFonts = listCustomFonts();
  return {
    customFonts,
    preferences: readFontPreferences(customFonts),
  };
}

function sanitizeLabel(raw: string): string {
  const cleaned = Array.from(raw)
    .filter((char) => {
      const codePoint = char.codePointAt(0);
      return codePoint !== undefined && codePoint >= 0x20;
    })
    .join("")
    .trim()
    .slice(0, 60);
  return cleaned || "사용자 폰트";
}

export function registerCustomFontFromFile(sourcePath: string): CustomFont {
  const ext = extname(sourcePath).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error("TTF 또는 OTF 폰트 파일만 등록할 수 있습니다.");
  }
  assertFontFileLooksValid(sourcePath, ext);
  const fonts = listCustomFonts();
  if (fonts.length >= MAX_FONTS) {
    throw new Error("등록할 수 있는 폰트 수를 초과했습니다.");
  }
  const id = randomUUID();
  const fileName = `${id}${ext}`;
  copyFileSync(sourcePath, join(fontsDir(), fileName));
  const font: CustomFont = {
    id,
    label: sanitizeLabel(basename(sourcePath, extname(sourcePath))),
    family: `MGTUser-${id}`,
    fileName,
  };
  saveIndex([...fonts, font]);
  return font;
}

function assertFontFileLooksValid(sourcePath: string, ext: string): void {
  const info = statSync(sourcePath);
  if (!info.isFile()) {
    throw new Error("폰트 파일을 읽지 못했습니다.");
  }
  if (info.size < 12 || info.size > MAX_CUSTOM_FONT_BYTES) {
    throw new Error("폰트 파일 크기가 올바르지 않습니다.");
  }
  const header = readFileSync(sourcePath).subarray(0, 4);
  const signature = header.toString("latin1");
  const isTrueType =
    header[0] === 0x00 &&
    header[1] === 0x01 &&
    header[2] === 0x00 &&
    header[3] === 0x00;
  const isOtf = signature === "OTTO";
  const isAppleTrueType = signature === "true";
  if (ext === ".otf" && !isOtf) {
    throw new Error("OTF 폰트 파일 형식이 올바르지 않습니다.");
  }
  if (ext === ".ttf" && !isTrueType && !isAppleTrueType) {
    throw new Error("TTF 폰트 파일 형식이 올바르지 않습니다.");
  }
}

export function removeCustomFont(id: string): CustomFont[] {
  const normalizedId = normalizeUuid(id);
  if (!normalizedId) {
    return listCustomFonts();
  }
  const fonts = listCustomFonts();
  const target = fonts.find((font) => font.id === normalizedId);
  if (target) {
    const fontPath = resolveExistingFontFilePath(target);
    try {
      if (fontPath) {
        rmSync(fontPath, { force: true });
      }
    } catch (error) {
      logError("Failed to delete custom font file", {
        id: normalizedId,
        error,
      });
    }
  }
  const remaining = fonts.filter((font) => font.id !== normalizedId);
  saveIndex(remaining);
  saveFontPreferences(readFontPreferences(fonts), remaining);
  return remaining;
}

export function resolveCustomFontFilePath(id: string): string | null {
  const normalizedId = normalizeUuid(id);
  if (!normalizedId) {
    return null;
  }
  const font = listCustomFonts().find(
    (candidate) => candidate.id === normalizedId,
  );
  if (!font) {
    return null;
  }
  return resolveExistingFontFilePath(font);
}
