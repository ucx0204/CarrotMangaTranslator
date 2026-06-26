import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { CustomFont, MangaPage } from "../shared/types";
import { getAppPaths } from "./appPaths";
import { listCustomFonts, resolveCustomFontFilePath } from "./customFonts";
import { buildPageExportBlocks } from "./pageExportBlocks";
import { PAGE_EXPORT_RENDER_SCRIPT } from "./pageExportRenderScript";

export function buildPageExportHtml(
  page: MangaPage,
  imageDataUrl: string,
  width: number,
  height: number,
): string {
  const rendererCssHref = findRendererCssHref();
  const customFonts = listCustomFonts();
  const customFamilyById = new Map(
    customFonts.map((font) => [font.id, font.family]),
  );
  const customFontFaces = buildCustomFontFaces(customFonts);
  const blocks = buildPageExportBlocks(page, width, height, customFamilyById);
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: file:; font-src data: file:; style-src 'unsafe-inline' file:; script-src 'unsafe-inline';" />
${rendererCssHref ? `<link rel="stylesheet" href="${escapeHtml(rendererCssHref)}" />` : ""}
<style>
${customFontFaces}
html, body {
  margin: 0;
  width: ${width}px;
  height: ${height}px;
  overflow: hidden;
  background: #fff;
}
body {
  font-family: "Malgun Gothic", "Apple SD Gothic Neo", "Segoe UI", sans-serif;
}
.page-export-stage {
  position: relative;
  width: ${width}px;
  height: ${height}px;
  overflow: hidden;
  background: #fff;
}
</style>
</head>
<body>
<div class="page-export-stage" id="stage">
  <canvas id="exportCanvas" width="${width}" height="${height}" style="display:block;width:${width}px;height:${height}px"></canvas>
</div>
<script>
const EXPORT_BLOCKS = ${safeScriptJson(blocks)};
const EXPORT_IMAGE_DATA_URL = ${safeScriptJson(imageDataUrl)};
${PAGE_EXPORT_RENDER_SCRIPT}
</script>
</body>
</html>`;
}

function buildCustomFontFaces(fonts: CustomFont[]): string {
  return fonts
    .flatMap((font) => {
      const fontPath = resolveCustomFontFilePath(font.id);
      if (!fontPath) {
        return [];
      }
      const fileUrl = pathToFileURL(fontPath).toString();
      return `@font-face { font-family: "${font.family}"; src: url("${fileUrl}"); font-display: swap; }`;
    })
    .join("\n");
}

function findRendererCssHref(): string | null {
  const appPaths = getAppPaths();
  const rendererDir = join(__dirname, "../renderer");
  const rendererIndexPath = join(rendererDir, "index.html");
  if (existsSync(rendererIndexPath)) {
    const html = readFileSync(rendererIndexPath, "utf8");
    const match = html.match(
      /<link[^>]+href=["']([^"']+index-[^"']+\.css)["']/i,
    );
    if (match?.[1]) {
      const cssHref = resolveExistingFileUrlInside(
        rendererDir,
        resolveRendererAssetPath(rendererDir, match[1]),
      );
      if (cssHref) {
        return cssHref;
      }
    }
  }

  const assetDir = join(__dirname, "../renderer/assets");
  if (existsSync(assetDir)) {
    const cssFile = readdirSync(assetDir)
      .filter((file) => /^index-.*\.css$/i.test(file))
      .sort()
      .at(-1);
    if (cssFile) {
      const cssHref = resolveExistingFileUrlInside(
        assetDir,
        join(assetDir, cssFile),
      );
      if (cssHref) {
        return cssHref;
      }
    }
  }

  if (!appPaths.isPackaged) {
    return resolveExistingFileUrlInside(
      appPaths.repoRoot,
      join(appPaths.repoRoot, "src", "renderer", "src", "styles.css"),
    );
  }
  return null;
}

function resolveRendererAssetPath(rendererDir: string, href: string): string {
  const rendererRelativePath = href
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "");
  return resolve(rendererDir, rendererRelativePath);
}

function resolveExistingFileUrlInside(
  rootPath: string,
  targetPath: string,
): string | null {
  const resolvedRoot = resolve(rootPath);
  const resolvedTarget = resolve(targetPath);
  if (
    !isPathInside(resolvedRoot, resolvedTarget) ||
    !existsSync(resolvedTarget)
  ) {
    return null;
  }
  return pathToFileURL(resolvedTarget).toString();
}

function isPathInside(rootPath: string, targetPath: string): boolean {
  const child = relative(rootPath, targetPath);
  return (
    child === "" || (!!child && !child.startsWith("..") && !isAbsolute(child))
  );
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return char;
    }
  });
}

function safeScriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
