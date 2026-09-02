import type { SourceTextDirection } from "../../shared/textTypes";
import {
  buildCrossProfile,
  clamp,
  median,
  quantile,
  relativeDispersion,
} from "./sourceFontSizeMath";
import type { SourceFontCoreMask } from "./sourceFontSizeRaster";
import { selectLineBands } from "./sourceFontSizeProjectionBands";

const NEIGHBOR_OFFSETS = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
] as const;

type Band = readonly [number, number];

type Component = Readonly<{
  area: number;
  pixels: readonly number[];
  rasterWidth: number;
  x1: number;
  x2: number;
  y1: number;
  y2: number;
}>;

type ComponentCluster = Readonly<{
  components: readonly Component[];
  face: number;
  majorSpan: number;
  mass: number;
  score: number;
}>;

export type ComponentAffinityMeasurement = Readonly<{
  componentCount: number;
  confidence: number;
  lineCount: number;
  primaryFace: number;
  primaryMassShare: number;
  secondaryFace?: number;
}>;

/**
 * Independently measure a repeated glyph scale from connected-component
 * affinity. Projection bands supply only line ownership; component scale,
 * spacing and overlap decide which pixels belong to the body or ruby mode.
 */
export function measureComponentAffinity(
  core: SourceFontCoreMask,
  direction: SourceTextDirection,
  expectedLines: number,
): ComponentAffinityMeasurement | null {
  const components = collectComponents(core);
  if (components.length === 0) return null;
  const profile = buildCrossProfile(core, direction);
  const bands = selectLineBands(profile, expectedLines);
  const lineCross = profile.length / Math.max(1, expectedLines);
  const clustersByBand = bands.map((band) =>
    clusterBandComponents(
      components.filter((component) =>
        componentBelongsToBand(component, band, direction),
      ),
      direction,
      lineCross,
    ),
  );
  const primaryByBand = clustersByBand.map(
    (clusters) =>
      clusters.find(
        (cluster) => cluster.face >= Math.max(4, lineCross * 0.22),
      ) ?? null,
  );
  const primaryClusters = primaryByBand.flatMap((cluster) =>
    cluster ? [cluster] : [],
  );
  if (primaryClusters.length === 0) return null;
  const primaryFaces = primaryClusters.map((cluster) => cluster.face);
  const primaryFace = median(primaryFaces);
  const dispersion = relativeDispersion(primaryFaces);
  if (!Number.isFinite(primaryFace) || primaryFace < 4 || dispersion > 0.45) {
    return null;
  }
  const primaryMass = primaryClusters.reduce(
    (sum, cluster) => sum + cluster.mass,
    0,
  );
  const totalMass = components.reduce(
    (sum, component) => sum + component.area,
    0,
  );
  const primaryMassShare = primaryMass / Math.max(1, totalMass);
  const secondaryFaces = clustersByBand.flatMap((clusters, bandIndex) =>
    clusters
      .filter(
        (cluster) =>
          cluster !== primaryByBand[bandIndex] &&
          cluster.face <= primaryFace * 0.78 &&
          cluster.mass >=
            Math.max(4, (primaryByBand[bandIndex]?.mass ?? 0) * 0.04),
      )
      .map((cluster) => cluster.face),
  );
  const confidence = clamp(
    0.5 +
      Math.min(0.16, primaryClusters.length * 0.05) +
      Math.min(0.12, Math.log1p(components.length) * 0.035) +
      Math.min(0.1, primaryMassShare * 0.12) -
      dispersion * 0.28,
    0.45,
    0.94,
  );
  const secondaryFace =
    secondaryFaces.length > 0 ? median(secondaryFaces) : undefined;
  return {
    componentCount: components.length,
    confidence,
    lineCount: primaryClusters.length,
    primaryFace,
    primaryMassShare,
    ...(secondaryFace === undefined ? {} : { secondaryFace }),
  };
}

function clusterBandComponents(
  components: readonly Component[],
  direction: SourceTextDirection,
  lineCross: number,
): ComponentCluster[] {
  if (components.length === 0) return [];
  const groups = new DisjointSet(components.length);
  for (let left = 0; left < components.length; left += 1) {
    for (let right = left + 1; right < components.length; right += 1) {
      if (
        componentsHaveAffinity(
          components[left],
          components[right],
          direction,
          lineCross,
        )
      ) {
        groups.union(left, right);
      }
    }
  }
  const byRoot = new Map<number, Component[]>();
  components.forEach((component, index) => {
    const root = groups.find(index);
    byRoot.set(root, [...(byRoot.get(root) ?? []), component]);
  });
  return [...byRoot.values()]
    .map((members) => describeCluster(members, direction))
    .filter(
      (cluster) =>
        cluster.face >= 3 &&
        cluster.face <= lineCross * 1.18 &&
        (cluster.components.length >= 2 ||
          cluster.majorSpan >= cluster.face * 1.2),
    )
    .sort((left, right) => right.score - left.score || right.mass - left.mass);
}

function componentsHaveAffinity(
  first: Component,
  second: Component,
  direction: SourceTextDirection,
  lineCross: number,
): boolean {
  const firstCross = componentCrossSpan(first, direction);
  const secondCross = componentCrossSpan(second, direction);
  const scaleAgreement =
    Math.min(firstCross, secondCross) / Math.max(1, firstCross, secondCross);
  const crossOverlap = componentAxisOverlap(
    first,
    second,
    direction === "vertical" ? 0 : 1,
  );
  const majorOverlap = componentAxisOverlap(
    first,
    second,
    direction === "vertical" ? 1 : 0,
  );
  const crossGap = componentAxisGap(
    first,
    second,
    direction === "vertical" ? 0 : 1,
  );
  const majorGap = componentAxisGap(
    first,
    second,
    direction === "vertical" ? 1 : 0,
  );
  const scale = Math.max(firstCross, secondCross);
  const aligned = crossOverlap >= 0.15 || crossGap <= Math.max(2, scale * 0.28);
  const adjacent = majorGap <= Math.max(3, scale * 1.65, lineCross * 1.4);
  const nestedStroke = crossOverlap >= 0.35 && majorOverlap >= 0.2;
  return aligned && adjacent && (scaleAgreement >= 0.32 || nestedStroke);
}

