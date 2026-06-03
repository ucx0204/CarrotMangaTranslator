import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { CustomFont } from "../shared/types";
import { getAppPaths } from "./appPaths";
import { logError } from "./logger";

const ALLOWED_EXTENSIONS = new Set([".ttf", ".otf"]);
const MAX_FONTS = 200;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function fontsDir(): string {
  const dir = getAppPaths().fontsDir;
  mkdirSync(dir, { recursive: true });
  return dir;
}

function indexPath(): string {
  return join(fontsDir(), "index.json");
}

function isPathInside(rootPath: string, targetPath: string): boolean {
  const child = relative(rootPath, targetPath);
  return child === "" || (!!child && !child.startsWith("..") && !isAbsolute(child));
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

function resolveFontFilePath(fontsRoot: string, id: string, fileName: string): string | null {
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
  if (!id || typeof font.label !== "string" || typeof font.family !== "string" || typeof font.fileName !== "string") {
    return null;
  }
  if (font.family !== `MGTUser-${id}` || !isSafeFontFileName(id, font.fileName)) {
    return null;
  }
  return {
    id,
    label: sanitizeLabel(font.label),
    family: `MGTUser-${id}`,
    fileName: font.fileName
  };
}

function resolveExistingFontFilePath(font: CustomFont, fontsRoot = fontsDir()): string | null {
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
  } catch {
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
  const safeFonts = fonts.map(normalizeCustomFont).filter((font): font is CustomFont => Boolean(font));
  writeFileSync(indexPath(), JSON.stringify(safeFonts, null, 2), "utf8");
}

function sanitizeLabel(raw: string): string {
  const cleaned = Array.from(raw)
    .filter((char) => char.codePointAt(0)! >= 0x20)
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
    fileName
  };
  saveIndex([...fonts, font]);
  return font;
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
      logError("Failed to delete custom font file", { id: normalizedId, error });
    }
  }
  const remaining = fonts.filter((font) => font.id !== normalizedId);
  saveIndex(remaining);
  return remaining;
}

export function resolveCustomFontFilePath(id: string): string | null {
  const normalizedId = normalizeUuid(id);
  if (!normalizedId) {
    return null;
  }
  const font = listCustomFonts().find((candidate) => candidate.id === normalizedId);
  if (!font) {
    return null;
  }
  return resolveExistingFontFilePath(font);
}
