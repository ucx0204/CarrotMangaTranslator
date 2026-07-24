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
