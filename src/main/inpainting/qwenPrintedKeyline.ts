import type { InpaintingWindowMask } from "./inpaintingEngine";
import { expandRect, mergeMaskIntoPage, type PixelRect } from "./maskGeometry";
import { distanceToMask } from "./pageMaskComposite";
import { maskComponents } from "./rasterMasks";

import { nativeLuminance } from "./qwenOutlinedLettering";

import {
  recordSoundRim,
  matchingHardRims,
  median,
  type Evidence,
  type Witness,
} from "./qwenSoundRim";

type Part = ReturnType<typeof maskComponents>[number];
/** A folio OCR box may brush a panel rule. Recover only its registered
 * digits on the original margin, including their compression shoulders. */
export function recoverQwenFolio(
  bitmap: Buffer,
  size: { width: number; height: number },
  selection: PixelRect,
  text: string,
) {
  const number = text.normalize("NFKC").trim();
  const { x, y, w, h } = selection;
  if (
    !/^\d{1,4}$/u.test(number) ||
    h < 6 ||
    h > 42 ||
    w > 100 ||
    (Math.min(x, size.width - x - w) > 0.12 * size.width &&
      Math.min(y, size.height - y - h) > 0.1 * size.height)
  )
    return;
  const bounds = expandRect(selection, size.width, size.height, 12);
  const tone = nativeLuminance(bitmap, size.width, bounds);
  const dark = tone.map((v) => Number(v < 177));
  const parts = maskComponents(dark, bounds.w, bounds.h, 4);
  const digits = parts.filter(
    ({ rect: r, area }) =>
      r.x + bounds.x >= x - 1 &&
      r.x + r.w + bounds.x <= x + w + 1 &&
      r.y + bounds.y >= y - 1 &&
      r.y + r.h + bounds.y <= y + h + 1 &&
      r.h >= 0.48 * h &&
      r.h <= h + 1 &&
      r.w <= 1.1 * r.h &&
      area >= 0.23 * r.w * r.h,
  );
  if (
    digits.length !== number.length ||
    Math.max(...digits.map((d) => d.rect.y + d.rect.h)) -
      Math.min(...digits.map((d) => d.rect.y + d.rect.h)) >
      0.22 * h
  )
    return;
  const glyph = new Uint8Array(tone.length);
  for (const d of digits) mergeMaskIntoPage(glyph, bounds.w, d.rect, d.data);
  const dist = distanceToMask(glyph, bounds.w, bounds.h);
  const toDrawing = distanceToMask(
    dark.map((v, i) => Number(v && !glyph[i])),
    bounds.w,
    bounds.h,
  );
  const bank = tone
    .filter((_, i) => dist[i] > 3 && dist[i] <= 9 && toDrawing[i] > 3)
    .sort();
  if (bank.length < 40 || bank[Math.floor(0.05 * bank.length)] < 250) return;
  return {
    bounds,
    data: Uint8Array.from(dist, (v, i) =>
      Number(v === 0 || (v <= 3.3 && v < toDrawing[i] && toDrawing[i] > 2.45)),
    ),
  };
}

/** Measure the white print around black text where an exposed sector faces
 * darker material. Sectors facing uninterrupted white paper give no evidence
 * of the radius. Other letters on the same panel have to corroborate it. */
export function measuredPrintedKeyline(
  bounds: InpaintingWindowMask["bounds"],
  instance: Uint8Array,
  tone: Float32Array,
  soundEffect = false,
): InpaintingWindowMask | undefined {
  const { w, h } = bounds;
  const ink = instance.map((v, i) => Number(v && tone[i] < 180));
  const parts = maskComponents(ink, w, h, 20).filter(
    ({ rect, area }) =>
      Math.min(rect.w, rect.h) >= 3 &&
      Math.max(rect.w, rect.h) >= 6 &&
      Math.max(rect.w, rect.h) <= (soundEffect ? 144 : 63) &&
      area < 0.86 * rect.w * rect.h,
  );
  if (parts.length < (soundEffect ? 1 : 3) || parts.length > 250) return;
  const distance = distanceToMask(ink, w, h);
  return completeMeasuredRims(
    parts,
    { bounds, instance, tone, distance },
    soundEffect,
  );
}

