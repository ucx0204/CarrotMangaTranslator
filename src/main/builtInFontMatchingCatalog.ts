import { readFileSync, readdirSync, statSync, type Stats } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { BUILT_IN_BLOCK_FONTS } from "../shared/blockFontCatalog";
import type { AutomaticFontCandidate } from "../shared/fontMatchingTypes";
import type { UiLocale } from "../shared/uiLocales";
import {
  inspectCustomFontBuffer,
  type CustomFontInspection,
} from "./customFontInspection";

const MIN_INSPECTABLE_FONT_BYTES = 12;
const MAX_INSPECTABLE_FONT_BYTES = 32 * 1024 * 1024;

type BuiltInFontId = (typeof BUILT_IN_BLOCK_FONTS)[number]["id"];

type BuiltInFontAssetDefinition = Readonly<{
  id: BuiltInFontId;
  relativePath: string;
}>;

const BUILT_IN_FONT_ASSETS = [
  { id: "mongtori", relativePath: "mongtori.ttf" },
  { id: "chosun-gungseo", relativePath: "chosun-gungseo.ttf" },
  {
    id: "griun-pol-sensibility",
    relativePath: "griun-pol-sensibility.ttf",
  },
  { id: "nanum-gothic", relativePath: "nanum-gothic-regular.ttf" },
  { id: "nanum-myeongjo", relativePath: "nanum-myeongjo-regular.ttf" },
  {
    id: "nanum-barun-gothic",
    relativePath: "nanum-barun-gothic-regular.ttf",
  },
  { id: "seoul-namsan", relativePath: "seoul-namsan-regular.ttf" },
  {
    id: "seoul-namsan-vertical",
    relativePath: "seoul-namsan-vertical.ttf",
  },
  { id: "seoul-hangang", relativePath: "seoul-hangang-regular.ttf" },
  { id: "dohyeon", relativePath: "ko/dohyeon.ttf" },
  { id: "ridi-batang", relativePath: "ko/ridi-batang.otf" },
  {
    id: "cafe24-gowoonbam",
    relativePath: "ko/cafe24-gowoonbam.ttf",
  },
  { id: "start-over", relativePath: "ko/start-over.ttf" },
  { id: "jua", relativePath: "ko/jua.ttf" },
  { id: "gaegu", relativePath: "ko/gaegu-regular.ttf" },
  { id: "comic-neue", relativePath: "en/comic-neue.ttf" },
  { id: "kalam", relativePath: "en/kalam.ttf" },
  { id: "bangers", relativePath: "en/bangers.ttf" },
  { id: "luckiest-guy", relativePath: "en/luckiest-guy.ttf" },
  {
    id: "permanent-marker",
    relativePath: "en/permanent-marker.ttf",
  },
  { id: "freckle-face", relativePath: "en/freckle-face.ttf" },
  { id: "yusei-magic", relativePath: "ja/yusei-magic.ttf" },
  { id: "mochiy-pop-one", relativePath: "ja/mochiy-pop-one.ttf" },
  { id: "hachi-maru-pop", relativePath: "ja/hachi-maru-pop.ttf" },
  { id: "dela-gothic-one", relativePath: "ja/dela-gothic-one.ttf" },
  { id: "reggae-one", relativePath: "ja/reggae-one.ttf" },
  { id: "dot-gothic-16", relativePath: "ja/dot-gothic-16.ttf" },
  { id: "zcool-kuaile", relativePath: "zh-hans/zcool-kuaile.ttf" },
  {
    id: "zcool-qingke-huangyou",
    relativePath: "zh-hans/zcool-qingke-huangyou.ttf",
  },
  { id: "zcool-xiaowei", relativePath: "zh-hans/zcool-xiaowei.ttf" },
  { id: "ma-shan-zheng", relativePath: "zh-hans/ma-shan-zheng.ttf" },
  { id: "long-cang", relativePath: "zh-hans/long-cang.ttf" },
  {
    id: "liu-jian-mao-cao",
    relativePath: "zh-hans/liu-jian-mao-cao.ttf",
  },
  { id: "huninn", relativePath: "zh-hant/huninn.ttf" },
  { id: "iansui", relativePath: "zh-hant/iansui.ttf" },
  {
    id: "lxgw-wenkai-tc",
    relativePath: "zh-hant/lxgw-wenkai-tc.ttf",
  },
  {
    id: "lxgw-marker-gothic",
    relativePath: "zh-hant/lxgw-marker-gothic.ttf",
  },
  {
    id: "chenyu-luoyan",
    relativePath: "zh-hant/chenyu-luoyan.ttf",
  },
  { id: "cubic-11", relativePath: "zh-hant/cubic-11.ttf" },
] as const satisfies readonly BuiltInFontAssetDefinition[];

