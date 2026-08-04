import type { AutomaticFontCandidate } from "../../shared/fontMatchingTypes";
import type { UiLocale } from "../../shared/uiLocales";
import {
  productionActiveCatalogDependencies,
  resolveAndVerifyActiveFontAsset,
  safeActiveCatalogStat,
} from "./autoMatchActiveCatalogAssets";
import { parseAutoMatchActiveCatalog } from "./autoMatchActiveCatalogContract";
import {
  AutoMatchActiveCatalogError,
  type AutoMatchActiveCandidateSelection,
  type AutoMatchActiveCatalog,
  type AutoMatchActiveCatalogDependencies,
  type InstalledAutoMatchCandidate,
} from "./autoMatchActiveCatalogTypes";

const MAX_ACTIVE_CATALOG_BYTES = 8 * 1024 * 1024;

export function loadAutoMatchActiveCandidateSelection({
  activeCatalogPath,
  assetRoots,
  builtInCandidates,
  targetLocale,
}: {
  activeCatalogPath: string;
  assetRoots: readonly string[];
  builtInCandidates: readonly AutomaticFontCandidate[];
  targetLocale: UiLocale;
}): AutoMatchActiveCandidateSelection {
  return loadAutoMatchActiveCandidateSelectionWith({
    activeCatalogPath,
    builtInCandidates,
    dependencies: productionActiveCatalogDependencies(assetRoots),
    targetLocale,
  });
}

export function loadAutoMatchActiveCandidateSelectionWith({
  activeCatalogPath,
  builtInCandidates,
  dependencies,
  targetLocale,
}: {
  activeCatalogPath: string;
  builtInCandidates: readonly AutomaticFontCandidate[];
  dependencies: AutoMatchActiveCatalogDependencies;
  targetLocale: UiLocale;
}): AutoMatchActiveCandidateSelection {
  assertSafeCatalogFile(activeCatalogPath, dependencies);
  const activeCatalog = readActiveCatalog(activeCatalogPath, dependencies);
  assertCatalogLocale(activeCatalog, targetLocale);
  const candidatesById = indexBuiltInCandidates(builtInCandidates);
  return selectInstalledCandidates(activeCatalog, candidatesById, dependencies);
}

function assertSafeCatalogFile(
  activeCatalogPath: string,
  dependencies: AutoMatchActiveCatalogDependencies,
): void {
  const catalogStat = safeActiveCatalogStat(activeCatalogPath, dependencies);
  if (
    !catalogStat?.isFile() ||
    catalogStat.isSymbolicLink() ||
    catalogStat.size <= 0 ||
    catalogStat.size > MAX_ACTIVE_CATALOG_BYTES
  ) {
    throw new AutoMatchActiveCatalogError(
      "Active auto-match catalog is missing or unsafe.",
    );
  }
}

function readActiveCatalog(
  activeCatalogPath: string,
  dependencies: AutoMatchActiveCatalogDependencies,
): AutoMatchActiveCatalog {
  let rawRecord: unknown;
  try {
    rawRecord = JSON.parse(
      dependencies.readFile(activeCatalogPath).toString("utf8"),
    );
  } catch (_error) {
    throw new AutoMatchActiveCatalogError(
      "Active auto-match catalog is invalid.",
    );
  }
  const activeCatalog = parseAutoMatchActiveCatalog(rawRecord);
  if (!activeCatalog) {
    throw new AutoMatchActiveCatalogError(
      "Active auto-match catalog failed its sealed contract.",
    );
  }
  return activeCatalog;
}

function assertCatalogLocale(
  activeCatalog: AutoMatchActiveCatalog,
  targetLocale: UiLocale,
): void {
  if (activeCatalog.locale !== targetLocale) {
    throw new AutoMatchActiveCatalogError(
      `Active auto-match catalog locale ${activeCatalog.locale} does not match ${targetLocale}.`,
    );
  }
}

function indexBuiltInCandidates(
  builtInCandidates: readonly AutomaticFontCandidate[],
): Map<string, AutomaticFontCandidate> {
  const candidatesById = new Map<string, AutomaticFontCandidate>();
  for (const candidate of builtInCandidates) {
    if (candidate.source !== "built-in") continue;
    if (candidatesById.has(candidate.fontId)) {
      throw new AutoMatchActiveCatalogError(
        "Installed built-in auto-match candidate inventory is not unique.",
      );
    }
    candidatesById.set(candidate.fontId, candidate);
  }
  return candidatesById;
}

function selectInstalledCandidates(
  activeCatalog: AutoMatchActiveCatalog,
  candidatesById: ReadonlyMap<string, AutomaticFontCandidate>,
  dependencies: AutoMatchActiveCatalogDependencies,
): AutoMatchActiveCandidateSelection {
  const candidates: AutomaticFontCandidate[] = [];
  const installedCandidates: InstalledAutoMatchCandidate[] = [];
  const directoryEntries = new Map<string, readonly string[] | null>();
  for (const activeCandidate of activeCatalog.candidates) {
    const candidate = candidatesById.get(activeCandidate.candidateId);
    if (!candidate) {
      throw new AutoMatchActiveCatalogError(
        `Active candidate is not installed: ${activeCandidate.candidateId}`,
      );
    }
    const assets = activeCandidate.assets.map((asset) =>
      resolveAndVerifyActiveFontAsset(asset, dependencies, directoryEntries),
    );
    candidates.push(candidate);
    installedCandidates.push({
      candidateId: activeCandidate.candidateId,
      assets,
    });
  }
  return { activeCatalog, candidates, installedCandidates };
}
