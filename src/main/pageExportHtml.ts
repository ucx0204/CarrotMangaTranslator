import { existsSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  CustomFont,
  FontPreferences,
  MangaPage,
} from "../shared/libraryTypes";
import {
  PAGE_EXPORT_ASSET_DIRECTORY,
  type PageExportDocumentData,
  PAGE_EXPORT_RUNTIME_FILE,
  PAGE_EXPORT_STYLES_FILE,
} from "../shared/pageExportContracts";
import type { PageExportRasterSize } from "../shared/pageExportLimits";
import { getAppPaths } from "./appPaths";
import {
  listCustomFonts,
  readFontPreferences,
  resolveCustomFontFilePath,
} from "./customFonts";

export type PageExportHtmlSource = {
  buildHtml: (
    page: MangaPage,
    imageSrc: string,
    outputSize: PageExportRasterSize,
    options?: { transparentBackground?: boolean },
  ) => string;
};

export type PageExportHtmlDependencies = {
  assetDirectories: () => readonly string[];
  rendererStylesheet: () => string | null;
  fonts: {
    list: () => CustomFont[];
    readPreferences: (fonts: readonly CustomFont[]) => FontPreferences;
    resolveFilePath: (id: string) => string | null;
  };
};

export function createPageExportHtmlSource(
  dependencies: PageExportHtmlDependencies,
): PageExportHtmlSource {
  return {
    buildHtml: (page, imageSrc, outputSize, options) =>
      buildPageExportHtmlWith(
        dependencies,
        page,
        imageSrc,
        outputSize,
        options,
      ),
  };
}

export function buildPageExportHtml(
  page: MangaPage,
  imageSrc: string,
  outputSize: PageExportRasterSize,
  options?: { transparentBackground?: boolean },
): string {
  return buildPageExportHtmlWith(
    createProductionPageExportHtmlDependencies(),
    page,
    imageSrc,
    outputSize,
    options,
  );
}

function buildPageExportHtmlWith(
  dependencies: PageExportHtmlDependencies,
  page: MangaPage,
  imageSrc: string,
  outputSize: PageExportRasterSize,
  options?: { transparentBackground?: boolean },
): string {
  const assets = findPageExportAssets(dependencies.assetDirectories());
  const rendererStylesheet = dependencies.rendererStylesheet();
  if (!rendererStylesheet) {
    throw new Error("Renderer stylesheet is missing for page export.");
  }
  const customFonts = dependencies.fonts.list();
  const customFontFaces = buildCustomFontFaces(
    customFonts,
    dependencies.fonts.resolveFilePath,
  );
  const data: PageExportDocumentData = {
    fontLibrary: {
      customFonts,
      preferences: dependencies.fonts.readPreferences(customFonts),
    },
    imageSrc,
    outputSize,
    page: {
      id: page.id,
      name: page.name,
      width: page.width,
      height: page.height,
      blocks: page.blocks,
    },
    ...(options?.transparentBackground ? { transparentBackground: true } : {}),
  };
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: mgt-image:; font-src data: mgt-font: file:; style-src 'unsafe-inline' file:; script-src file:; base-uri 'none'; form-action 'none';" />
<link rel="stylesheet" href="${escapeHtml(rendererStylesheet)}" />
<link rel="stylesheet" href="${escapeHtml(assets.stylesHref)}" />
<style>${customFontFaces}</style>
</head>
<body>
<div class="page-export-stage" id="stage"></div>
<script id="page-export-data" type="application/json">${safeScriptJson(data)}</script>
<script src="${escapeHtml(assets.runtimeHref)}" defer></script>
</body>
</html>`;
}

function buildCustomFontFaces(
  fonts: CustomFont[],
  resolveFilePath: (id: string) => string | null,
): string {
  return fonts
    .flatMap((font) => {
      const fontPath = resolveFilePath(font.id);
      if (!fontPath) return [];
      const fileUrl = pathToFileURL(fontPath).toString();
      return `@font-face { font-family: "${escapeCssString(font.family)}"; src: url("${escapeCssString(fileUrl)}"); font-display: swap; }`;
    })
    .join("\n");
}

function findPageExportAssets(assetDirectories: readonly string[]): {
  runtimeHref: string;
  stylesHref: string;
} {
  for (const assetDir of new Set(assetDirectories)) {
    const runtimeHref = resolveExistingFileUrlInside(
      assetDir,
      join(assetDir, PAGE_EXPORT_RUNTIME_FILE),
    );
    const stylesHref = resolveExistingFileUrlInside(
      assetDir,
      join(assetDir, PAGE_EXPORT_STYLES_FILE),
    );
    if (runtimeHref && stylesHref) return { runtimeHref, stylesHref };
  }
  throw new Error(
    `Page export assets are missing (${PAGE_EXPORT_RUNTIME_FILE}, ${PAGE_EXPORT_STYLES_FILE}). Run npm run compile:electron.`,
  );
}

function createProductionPageExportHtmlDependencies(): PageExportHtmlDependencies {
  return {
    assetDirectories: () => {
      const appPaths = getAppPaths();
      return [
        resolve(__dirname, `../${PAGE_EXPORT_ASSET_DIRECTORY}`),
        resolve(appPaths.repoRoot, "out", PAGE_EXPORT_ASSET_DIRECTORY),
      ];
    },
    rendererStylesheet: findRendererStylesheet,
    fonts: {
      list: listCustomFonts,
      readPreferences: readFontPreferences,
      resolveFilePath: resolveCustomFontFilePath,
    },
  };
}

function findRendererStylesheet(): string | null {
  const appPaths = getAppPaths();
  if (!appPaths.isPackaged) {
    const sourceStylesheet = resolveExistingFileUrlInside(
      appPaths.repoRoot,
      join(appPaths.repoRoot, "src", "renderer", "src", "styles.css"),
    );
    if (sourceStylesheet) return sourceStylesheet;
  }
  const rendererDir = resolve(__dirname, "../renderer");
  return (
    findRendererStylesheetFromIndex(rendererDir) ??
    findRendererStylesheetFromAssets(join(rendererDir, "assets"))
  );
}

function findRendererStylesheetFromIndex(rendererDir: string): string | null {
  const indexPath = join(rendererDir, "index.html");
  if (!existsSync(indexPath)) return null;
  const match = readFileSync(indexPath, "utf8").match(
    /<link[^>]+href=["']([^"']+index-[^"']+\.css)["']/i,
  );
  if (!match?.[1]) return null;
  const relativeHref = match[1]
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "");
  return resolveExistingFileUrlInside(
    rendererDir,
    resolve(rendererDir, relativeHref),
  );
}

function findRendererStylesheetFromAssets(assetDir: string): string | null {
  if (!existsSync(assetDir)) return null;
  const cssFile = readdirSync(assetDir)
    .filter((file) => /^index-.*\.css$/i.test(file))
    .sort()
    .at(-1);
  return cssFile
    ? resolveExistingFileUrlInside(assetDir, join(assetDir, cssFile))
    : null;
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
    if (char === "&") return "&amp;";
    if (char === "<") return "&lt;";
    if (char === ">") return "&gt;";
    return "&quot;";
  });
}

function escapeCssString(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "\\d ")
    .replace(/\n/g, "\\a ");
}

function safeScriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
