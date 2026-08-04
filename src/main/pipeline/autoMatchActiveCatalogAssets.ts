import { lstatSync, readFileSync, realpathSync, readdirSync } from "node:fs";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { createHash } from "node:crypto";
import {
  AutoMatchActiveCatalogError,
  type AutoMatchActiveCatalogDependencies,
  type AutoMatchFontAssetDescriptor,
  type InstalledAutoMatchFontAsset,
} from "./autoMatchActiveCatalogTypes";

export function productionActiveCatalogDependencies(
  assetRoots: readonly string[],
): AutoMatchActiveCatalogDependencies {
  return {
    assetRoots,
    readDirectory: (path) => readdirSync(path),
    readFile: (path) => readFileSync(path),
    realPath: (path) => realpathSync(path),
    statFile: (path) => lstatSync(path),
  };
}

export function resolveAndVerifyActiveFontAsset(
  expected: AutoMatchFontAssetDescriptor,
  dependencies: AutoMatchActiveCatalogDependencies,
  directoryEntries: Map<string, readonly string[] | null>,
): InstalledAutoMatchFontAsset {
  const resolvedFile = resolveAssetFile(
    expected.file,
    dependencies,
    directoryEntries,
  );
  if (!resolvedFile) {
    throw new AutoMatchActiveCatalogError(
      `Active font asset is missing: ${expected.file}`,
    );
  }
  const stat = dependencies.statFile(resolvedFile);
  const bytes = dependencies.readFile(resolvedFile);
  if (!matchesAssetDescriptor(expected, stat, bytes)) {
    throw new AutoMatchActiveCatalogError(
      `Active font asset hash/size mismatch: ${expected.file}`,
    );
  }
  return { ...expected, resolvedFile };
}

function matchesAssetDescriptor(
  expected: AutoMatchFontAssetDescriptor,
  stat: ReturnType<AutoMatchActiveCatalogDependencies["statFile"]>,
  bytes: Buffer,
): boolean {
  return (
    stat.isFile() &&
    !stat.isSymbolicLink() &&
    stat.size === expected.byteSize &&
    bytes.byteLength === expected.byteSize &&
    sha256(bytes) === expected.sha256
  );
}

function resolveAssetFile(
  sourceFile: string,
  dependencies: AutoMatchActiveCatalogDependencies,
  directoryEntries: Map<string, readonly string[] | null>,
): string | null {
  const normalized = sourceFile.replaceAll("\\", "/");
  const relativeToFonts = pathRelativeToFonts(normalized);
  const exactMatches = dependencies.assetRoots
    .map((root) =>
      resolveSafeAssetMatch(root, join(root, relativeToFonts), dependencies),
    )
    .filter(isPresent);
  const exact = uniqueAssetMatch(exactMatches, dependencies, "exact suffix");
  if (exact) return exact;
  return resolveHashedAsset(
    basename(normalized),
    dependencies,
    directoryEntries,
  );
}

function pathRelativeToFonts(normalized: string): string {
  const fontsMarker = "/assets/fonts/";
  const markerIndex = normalized.lastIndexOf(fontsMarker);
  return markerIndex >= 0
    ? normalized.slice(markerIndex + fontsMarker.length)
    : basename(normalized);
}

function resolveHashedAsset(
  flatName: string,
  dependencies: AutoMatchActiveCatalogDependencies,
  directoryEntries: Map<string, readonly string[] | null>,
): string | null {
  const matches: string[] = [];
  for (const root of dependencies.assetRoots) {
    const entries = readDirectoryOnce(root, dependencies, directoryEntries);
    for (const hashedName of matchingHashedNames(flatName, entries)) {
      const match = resolveSafeAssetMatch(
        root,
        join(root, hashedName),
        dependencies,
      );
      if (match) matches.push(match);
    }
  }
  return uniqueAssetMatch(matches, dependencies, "hashed basename");
}

function matchingHashedNames(
  sourceName: string,
  entries: readonly string[] | null,
): string[] {
  return (entries ?? [])
    .filter((entry) => isHashedAssetName(sourceName, entry))
    .sort(compareAscii);
}

