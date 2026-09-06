import { readFileSync, statSync } from "node:fs";

const MAX_CUSTOM_FONT_BYTES = 32 * 1024 * 1024;

export function assertFontFileLooksValid(
  sourcePath: string,
  extension: string,
): void {
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
  if (extension === ".otf" && signature !== "OTTO") {
    throw new Error("OTF 폰트 파일 형식이 올바르지 않습니다.");
  }
  if (extension === ".ttf" && !isTrueType && signature !== "true") {
    throw new Error("TTF 폰트 파일 형식이 올바르지 않습니다.");
  }
}

export function sanitizeFontLabel(raw: string): string {
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

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function normalizeFontUuid(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const id = value.toLowerCase();
  return UUID_PATTERN.test(id) ? id : null;
}