function describeCluster(
  components: readonly Component[],
  direction: SourceTextDirection,
): ComponentCluster {
  const pixels = components.flatMap((component) => component.pixels);
  const crossPositions = pixels
    .map((pixel) =>
      direction === "vertical"
        ? pixel % (components[0]?.rasterWidth ?? 1)
        : Math.floor(pixel / (components[0]?.rasterWidth ?? 1)),
    )
    .sort((left, right) => left - right);
  const face =
    quantile(crossPositions, 0.995) - quantile(crossPositions, 0.005) + 1;
  const majorLow = Math.min(
    ...components.map((component) =>
      direction === "vertical" ? component.y1 : component.x1,
    ),
  );
  const majorHigh = Math.max(
    ...components.map((component) =>
      direction === "vertical" ? component.y2 : component.x2,
    ),
  );
  const majorSpan = majorHigh - majorLow;
  const mass = components.reduce((sum, component) => sum + component.area, 0);
  const repetition = Math.min(4, majorSpan / Math.max(1, face));
  const score =
    mass *
    (1 + repetition * 0.18) *
    (1 + Math.min(10, components.length) * 0.025);
  return { components, face, majorSpan, mass, score };
}

function componentBelongsToBand(
  component: Component,
  [start, end]: Band,
  direction: SourceTextDirection,
): boolean {
  const center =
    direction === "vertical"
      ? (component.x1 + component.x2) / 2
      : (component.y1 + component.y2) / 2;
  return center >= start && center < end;
}

function componentCrossSpan(
  component: Component,
  direction: SourceTextDirection,
): number {
  return direction === "vertical"
    ? component.x2 - component.x1
    : component.y2 - component.y1;
}

function componentAxisGap(
  first: Component,
  second: Component,
  axis: 0 | 1,
): number {
  const firstLow = axis === 0 ? first.x1 : first.y1;
  const firstHigh = axis === 0 ? first.x2 : first.y2;
  const secondLow = axis === 0 ? second.x1 : second.y1;
  const secondHigh = axis === 0 ? second.x2 : second.y2;
  return Math.max(
    0,
    Math.max(firstLow, secondLow) - Math.min(firstHigh, secondHigh),
  );
}

function componentAxisOverlap(
  first: Component,
  second: Component,
  axis: 0 | 1,
): number {
  const firstLow = axis === 0 ? first.x1 : first.y1;
  const firstHigh = axis === 0 ? first.x2 : first.y2;
  const secondLow = axis === 0 ? second.x1 : second.y1;
  const secondHigh = axis === 0 ? second.x2 : second.y2;
  const overlap = Math.max(
    0,
    Math.min(firstHigh, secondHigh) - Math.max(firstLow, secondLow),
  );
  return (
    overlap /
    Math.max(1, Math.min(firstHigh - firstLow, secondHigh - secondLow))
  );
}

function collectComponents(core: SourceFontCoreMask): Component[] {
  const visited = new Uint8Array(core.mask.length);
  const queue = new Int32Array(core.mask.length);
  const components: Component[] = [];
  for (let origin = 0; origin < core.mask.length; origin += 1) {
    if (!core.mask[origin] || visited[origin]) continue;
    components.push(collectComponent(core, origin, visited, queue));
  }
  return components;
}

function collectComponent(
  core: SourceFontCoreMask,
  origin: number,
  visited: Uint8Array,
  queue: Int32Array,
): Component {
  let head = 0;
  let tail = 1;
  let x1 = core.width;
  let y1 = core.height;
  let x2 = 0;
  let y2 = 0;
  const pixels: number[] = [];
  queue[0] = origin;
  visited[origin] = 1;
  while (head < tail) {
    const pixel = queue[head++] ?? 0;
    const x = pixel % core.width;
    const y = Math.floor(pixel / core.width);
    pixels.push(pixel);
    x1 = Math.min(x1, x);
    y1 = Math.min(y1, y);
    x2 = Math.max(x2, x + 1);
    y2 = Math.max(y2, y + 1);
    for (const [offsetX, offsetY] of NEIGHBOR_OFFSETS) {
      const next = resolveNeighbor(core, x + offsetX, y + offsetY, visited);
      if (next === null) continue;
      visited[next] = 1;
      queue[tail++] = next;
    }
  }
  return {
    area: pixels.length,
    pixels,
    rasterWidth: core.width,
    x1,
    x2,
    y1,
    y2,
  };
}

function resolveNeighbor(
  core: SourceFontCoreMask,
  x: number,
  y: number,
  visited: Uint8Array,
): number | null {
  if (x < 0 || y < 0 || x >= core.width || y >= core.height) return null;
  const next = y * core.width + x;
  return core.mask[next] && !visited[next] ? next : null;
}

class DisjointSet {
  private readonly parents: number[];

  constructor(size: number) {
    this.parents = Array.from({ length: size }, (_unused, index) => index);
  }

  find(value: number): number {
    const parent = this.parents[value];
    if (parent !== value) this.parents[value] = this.find(parent);
    return this.parents[value] ?? value;
  }

  union(first: number, second: number): void {
    const left = this.find(first);
    const right = this.find(second);
    if (left !== right)
      this.parents[Math.max(left, right)] = Math.min(left, right);
  }
}
