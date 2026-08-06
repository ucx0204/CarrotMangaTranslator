import { existsSync } from "node:fs";
import { extname, join } from "node:path";
import { getAppPaths } from "./appPaths";
import { ALLOWED_EXTENSIONS, isPathInside } from "./customFonts";

/**
 * 빌트인 @font-face 폰트(`mgt-font:///<rel>`)의 파일 경로를 해석한다. dev에서는
 * 소스 자산 디렉토리, 패키집에서는 Vite 출력 트리(asar 내부)를 사용한다. Node fs
 * 는 asar를 인식하므로 `file://` fetch의 빈 바이트 문제(#53 OTS zero-length) 없이
 * 폰트 바이트를 서빙할 수 있다. 서브디렉토리(ko/, en/, ja/, zh-hans/, zh-hant/)
 * 는 허용하되 경로 트래버설은 isPathInside로 차단한다. UUID 커스텀 폰트
 * (resolveCustomFontFilePath)와 충돌하지 않는다.
 */
export function resolveBundledFontFilePath(rel: string): string | null {
  if (!rel || rel.includes("\0")) {
    return null;
  }
  if (!ALLOWED_EXTENSIONS.has(extname(rel).toLowerCase())) {
    return null;
  }
  const { repoRoot, isPackaged } = getAppPaths();
  const dir = isPackaged
    ? join(repoRoot, "out", "renderer", "assets", "fonts")
    : join(repoRoot, "src", "renderer", "src", "assets", "fonts");
  const filePath = join(dir, rel);
  if (!isPathInside(dir, filePath)) {
    return null;
  }
  return existsSync(filePath) ? filePath : null;
}
