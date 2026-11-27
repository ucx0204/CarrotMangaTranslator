import { makeControlCrop } from "./qwenControlCrop.fixture";
import { expect, it } from "vitest";
import { nativeImage } from "electron";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isIllustratedTitleGroup,
  selectedPrintGroups,
} from "../src/main/inpainting/qwenIllustratedPlate";
import { qwenSamplingSizes } from "../src/main/inpainting/qwenControlSampling";
import { measureDetectedBrush } from "../src/main/inpainting/qwenOutlinedLettering";
import { dilateBinaryMaskDisk } from "../src/main/inpainting/patternMaskMorphology";
import { expandWindowMaskToPage } from "../src/main/inpainting/inpaintingWindowMask";
import { resolvePatternFluxCompositePlan } from "../src/main/inpainting/patternFluxCompositePlan";
import { makeBlock, makePage } from "./unifiedInpaintingUiFixtures";
import { measureNativeBrushInk } from "../src/main/inpainting/qwenBrushInk";
import { ruledBrushKeyline } from "../src/main/inpainting/qwenStockCrossing";
import { completeTaperedSound } from "../src/main/inpainting/qwenHorizontalSound";
import { distanceToMask } from "../src/main/inpainting/pageMaskComposite";
import {
  actionFanCondition,
  crossesScreenedMolding,
} from "../src/main/inpainting/qwenSoundReference";