const BUILT_IN_FONT_ASSET_BY_ID = new Map<BuiltInFontId, string>(
  BUILT_IN_FONT_ASSETS.map(({ id, relativePath }) => [id, relativePath]),
);

type CachedInspection = Readonly<{
  fileSize: number;
  mtimeMs: number;
  inspection: CustomFontInspection;
}>;

const inspectionCacheByInspector = new WeakMap<
  BuiltInFontMatchingCatalogDependencies["inspectFontBuffer"],
  Map<string, CachedInspection>
>();

type BuiltInFontFileStat = Pick<Stats, "isFile" | "mtimeMs" | "size">;

export type BuiltInFontMatchingCatalogDependencies = Readonly<{
  assetRoots: readonly string[];
  inspectFontBuffer: (buffer: Buffer) => CustomFontInspection;
  readDirectory: (path: string) => readonly string[];
  readFontFile: (path: string) => Buffer;
  reportWarning: (message: string, detail: unknown) => void;
  statFontFile: (path: string) => BuiltInFontFileStat;
}>;

const productionDependencies: Omit<
  BuiltInFontMatchingCatalogDependencies,
  "reportWarning"
> = {
  assetRoots: resolveProductionAssetRoots(),
  inspectFontBuffer: inspectCustomFontBuffer,
  readDirectory: (path) => readdirSync(path),
  readFontFile: (path) => readFileSync(path),
  statFontFile: (path) => statSync(path),
};

export function loadBuiltInFontMatchingCandidates(
  locale: UiLocale,
  reportWarning: BuiltInFontMatchingCatalogDependencies["reportWarning"],
): AutomaticFontCandidate[] {
  return loadBuiltInFontMatchingCandidatesWith(locale, {
    ...productionDependencies,
    reportWarning,
  });
}

export function loadBuiltInFontMatchingCandidatesWith(
  locale: UiLocale,
  dependencies: BuiltInFontMatchingCatalogDependencies,
): AutomaticFontCandidate[] {
  const directoryEntries = new Map<string, readonly string[] | null>();
  const definitions = BUILT_IN_BLOCK_FONTS.filter(
    (font) => font.locale === locale,
  );
  const candidates: AutomaticFontCandidate[] = [];

  definitions.forEach((definition, preferenceRank) => {
    const relativePath = BUILT_IN_FONT_ASSET_BY_ID.get(definition.id);
    try {
      if (!relativePath) {
        throw new Error("Built-in font asset mapping is missing.");
      }
      const fontPath = resolveBuiltInFontPath(
        relativePath,
        dependencies,
        directoryEntries,
      );
      if (!fontPath) {
        throw new Error("Built-in font asset could not be resolved.");
      }
      const inspection = inspectOrReuseFont(fontPath, dependencies);
      candidates.push({
        source: "built-in",
        fontId: definition.id,
        label: definition.label,
        supportedLocales: inspection.supportedLocales,
        unicodeRanges: inspection.unicodeRanges,
        weight: inspection.weight,
        width: inspection.width,
        italic: inspection.italic,
        serif: inspection.serif,
        favorite: false,
        defaultFont: false,
        preferenceRank,
      });
    } catch (error) {
      dependencies.reportWarning("Built-in font auto-match inspection failed", {
        fontId: definition.id,
        label: definition.label,
        locale,
        relativePath,
        error,
      });
    }
  });

  return candidates;
}