function completeMeasuredRims(
  parts: Part[],
  field: {
    bounds: PixelRect;
    instance: Uint8Array;
    tone: Float32Array;
    distance: Float32Array;
  },
  soundEffect: boolean,
) {
  const { bounds, instance, tone, distance } = field,
    { w, h } = bounds;
  const witnesses: Witness[] = [],
    completeRims: Witness[] = [],
    exterior: Evidence[] = [];
  const independent: { part: Part; radius: number }[] = [];
  for (const part of parts) {
    const sector = readSectors(tone, distance, w, h, part);
    if (soundEffect) recordSoundRim(part, sector, completeRims, independent);
    const { x, y, readings } = sector;
    if (Math.max(part.rect.w, part.rect.h) > 63) continue;
    exterior.push(...readings.filter((s) => s.exterior < 0.8));
    const radii = readings.filter((s) => s.radius > 0).map((s) => s.radius);
    if (radii.length) witnesses.push({ x, y, radii });
  }
  // Three neighbouring stems can expose the same hard edge even when pieces
  // of illustration were segmented next to a glyph.
  const confirmed = confirmedRadii(witnesses, exterior)
    ? witnesses
    : matchingHardRims(completeRims);
  if (!confirmed && !independent.length) return;
  const mass = new Float32Array(instance.length),
    reach = new Float32Array(instance.length);
  for (const witness of confirmed ?? []) {
    accumulateRadius(witness, { w, h, distance, instance, mass, reach });
  }
  const data = instance.map((on, i) => {
    if (on || mass[i] <= 0.2) return on;
    const edge = reach[i] / mass[i];
    if (distance[i] > edge) return 0;
    // Near the outside of a measured white border a pale panel rule or
    // halftone dot can be the very first surviving pixel of the drawing.
    return Number(
      distance[i] <= 2.5 || tone[i] >= (distance[i] > edge - 2.4 ? 238 : 207),
    );
  });
  for (const { part, radius } of independent)
    addSingleRim(data, part, radius, tone, w, h);
  return { bounds, data };
}

function addSingleRim(
  data: Uint8Array,
  part: Part,
  radius: number,
  tone: Float32Array,
  w: number,
  h: number,
) {
  const box = expandRect(part.rect, w, h, Math.ceil(radius) + 1);
  const local = new Uint8Array(box.w * box.h);
  mergeMaskIntoPage(
    local,
    box.w,
    { ...part.rect, x: part.rect.x - box.x, y: part.rect.y - box.y },
    part.data,
  );
  const distance = distanceToMask(local, box.w, box.h);
  for (let i = 0; i < local.length; i++) {
    const j = (box.y + Math.floor(i / box.w)) * w + box.x + (i % box.w);
    if (
      distance[i] <= radius &&
      (distance[i] <= 2.5 ||
        tone[j] >= (distance[i] > radius - 2.4 ? 238 : 207))
    )
      data[j] = 1;
  }
}

function readSectors(
  tone: Float32Array,
  distance: Float32Array,
  w: number,
  h: number,
  p: Part,
) {
  const box = expandRect(p.rect, w, h, 18),
    local = new Uint8Array(box.w * box.h);
  const rect = { ...p.rect, x: p.rect.x - box.x, y: p.rect.y - box.y };
  mergeMaskIntoPage(local, box.w, rect, p.data);
  let sx = 0,
    sy = 0;
  for (let i = 0; i < local.length; i++)
    if (local[i]) {
      sx += i % box.w;
      sy += Math.floor(i / box.w);
    }
  const x = sx / p.area,
    y = sy / p.area;
  const own = distanceToMask(local, box.w, box.h),
    counts = new Uint16Array(8 * 17),
    light = new Uint16Array(counts.length);
  for (let i = 0; i < own.length; i++) {
    const r = Math.round(own[i]),
      u = i % box.w,
      v = Math.floor(i / box.w);
    const j = (box.y + v) * w + box.x + u;
    if (r < 2 || r > 16 || Math.abs(own[i] - distance[j]) > 0.25) continue;
    const angle = (Math.atan2(v - y, u - x) + Math.PI) / (2 * Math.PI);
    const index = 17 * Math.min(7, Math.floor(8 * angle)) + r;
    counts[index]++;
    light[index] += Number(tone[j] >= 242);
  }
  const readings: Evidence[] = [];
  for (let a = 0; a < 8; a++) {
    const fractions = Array.from({ length: 15 }, (_, i) => {
      const j = a * 17 + i + 2;
      return counts[j] >= 2 ? light[j] / counts[j] : NaN;
    });
    const evidence = sectorEvidence(fractions);
    if (evidence) readings.push(evidence);
  }
  return { x: x + box.x, y: y + box.y, readings };
}

function sectorEvidence(fractions: number[]): Evidence | undefined {
  const inner = fractions.slice(0, 3).filter(Number.isFinite),
    outer = fractions.slice(8).filter(Number.isFinite);
  if (!inner.length || outer.length < 3) return;
  const interior = median(inner),
    exterior = median(outer);
  let radius = 0;
  if (interior > 0.76 && interior - exterior > 0.18) {
    radius = 2;
    const observed = fractions.map((q) => (Number.isFinite(q) ? q : interior));
    const cutoff = Math.max(0.71, 0.42 * exterior + 0.58 * interior);
    for (let j = 1; j < 12; j++) {
      if ((observed[j] + observed[j + 1]) / 2 < cutoff) break;
      radius = j + 2;
    }
  }
  return { radius, exterior, interior };
}

function confirmedRadii(witnesses: Witness[], exterior: Evidence[]) {
  const radii = witnesses.flatMap((s) => s.radii).sort((a, b) => a - b);
  if (
    witnesses.length < 3 ||
    radii.length < 10 ||
    exterior.length < 8 ||
    radii[Math.floor(0.8 * (radii.length - 1))] -
      radii[Math.floor(0.2 * (radii.length - 1))] >
      4.5
  )
    return false;
  const agrees = (s: Evidence) => s.interior > 0.83;
  const dark = exterior.filter((s) => s.exterior < 0.6);
  if (
    exterior.filter(agrees).length < 0.74 * exterior.length ||
    (dark.length >= 8 && dark.filter(agrees).length < 0.7 * dark.length)
  )
    return false;
  return true;
}

