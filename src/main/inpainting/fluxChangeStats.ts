export type MaskedRegionChangeStats = {
  maskedPixels: number;
  changedPixels: number;
  changedRatio: number;
  meanDelta: number;
};

export function isMaskedRegionEffectivelyUnchanged(
  stats: Pick<
    MaskedRegionChangeStats,
    "changedPixels" | "changedRatio" | "meanDelta"
  >,
): boolean {
  return (
    stats.changedPixels <= 0 &&
    stats.changedRatio < 0.0001 &&
    stats.meanDelta < 0.1
  );
}

export function measureMaskedRegionChange(
  before: Buffer,
  after: Buffer,
  mask: Uint8Array,
): MaskedRegionChangeStats {
  let maskedPixels = 0;
  let changedPixels = 0;
  let totalDelta = 0;
  const pixelCount = Math.min(
    mask.length,
    Math.floor(before.length / 4),
    Math.floor(after.length / 4),
  );
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    if (!mask[pixel]) {
      continue;
    }
    const offset = pixel * 4;
    const delta =
      Math.abs((before[offset] ?? 0) - (after[offset] ?? 0)) +
      Math.abs((before[offset + 1] ?? 0) - (after[offset + 1] ?? 0)) +
      Math.abs((before[offset + 2] ?? 0) - (after[offset + 2] ?? 0));
    maskedPixels += 1;
    totalDelta += delta;
    if (delta >= 8) {
      changedPixels += 1;
    }
  }
  return {
    maskedPixels,
    changedPixels,
    changedRatio: maskedPixels > 0 ? changedPixels / maskedPixels : 0,
    meanDelta: maskedPixels > 0 ? totalDelta / maskedPixels : 0,
  };
}