function inspectOrReuseFont(
  fontPath: string,
  dependencies: BuiltInFontMatchingCatalogDependencies,
): CustomFontInspection {
  const stat = dependencies.statFontFile(fontPath);
  if (!stat.isFile()) {
    throw new Error("Built-in font path is not a file.");
  }
  if (
    stat.size < MIN_INSPECTABLE_FONT_BYTES ||
    stat.size > MAX_INSPECTABLE_FONT_BYTES
  ) {
    throw new Error("Built-in font size is outside the inspection limit.");
  }
  const inspectionCache = resolveInspectionCache(
    dependencies.inspectFontBuffer,
  );
  const cached = inspectionCache.get(fontPath);
  if (
    cached &&
    cached.fileSize === stat.size &&
    cached.mtimeMs === stat.mtimeMs
  ) {
    return cached.inspection;
  }
  const inspection = dependencies.inspectFontBuffer(
    dependencies.readFontFile(fontPath),
  );
  inspectionCache.set(fontPath, {
    fileSize: stat.size,
    mtimeMs: stat.mtimeMs,
    inspection,
  });
  return inspection;
}

function resolveInspectionCache(
  inspectFontBuffer: BuiltInFontMatchingCatalogDependencies["inspectFontBuffer"],
): Map<string, CachedInspection> {
  const existing = inspectionCacheByInspector.get(inspectFontBuffer);
  if (existing) return existing;
  const created = new Map<string, CachedInspection>();
  inspectionCacheByInspector.set(inspectFontBuffer, created);
  return created;
}

function resolveBuiltInFontPath(
  relativePath: string,
  dependencies: BuiltInFontMatchingCatalogDependencies,
  directoryEntries: Map<string, readonly string[] | null>,
): string | null {
  const flattenedName = basename(relativePath);
  for (const root of dependencies.assetRoots) {
    const exactCandidates = [
      join(root, relativePath),
      join(root, flattenedName),
    ];
    for (const candidate of exactCandidates) {
      if (isFontFile(candidate, dependencies)) {
        return candidate;
      }
    }

    const entries = readDirectoryOnce(root, dependencies, directoryEntries);
    if (!entries) {
      continue;
    }
    const hashedName = entries
      .filter((entry) => isHashedAssetName(flattenedName, entry))
      .sort(compareAscii)[0];
    if (hashedName) {
      const candidate = join(root, hashedName);
      if (isFontFile(candidate, dependencies)) {
        return candidate;
      }
    }
  }
  return null;
}

function readDirectoryOnce(
  path: string,
  dependencies: BuiltInFontMatchingCatalogDependencies,
  cache: Map<string, readonly string[] | null>,
): readonly string[] | null {
  if (cache.has(path)) {
    return cache.get(path) ?? null;
  }
  try {
    const entries = dependencies.readDirectory(path);
    cache.set(path, entries);
    return entries;
  } catch (_error) {
    cache.set(path, null);
    return null;
  }
}

function isFontFile(
  path: string,
  dependencies: BuiltInFontMatchingCatalogDependencies,
): boolean {
  try {
    return dependencies.statFontFile(path).isFile();
  } catch (_error) {
    return false;
  }
}

function isHashedAssetName(sourceName: string, candidateName: string): boolean {
  const extension = extname(sourceName);
  const stem = basename(sourceName, extension);
  const expression = new RegExp(
    `^${escapeRegExp(stem)}-[A-Za-z0-9_-]{6,}${escapeRegExp(extension)}$`,
    "i",
  );
  return expression.test(candidateName);
}

function resolveProductionAssetRoots(): string[] {
  const roots = [
    resolve(__dirname, "../renderer/src/assets/fonts"),
    resolve(__dirname, "../../src/renderer/src/assets/fonts"),
    resolve(__dirname, "../renderer/assets"),
  ];
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string })
    .resourcesPath;
  if (resourcesPath) {
    roots.push(
      resolve(resourcesPath, "app.asar/out/renderer/assets"),
      resolve(resourcesPath, "app/out/renderer/assets"),
    );
  }
  roots.push(resolve(process.cwd(), "src/renderer/src/assets/fonts"));
  return uniquePaths(roots);
}

function uniquePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  return paths.filter((path) => {
    const key = process.platform === "win32" ? path.toLowerCase() : path;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
