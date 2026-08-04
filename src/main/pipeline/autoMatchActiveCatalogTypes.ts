import type { Stats } from "node:fs";
import type { AutomaticFontCandidate } from "../../shared/fontMatchingTypes";

export type AutoMatchFontAssetDescriptor = Readonly<{
  faceId: string;
  file: string;
  byteSize: number;
  sha256: string;
}>;

export type AutoMatchCandidateDisposition = Readonly<{
  action: string;
  activeReleaseEligible: boolean;
  allUnrenderable: false;
  deployableOpportunityCount: number | null;
  evidenceSource: "prior_production_catalog" | "v5_catalog_disposition";
  safeCount: number | null;
  terminal: true;
}>;

export type AutoMatchActiveCandidate = Readonly<{
  candidateId: string;
  assets: readonly AutoMatchFontAssetDescriptor[];
  disposition: AutoMatchCandidateDisposition;
}>;

export type AutoMatchActiveCatalog = Readonly<{
  catalogVersion: string;
  locale: "ko";
  candidateIds: readonly string[];
  candidateOrderSha256: string;
  candidates: readonly AutoMatchActiveCandidate[];
  excludedCandidates: readonly AutoMatchActiveCandidate[];
  recordSha256: string;
  sourceRecords: Readonly<{
    catalogDispositionRecordSha256: string;
    deploymentFontFaceManifestSha256: string;
    deploymentRenderBankManifestSha256: string;
    evidenceFontFaceManifestSha256: string;
    evidenceRenderBankManifestSha256: string;
    finalCatalogRecordSha256: string;
  }>;
}>;

export type InstalledAutoMatchFontAsset = AutoMatchFontAssetDescriptor &
  Readonly<{ resolvedFile: string }>;

export type InstalledAutoMatchCandidate = Readonly<{
  candidateId: string;
  assets: readonly InstalledAutoMatchFontAsset[];
}>;

export type AutoMatchActiveCandidateSelection = Readonly<{
  activeCatalog: AutoMatchActiveCatalog;
  candidates: readonly AutomaticFontCandidate[];
  installedCandidates: readonly InstalledAutoMatchCandidate[];
}>;

type AssetStat = Pick<
  Stats,
  "isDirectory" | "isFile" | "isSymbolicLink" | "size"
>;

export type AutoMatchActiveCatalogDependencies = Readonly<{
  assetRoots: readonly string[];
  readDirectory: (path: string) => readonly string[];
  readFile: (path: string) => Buffer;
  realPath: (path: string) => string;
  statFile: (path: string) => AssetStat;
}>;

export class AutoMatchActiveCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutoMatchActiveCatalogError";
  }
}