it("uses registered source and stencil for type crossing a screened molding onto white paper", async () => {
  const size = { width: 240, height: 315 };
  const owned = new Uint8Array(size.width * size.height);
  const scan = Buffer.alloc(owned.length * 4, 255);
  for (let i = 0; i < owned.length; i++) {
    const x = i % size.width,
      y = Math.floor(i / size.width);
    const letter = [44, 100].some(
      (top) =>
        y > top &&
        y < top + 48 &&
        x > 83 &&
        x < 138 &&
        (x < 92 || (y - top) % 18 < 7),
    );
    const dot = [0, 1, 2].some(
      (k) =>
        Math.abs(y - 168 - k * 25) < 4.5 && Math.abs(x - 119 - k * 4) < 4.5,
    );
    owned[i] = Number(letter || dot);
    const screen = y < 92 + 0.65 * x && (x + y) % 3 === 0;
    scan.fill(owned[i] ? 8 : screen ? 146 : 255, 4 * i, 4 * i + 3);
  }
  const marked = dilateBinaryMaskDisk(owned, size.width, size.height, 2);
  expect(
    crossesScreenedMolding(Buffer.alloc(scan.length, 255), marked, size),
  ).toBe(false);
  const runner = makeControlCrop(),
    signal = new AbortController().signal;
  const folder = await mkdtemp(join(tmpdir(), "qwen-molding-"));
  try {
    const source = join(folder, "source.png"),
      mask = join(folder, "mask.png");
    const crop = await runner.prepare(
      nativeImage.createFromBitmap(scan, size),
      marked,
      source,
      signal,
      mask,
    );
    expect(crop.referenceEdit).toBe("screenedMolding");
    expect(crop.nativeSourceMask).toBe(mask);
    expect(qwenSamplingSizes(crop)).toEqual([896, 768, 640, 512]);
    const args = await runner.argumentsFor(
      crop,
      size,
      join(folder, "view.png"),
      join(folder, "out.png"),
      signal,
    );
    const config = JSON.parse(await readFile(args[args.length - 1], "utf8"));
    expect(config).toMatchObject({
      prior: config.mask,
      pairedReference: true,
      steps: 28,
      seed: 20,
      cfg: 2.5,
    });
    expect(config.prompt).toContain("original molding");
    expect(config.negative).toContain("gray spots");
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

it("uses the marked source reference when fine diverging pens meet solid ink under a sound", async () => {
  const size = { width: 265, height: 223 };
  const core = new Uint8Array(size.width * size.height);
  const scan = Buffer.alloc(4 * core.length, 255);
  for (let i = 0; i < core.length; i++) {
    const x = i % size.width,
      y = Math.floor(i / size.width);
    core[i] = Number(
      (x > 121 && x < 129 && y > 64 && y < 161) ||
        (y > 103 && y < 110 && x > 98 && x < 176) ||
        (x > 155 && x < 166 && y > 75 && y < 97),
    );
  }
  const selection = dilateBinaryMaskDisk(core, size.width, size.height, 2);
  for (let i = 0; i < core.length; i++) {
    const x = i % size.width,
      y = Math.floor(i / size.width);
    let gray = y < 156 - 0.8 * (x - 70) ? 7 : 255;
    if (x > 71)
      for (const slope of [-0.1, -0.23, -0.35, -0.49, -0.61, -0.74]) {
        const separation = y - 156 - slope * (x - 70);
        gray = Math.min(
          gray,
          255 - 176 * Math.exp(-0.5 * (separation / 0.59) ** 2),
        );
      }
    scan.fill(
      core[i] ? 8 : selection[i] ? 255 : Math.round(gray),
      4 * i,
      4 * i + 3,
    );
  }
  const flat = Buffer.alloc(scan.length, 255);
  expect(actionFanCondition(flat, selection, size)).toBeUndefined();
  const root = await mkdtemp(join(tmpdir(), "qwen-motion-fan-"));
  const source = join(root, "source.png"),
    signal = new AbortController().signal;
  try {
    const runner = makeControlCrop();
    const prepared = await runner.prepare(
      nativeImage.createFromBitmap(scan, size),
      selection,
      source,
      signal,
      join(root, "mask.png"),
      "sound:",
    );
    expect(prepared.referenceEdit).toBe("actionFan");
    expect(prepared.material?.kind).toBe("solid-impact");
    expect(qwenSamplingSizes(prepared)).toEqual([832, 768, 640, 512]);
    const args = await runner.argumentsFor(
      prepared,
      size,
      source,
      join(root, "out.png"),
      signal,
    );
    const job = JSON.parse(await readFile(args[args.length - 1], "utf8"));
    expect(job).toMatchObject({
      prior: job.mask,
      steps: 28,
      seed: 20,
      cfg: 2.5,
      pairedReference: true,
    });
    expect(job.prompt).toContain("common origin");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function impactPixel(x: number, y: number, includeUpperStroke: boolean) {
  const stem = y < 192 && Math.abs(x - 54 - 0.32 * y) < 13;
  const arm = x > 70 && x < 234 && Math.abs(y - 145 + 0.29 * x) < 8;
  const mark = includeUpperStroke && y < 77 && x > 105 && x < 137;
  return Number(stem || arm || mark);
}

function printedImpact(rim: number, includeUpperStroke: boolean) {
  const width = 340,
    height = 250;
  const bounds = { x: 0, y: 0, w: width, h: height };
  const core = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      core[y * width + x] = impactPixel(x, y, includeUpperStroke);
    }
  }
  const halo = dilateBinaryMaskDisk(core, width, height, rim);
  const owned = core.slice();
  const bitmap = Buffer.alloc(4 * core.length, 255);
  for (let i = 0; i < core.length; i++) {
    const x = i % width,
      y = Math.floor(i / width);
    const ornament = x >= 254 && x < 283 && y > 41 && y < 83;
    if (ornament && x < 265) owned[i] = 1;
    const paper = x < 25 || x > 290 ? 252 : x % 19 < 2 ? 51 : 163;
    const level = core[i] || ornament ? 12 : halo[i] ? 254 : paper;
    bitmap.fill(level, 4 * i, 4 * i + 3);
  }
  return { width, height, bounds, bitmap, owned };
}

it.each([false, true])(
  "recovers the actual white keyline on large solid print clipped by the page edge (%s)",
  (second) => {
    const p = printedImpact(8, second);
    const measure = () =>
      measureDetectedBrush(
        p.bitmap,
        p,
        { bounds: p.bounds, data: p.owned },
        true,
      );
    const found = measure();
    expect(found?.measuredBrush).toBe("solid-impact");
    if (!found) throw Error("The exposed white outline was not recovered");
    const data = expandWindowMaskToPage(found, p.width, p.height);
    expect(data[50 * p.width + 89]).toBe(1);
    expect(data[50 * p.width + 96]).toBe(0);
    expect(data[60 * p.width + 258]).toBe(0);
    expect(data[33 * p.width + 122]).toBe(Number(second));
    p.owned.fill(1);
    expect(measure()).toBeUndefined();
  },
);

it("keeps an unframed dark shape on its original screened background", () => {
  const p = printedImpact(0, false);
  expect(
    measureDetectedBrush(
      p.bitmap,
      p,
      { bounds: p.bounds, data: p.owned },
      true,
    ),
  ).toBeUndefined();
});

it("supplies the original art and measured solid-print stencil to the Qwen worker", async () => {
  const p = printedImpact(8, true);
  const groups = selectedPrintGroups(
    "impact",
    { measuredBrush: "solid-impact", speechBubble: false },
    [],
  );
  const hint = isIllustratedTitleGroup(groups);
  expect(hint).toBe("solid-impact");
  const runner = makeControlCrop();
  const size = { width: p.width, height: p.height };
  const image = nativeImage.createFromBitmap(p.bitmap, size);
  const dir = await mkdtemp(join(tmpdir(), "qwen-solid-print-"));
  const input = join(dir, "source.png");
  const signal = new AbortController().signal;
  try {
    const crop = await runner.prepare(
      image,
      p.owned,
      input,
      signal,
      undefined,
      hint,
    );
    expect(crop.condition).toEqual(p.owned);
    expect(crop.material?.kind).toBe("solid-impact");
    expect(qwenSamplingSizes(crop)).toEqual([896, 768, 640, 512]);
    const args = await runner.argumentsFor(
      crop,
      size,
      input,
      join(dir, "out.png"),
      signal,
    );
    const task = JSON.parse(await readFile(args[args.length - 1], "utf8"));
    expect(task).toMatchObject({
      image: input,
      prior: task.mask,
      pairedReference: true,
      referencePrior: false,
      steps: 28,
      seed: 20,
      cfg: 2.5,
      denoise: 1,
    });
    expect(task.prompt).toContain("printed outline");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it.each([0, 8])(
  "measures a mixed sound and text observation against its original printed border (%i px)",
  (rim) => {
    const p = printedImpact(rim, true);
    const block = {
      ...makeBlock(),
      textRole: "sound" as const,
      sourceText: "ド",
    };
    const shared = {
      box: [0, 0, p.width, p.height] as [number, number, number, number],
      score: 0.97,
      mask: {
        width: p.width,
        height: p.height,
        logits: Float32Array.from(p.owned, (v) => (v ? 10 : -10)),
      },
    };
    const plan = resolvePatternFluxCompositePlan({
      ...p,
      block,
      page: {
        ...makePage(),
        width: p.width,
        height: p.height,
        blocks: [block],
      },
      conditionOnTypography: true,
      fallbackConstraint: null,
      sourceRect: p.bounds,
      regionMask: { bounds: p.bounds, data: p.owned },
      segmentation: {
        imageWidth: p.width,
        imageHeight: p.height,
        detections: [
          { ...shared, label: "text", labelId: 0 },
          { ...shared, label: "onomatopoeia", labelId: 1 },
        ],
      },
    });
    expect(Boolean(plan.measuredBrush)).toBe(Boolean(rim));
    const mask = expandWindowMaskToPage(plan.modelMask, p.width, p.height);
    if (rim) {
      expect(mask[p.width * 60 + 258]).toBe(0);
      expect(mask[p.width * 50 + 89]).toBe(1);
    }
  },
);

it("follows detached ink on the axis of a dry brush and preserves unrelated marks beside it", () => {
  const width = 280,
    height = 190;
  const tone = new Uint8Array(width * height).fill(252);
  const owned = new Uint8Array(tone.length);
  const mark = (
    x: number,
    y: number,
    w: number,
    h: number,
    selected = false,
  ) => {
    for (let row = y; row < y + h; row++) {
      tone.fill(16, row * width + x, row * width + x + w);
      if (selected) owned.fill(1, row * width + x, row * width + x + w);
    }
  };
  for (const y of [35, 68, 101, 134]) mark(48, y, 100, 9, true);
  mark(155, 37, 16, 4);
  mark(176, 38, 11, 3);
  mark(192, 38, 8, 2);
  mark(91, 53, 17, 2);
  mark(96, 58, 17, 2);
  mark(151, 86, 4, 7);
  mark(12, 69, 5, 8);
  const recovered = measureNativeBrushInk({ width, height, owned, tone });
  expect(recovered?.matte[39 * width + 181]).toBe(1);
  expect(recovered?.matte[72 * width + 13]).toBe(0);
});

it("protects the exposed pen between broad printed strokes when all detected ink is accounted for", () => {
  const width = 240,
    height = 170;
  const tone = new Uint8Array(width * height).fill(253);
  const owned = new Uint8Array(tone.length);
  for (const y of [20, 55, 90, 125]) {
    for (let row = y; row < y + 17; row++) {
      tone.fill(10, row * width + 52, row * width + 153);
      owned.fill(1, row * width + 52, row * width + 153);
    }
  }
  tone.fill(70, 44 * width + 79, 44 * width + 112);
  const selected = measureNativeBrushInk({ width, height, tone, owned });
  for (const mask of [selected?.matte, selected?.composite]) {
    expect(mask?.[44 * width + 97]).toBe(0);
    expect(mask?.[45 * width + 97]).toBe(0);
    expect(mask?.[33 * width + 97]).toBe(1);
  }
});

it("keeps all registered print up to a ruled panel and excludes the adjacent lettering", () => {
  for (const mirrored of [false, true]) {
    const width = 196,
      height = 209;
    const col = (x: number) => (mirrored ? width - 1 - x : x);
    const owned = new Uint8Array(width * height);
    for (const [left, top, right, bottom] of [
      [55, 30, 139, 44],
      [32, 84, 109, 95],
      [65, 135, 91, 159],
    ])
      for (let y = top; y < bottom; y++)
        for (let x = left; x < right; x++) owned[y * width + col(x)] = 1;
    const distance = distanceToMask(owned, width, height);
    const tone = Uint8Array.from(distance, (d, i) => {
      const x = col(i % width),
        y = Math.floor(i / width);
      if ((x >= 29 && x < 32) || (x >= 7 && x < 18 && y >= 60 && y < 74))
        return 12;
      return d === 0 ? 13 : d < 3.7 ? 252 : 160 + ((x + y) % 60);
    });
    const field = { width, height, tone, owned };
    const partial = owned.map((v, i) => (Math.floor(i / width) > 120 ? 0 : v));
    expect(ruledBrushKeyline({ ...field, owned: partial })).toBeUndefined();
    const hollow = owned.slice();
    hollow[36 * width + col(77)] = 0;
    expect(
      ruledBrushKeyline({ ...field, owned: hollow })?.matte[
        84 * width + col(33)
      ],
    ).toBe(1);
    const loose = owned.slice();
    for (let y = 135; y < 188; y++)
      for (let x = 65; x < 128; x++) loose[y * width + col(x)] = 1;
    expect(ruledBrushKeyline({ ...field, owned: loose })).toBeUndefined();
    const uniform = Uint8Array.from(tone, (v) => (v >= 140 ? 253 : v));
    expect(ruledBrushKeyline({ ...field, tone: uniform })).toBeUndefined();
    const plain = Uint8Array.from(tone, (v) => (v >= 140 ? 201 : v));
    expect(ruledBrushKeyline({ ...field, tone: plain })).toBeUndefined();
    for (const select of [ruledBrushKeyline, measureNativeBrushInk]) {
      const found = select(field);
      for (const mask of [found?.matte, found?.composite]) {
        expect(mask?.[89 * width + col(32)]).toBe(1);
        expect(mask?.[82 * width + col(70)]).toBe(1);
        expect(mask?.[89 * width + col(31)]).toBe(0);
        expect(mask?.[65 * width + col(12)]).toBe(0);
        expect(mask?.[61 * width + col(73)]).toBe(0);
      }
    }
    for (let y = 0; y < height; y++)
      for (let x = 29; x < 32; x++) tone[y * width + col(x)] = 200;
    expect(ruledBrushKeyline(field)).toBeUndefined();
  }
});

it("joins a clipped companion with the same thin printed rim and retains the drawing between faces", () => {
  const width = 334,
    height = 268;
  const core = new Uint8Array(width * height),
    owned = new Uint8Array(core.length);
  const faces = [
    [0, 20, 49, 165],
    [86, 51, 33, 72],
    [141, 57, 36, 75],
    [173, 159, 42, 34],
    [221, 173, 28, 20],
    [282, 196, 30, 24],
  ];
  faces.forEach(([x, y, w, h], index) => {
    for (let row = y; row < y + h; row++) {
      core.fill(1, row * width + x, row * width + x + w);
      if (index < 4) owned.fill(1, row * width + x, row * width + x + w);
      if (index >= 4) owned.fill(1, row * width + x, row * width + x + 2);
    }
  });
  const distance = distanceToMask(core, width, height);
  const tone = Uint8Array.from(distance, (d, i) =>
    d === 0 ? 10 : d <= 2.3 ? 253 : 140 + (i % 30),
  );
  const recovered = measureNativeBrushInk({ width, height, owned, tone });
  expect(recovered?.measuredBrush).toBe("solid-impact");
  expect(recovered?.matte[182 * width + 245]).toBe(1);
  expect(recovered?.composite[80 * width + 126]).toBe(0);
  expect(recovered?.composite[202 * width + 292]).toBe(0);
  for (let i = 0; i < tone.length; i++)
    if (distance[i] > 0 && distance[i] < 3) tone[i] = 170;
  expect(
    measureNativeBrushInk({ width, height, owned, tone })?.measuredBrush,
  ).not.toBe("solid-impact");
});

it("completes only a supported black tip on screened pale paper", () => {
  const width = 157,
    height = 185,
    bounds = { x: 0, y: 0, w: width, h: height };
  const owned = new Uint8Array(width * height);
  const bitmap = Buffer.alloc(owned.length * 4, 255);
  for (let i = 0; i < owned.length; i++) {
    const x = i % width,
      y = Math.floor(i / width);
    const stroke = [23, 55, 87, 119].some(
      (row) => y >= row && y < row + 9 && x >= 35 && x < 93,
    );
    const tone = stroke ? 12 : 197 + (Math.floor((x + 2 * y) / 7) % 2) * 57;
    bitmap.fill(tone, i * 4, i * 4 + 3);
    owned[i] = Number(stroke && (y >= 55 || x >= 42));
  }
  const select = () =>
    completeTaperedSound(bitmap, { width, height }, { bounds, data: owned });
  const throughPlan = () => {
    const block = {
      ...makeBlock(),
      textRole: "sound" as const,
      sourceText: "",
    };
    const known = { bounds, data: owned, label: "onomatopoeia" as const };
    return resolvePatternFluxCompositePlan({
      bitmap,
      width,
      height,
      block,
      page: { ...makePage(), width, height, blocks: [block] },
      sourceRect: bounds,
      regionMask: known,
      fallbackConstraint: null,
      conditionOnTypography: true,
      segmentation: {
        imageWidth: width,
        imageHeight: height,
        detections: [],
        contextualText: new Map([[block.id, known]]),
      },
    }).modelMask;
  };
  const result = select();
  expect(result?.data[25 * width + 35]).toBe(1);
  expect(result?.data[45 * width + 60]).toBe(0);
  expect(
    expandWindowMaskToPage(throughPlan(), width, height)[25 * width + 35],
  ).toBe(1);
  for (let i = 0; i < owned.length; i++)
    if (!owned[i] && bitmap[i * 4] > 138) bitmap.fill(255, i * 4, i * 4 + 3);
  expect(select()).toBeUndefined();
  expect(
    expandWindowMaskToPage(throughPlan(), width, height)[45 * width + 60],
  ).toBe(0);
  owned.fill(0);
  expect(select()).toBeUndefined();
});
