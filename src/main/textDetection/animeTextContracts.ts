export type AnimeTextRegion = {
  labelId: number;
  label: string;
  score: number;
  bbox: [number, number, number, number];
};

export type AnimeTextDetection = {
  imageWidth: number;
  imageHeight: number;
  variant: "n";
  regions: AnimeTextRegion[];
};

export function parseAnimeTextDetection(value: unknown): AnimeTextDetection {
  const record = requireRecord(value, "anime text detection");
  const imageWidth = requirePositiveInteger(record.imageWidth, "imageWidth");
  const imageHeight = requirePositiveInteger(record.imageHeight, "imageHeight");
  if (record.variant !== "n") {
    throw new Error("anime text detector returned an unexpected variant.");
  }
  if (!Array.isArray(record.regions)) {
    throw new Error("anime text detector response has no regions array.");
  }
  return {
    imageWidth,
    imageHeight,
    variant: "n",
    regions: record.regions.map((region, index) => parseRegion(region, index)),
  };
}

function parseRegion(value: unknown, index: number): AnimeTextRegion {
  const record = requireRecord(value, `region ${index + 1}`);
  const score = Number(record.score);
  if (!Number.isFinite(score) || score < 0 || score > 1) {
    throw new Error(`anime text region ${index + 1} has an invalid score.`);
  }
  if (
    !Array.isArray(record.bbox) ||
    record.bbox.length !== 4 ||
    !record.bbox.every((coordinate) => Number.isFinite(Number(coordinate)))
  ) {
    throw new Error(`anime text region ${index + 1} has an invalid bbox.`);
  }
  const bbox = record.bbox.map(Number) as [number, number, number, number];
  if (bbox[2] <= bbox[0] || bbox[3] <= bbox[1]) {
    throw new Error(`anime text region ${index + 1} has an empty bbox.`);
  }
  return {
    labelId: requireNonNegativeInteger(record.labelId, "labelId"),
    label: String(record.label ?? ""),
    score,
    bbox,
  };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requirePositiveInteger(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return number;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return number;
}
