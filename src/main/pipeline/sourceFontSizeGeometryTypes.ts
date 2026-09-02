export type SourceFontSizeEstimate = Readonly<{
  confidence: number;
  facePx: number;
  method: "raster-core-v1";
}>;

export type SourceFontSizeGeometryOptions = Readonly<{
  componentAffinity?: boolean;
  geometryConsensus?: boolean;
  /** Laboratory ablations may lock a candidate line count. */
  lineCountOverride?: number;
}>;