function accumulateRadius(
  { x, y, radii }: Witness,
  {
    w,
    h,
    distance,
    instance,
    mass,
    reach,
  }: {
    w: number;
    h: number;
    distance: Float32Array;
    instance: Uint8Array;
    mass: Float32Array;
    reach: Float32Array;
  },
) {
  const radius = median(radii) + 2.5;
  for (
    let v = Math.max(0, Math.floor(y - 90));
    v < Math.min(h, Math.ceil(y + 91));
    v++
  ) {
    const dy = (v - y) ** 2;
    for (
      let u = Math.max(0, Math.floor(x - 90));
      u < Math.min(w, Math.ceil(x + 91));
      u++
    ) {
      const i = v * w + u;
      if (distance[i] > 16 || instance[i]) continue;
      const weight =
        Math.min(4, radii.length) *
        Math.exp(-((u - x) ** 2 + dy) / (2 * 38 ** 2));
      mass[i] += weight;
      reach[i] += weight * radius;
    }
  }
}

/** A loose selection around one sound mark can also contain a sword, hair or
 * screentone. Locate the matte ink inside its own narrow white keyline. */
export function recoverQwenIsolatedMark(
  bitmap: Buffer,
  size: { width: number; height: number },
  selection: PixelRect,
): InpaintingWindowMask | undefined {
  const { w, h } = selection;
  if (
    Math.min(w, h) < 26 ||
    Math.max(w, h) > 0.24 * Math.min(size.width, size.height)
  )
    return;
  const bounds = expandRect(selection, size.width, size.height, 13);
  const tone = nativeLuminance(bitmap, size.width, bounds);
  const dark = tone.map((v) => Number(v < 180));
  const mark = singlePrintedStroke(dark, bounds, selection);
  if (!mark) return;
  const core = new Uint8Array(tone.length);
  mergeMaskIntoPage(core, bounds.w, mark.rect, mark.data);
  const distance = distanceToMask(core, bounds.w, bounds.h);
  if (!hasMatteInk(tone, distance, core, mark.area)) return;
  // Only the exterior edge can tell a white keyline from unprinted paper.
  // Preserve dark screen dots as soon as they reappear around the contour.
  const cap = Math.min(12, Math.max(7, Math.round(0.15 * Math.min(w, h))));
  const edge = isolatedShoulder(tone, distance, cap);
  return {
    bounds,
    data: core.map((set, i) =>
      Number(
        set ||
          distance[i] <= 2.5 ||
          (distance[i] <= edge + 1.2 && tone[i] >= 103),
      ),
    ),
  };
}

function singlePrintedStroke(
  dark: Uint8Array,
  bounds: PixelRect,
  selection: PixelRect,
) {
  const { w, h } = selection;
  const parts = maskComponents(dark, bounds.w, bounds.h, 9);
  const inside = parts.filter(
    ({ rect }) =>
      rect.x + bounds.x >= selection.x &&
      rect.y + bounds.y >= selection.y &&
      rect.x + rect.w + bounds.x <= selection.x + w &&
      rect.y + rect.h + bounds.y <= selection.y + h,
  );
  const mark = inside[0];
  if (
    !mark ||
    mark.rect.w < 0.51 * w ||
    mark.rect.h < 0.54 * h ||
    mark.area < 0.065 * w * h ||
    mark.area > 0.48 * w * h ||
    inside.slice(1).some((p) => p.area > Math.max(17, 0.055 * mark.area))
  )
    return;
  return mark;
}

function hasMatteInk(
  tone: Uint8Array,
  distance: Float32Array,
  core: Uint8Array,
  area: number,
) {
  const samples = tone
    .filter((_, i) => distance[i] >= 1.8 && distance[i] <= 2.5)
    .sort();
  if (
    samples.length < 45 ||
    samples[Math.floor(0.06 * samples.length)] < 233 ||
    samples[samples.length >> 1] < 247
  )
    return false;
  const interior = tone.filter((v, i) => core[i] && v < 90).sort();
  if (
    interior.length < 0.6 * area ||
    interior[Math.floor(0.8 * interior.length)] -
      interior[Math.floor(0.2 * interior.length)] >
      24
  )
    return false;
  return true;
}

function isolatedShoulder(
  tone: Uint8Array,
  distance: Float32Array,
  cap: number,
) {
  const rings = Array.from({ length: cap + 1 }, () => [] as number[]);
  for (let i = 0; i < tone.length; i++) {
    const r = Math.round(distance[i]);
    if (r >= 3 && r <= cap) rings[r].push(tone[i]);
  }
  let edge = 3;
  for (let r = 3; r <= cap; r++) {
    const samples = rings[r].sort((a, b) => a - b);
    if (samples.length < 12 || samples[Math.floor(0.08 * samples.length)] < 238)
      break;
    edge = r + 1;
  }
  return edge;
}