function resolveSafeAssetMatch(
  root: string,
  candidate: string,
  dependencies: AutoMatchActiveCatalogDependencies,
): string | null {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  if (!isSameOrDescendant(resolvedRoot, resolvedCandidate)) return null;
  const candidateStat = safeStat(resolvedCandidate, dependencies);
  if (!candidateStat) return null;
  assertUnlinkedCandidate(resolvedCandidate, candidateStat);
  if (!candidateStat.isFile()) return null;
  assertUnlinkedAncestors(resolvedRoot, resolvedCandidate, dependencies);
  if (!safeStat(resolvedRoot, dependencies)?.isDirectory()) return null;
  return verifyRealPathContainment(
    resolvedRoot,
    resolvedCandidate,
    dependencies,
  );
}

function assertUnlinkedCandidate(
  candidate: string,
  stat: ReturnType<AutoMatchActiveCatalogDependencies["statFile"]>,
): void {
  if (stat.isSymbolicLink()) {
    throw new AutoMatchActiveCatalogError(
      `Active font asset path is linked: ${candidate}`,
    );
  }
}

function assertUnlinkedAncestors(
  root: string,
  candidate: string,
  dependencies: AutoMatchActiveCatalogDependencies,
): void {
  let cursor = candidate;
  while (true) {
    const stat = safeStat(cursor, dependencies);
    if (!stat) return;
    if (stat.isSymbolicLink()) {
      throw new AutoMatchActiveCatalogError(
        `Active font asset ancestor is linked: ${cursor}`,
      );
    }
    if (cursor === root) return;
    const parent = dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}

function verifyRealPathContainment(
  root: string,
  candidate: string,
  dependencies: AutoMatchActiveCatalogDependencies,
): string | null {
  let realRoot: string;
  let realCandidate: string;
  try {
    realRoot = dependencies.realPath(root);
    realCandidate = dependencies.realPath(candidate);
  } catch (_error) {
    return null;
  }
  if (!isSameOrDescendant(realRoot, realCandidate)) {
    throw new AutoMatchActiveCatalogError(
      `Active font asset escapes its allowed root: ${candidate}`,
    );
  }
  return candidate;
}

function uniqueAssetMatch(
  matches: readonly string[],
  dependencies: AutoMatchActiveCatalogDependencies,
  kind: string,
): string | null {
  const unique = new Map<string, string>();
  for (const match of matches) {
    const realMatch = safeRealPath(match, dependencies);
    if (!realMatch) continue;
    const key =
      process.platform === "win32" ? realMatch.toLowerCase() : realMatch;
    unique.set(key, match);
  }
  if (unique.size > 1) {
    throw new AutoMatchActiveCatalogError(
      `Active font asset ${kind} resolution is ambiguous.`,
    );
  }
  return unique.values().next().value ?? null;
}

function safeRealPath(
  path: string,
  dependencies: AutoMatchActiveCatalogDependencies,
): string | null {
  try {
    return dependencies.realPath(path);
  } catch (_error) {
    return null;
  }
}

function isSameOrDescendant(root: string, candidate: string): boolean {
  const child = relative(resolve(root), resolve(candidate));
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function readDirectoryOnce(
  root: string,
  dependencies: AutoMatchActiveCatalogDependencies,
  cache: Map<string, readonly string[] | null>,
): readonly string[] | null {
  if (cache.has(root)) return cache.get(root) ?? null;
  try {
    const entries = dependencies.readDirectory(root);
    cache.set(root, entries);
    return entries;
  } catch (_error) {
    cache.set(root, null);
    return null;
  }
}

export function safeActiveCatalogStat(
  path: string,
  dependencies: AutoMatchActiveCatalogDependencies,
): ReturnType<AutoMatchActiveCatalogDependencies["statFile"]> | null {
  try {
    return dependencies.statFile(path);
  } catch (_error) {
    return null;
  }
}

function safeStat(
  path: string,
  dependencies: AutoMatchActiveCatalogDependencies,
): ReturnType<AutoMatchActiveCatalogDependencies["statFile"]> | null {
  return safeActiveCatalogStat(path, dependencies);
}

function isHashedAssetName(sourceName: string, candidateName: string): boolean {
  const extension = extname(sourceName);
  const stem = basename(sourceName, extension);
  return new RegExp(
    `^${escapeRegExp(stem)}-[A-Za-z0-9_-]{6,}${escapeRegExp(extension)}$`,
    "iu",
  ).test(candidateName);
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isPresent<T>(value: T | null): value is T {
  return value !== null;
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
