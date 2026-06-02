import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { CustomFont } from "../shared/types";
import { getAppPaths } from "./appPaths";
import { logError } from "./logger";

const ALLOWED_EXTENSIONS = new Set([".ttf", ".otf"]);
const MAX_FONTS = 200;

function fontsDir(): string {
  const dir = getAppPaths().fontsDir;
  mkdirSync(dir, { recursive: true });
  return dir;
}

function indexPath(): string {
  return join(fontsDir(), "index.json");
}

function isCustomFont(value: unknown): value is CustomFont {
  if (!value || typeof value !== "object") {
    return false;
  }
  const font = value as Record<string, unknown>;
  return (
    typeof font.id === "string" &&
    typeof font.label === "string" &&
    typeof font.family === "string" &&
    typeof font.fileName === "string"
  );
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
    return parsed.filter(isCustomFont).filter((font) => existsSync(join(fontsDir(), font.fileName)));
  } catch (error) {
    logError("Failed to read custom fonts index", error);
    return [];
  }
}

function saveIndex(fonts: CustomFont[]): void {
  writeFileSync(indexPath(), JSON.stringify(fonts, null, 2), "utf8");
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
  const fonts = listCustomFonts();
  const target = fonts.find((font) => font.id === id);
  if (target) {
    try {
      rmSync(join(fontsDir(), target.fileName), { force: true });
    } catch (error) {
      logError("Failed to delete custom font file", { id, error });
    }
  }
  const remaining = fonts.filter((font) => font.id !== id);
  saveIndex(remaining);
  return remaining;
}

export function resolveCustomFontFilePath(id: string): string | null {
  const font = listCustomFonts().find((candidate) => candidate.id === id);
  if (!font) {
    return null;
  }
  const filePath = join(fontsDir(), font.fileName);
  return existsSync(filePath) ? filePath : null;
}
