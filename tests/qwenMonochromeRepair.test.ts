import { makeControlCrop, controlLaunch } from "./qwenControlCrop.fixture";
import {
  measuredDialoguePeerInk,
  protectUnselectedFluxPlan,
} from "../src/main/inpainting/patternBlockEligibility";
import { makePage } from "./koharuTypographyMask.fixture";
import { measureJointBalloonPrint } from "../src/main/inpainting/sharedBubbleTextBridge";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeImage } from "electron";
import { expect, it, vi } from "vitest";
import { restoreIsolatedSoundPaper } from "../src/main/inpainting/qwenFlatText";
import { restoreQwenPaper } from "../src/main/inpainting/qwenPaper";
import { isIsolatedBalloonType } from "../src/main/inpainting/qwenPaperBank";
import { distanceToMask } from "../src/main/inpainting/pageMaskComposite";
import {
  prepareQwenArtworkCrop,
  couldContainDisplayHatching,
  QwenNativeReference,
} from "../src/main/inpainting/qwenNativeReference";
import { restoreUniformQwenScreen } from "../src/main/inpainting/qwenUniformScreen";
import {
  couldContainGradedPrint,
  restoreScreenedQwenGuide,
} from "../src/main/inpainting/qwenScreenedGuide";
import { dilateBinaryMaskDisk } from "../src/main/inpainting/patternMaskMorphology";

import { maskBoundsInRect } from "../src/main/inpainting/imageRaster";
const width = 152,
  height = 192;
function bounds(stencil: Uint8Array) {
  return maskBoundsInRect(stencil, width, { x: 0, y: 0, w: width, h: height });
}
function uniform(source: Buffer, stencil: Uint8Array, w: number, h: number) {
  return restoreUniformQwenScreen(source, stencil, w, h, bounds(stencil));
}
function print() {
  const original = Buffer.alloc(width * height * 4, 255),
    stencil = new Uint8Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const tone = [58, 168, 244, 252][(x + 2 * y) % 4];
      original.fill(tone, 4 * i, 4 * i + 3);
      if (y >= 48 && y < 140 && x >= 52 && x < 91 && (x - 52) % 16 < 6)
        stencil[i] = 1;
    }
  const guide = Buffer.from(original);
  stencil.forEach((v, i) => {
    if (v) original.fill(i % 3 ? 255 : 0, 4 * i, 4 * i + 3);
  });
  return {
    width,
    height,
    original,
    stencil,
    guide,
    inkBounds: bounds(stencil),
  };
}

it("clears a short sound on white stock and rejects ambiguous artwork or coloured ink", () => {
  const clean = Buffer.alloc(width * height * 4, 255);
  const source = Buffer.from(clean);
  const ink = new Uint8Array(width * height);
  for (const top of [40, 69, 96])
    for (let y = top; y < top + 13; y++)
      for (let x = 58; x < 78; x++)
        if (x < 61 || y >= top + 10) {
          const i = y * width + x;
          source.fill(24, i * 4, i * 4 + 3);
          ink[i] = 1;
        }
  const mask = dilateBinaryMaskDisk(ink, width, height, 3);
  const repair = (pixels: Buffer, reading = "sound:フフン...") =>
    restoreIsolatedSoundPaper(pixels, mask, width, height, reading);
  expect(repair(source)?.equals(clean)).toBe(true);
  expect(
    restoreQwenPaper(
      source,
      mask,
      width,
      height,
      false,
      "sound:フフン...",
    )?.equals(clean),
  ).toBe(true);
  expect(repair(source, "lettering")).toBeUndefined();
  expect(repair(source, "sound:...")).toBeUndefined();
  const ruled = Buffer.from(source);
  for (let x = 0; x < width; x++)
    ruled.fill(60, 4 * (80 * width + x), 4 * (80 * width + x) + 3);
  expect(repair(ruled)).toBeUndefined();
  const interior = Buffer.from(source);
  interior.fill(40, 4 * (90 * width + 70), 4 * (90 * width + 70) + 3);
  expect(repair(interior)).toBeUndefined();
  const colour = Buffer.from(source);
  colour[4 * (75 * width + 60)] = 125;
  expect(repair(colour)).toBeUndefined();
  mask[0] = 1;
  expect(repair(source)).toBeUndefined();
});

it("traces a clipped tip into its dialogue glyph but cannot reclaim a detached mark", () => {
  const w = 84,
    h = 68,
    size = { x: 0, y: 0, w, h };
  const pixels = Buffer.alloc(4 * w * h, 255),
    ink = new Uint8Array(w * h);
  function draw(x: number, y: number, sw: number, sh: number) {
    for (let ty = y; ty < y + sh; ty++)
      for (let tx = x; tx < x + sw; tx++) {
        const i = ty * w + tx;
        ink[i] = 1;
        pixels.fill(18, 4 * i, 4 * i + 3);
      }
  }
  for (const y of [8, 29, 50]) for (const x of [8, 30, 52]) draw(x, y, 8, 8);
  const owner = ink.slice();
  owner.fill(0, w * 57 + 52, w * 57 + 58);
  const verified = () =>
    isIsolatedBalloonType(
      pixels,
      w,
      size,
      ink,
      owner,
      distanceToMask(ink, w, h),
    );
  expect(verified()).toBe(true);
  draw(66, 43, 2, 3);
  expect(verified()).toBe(false);
});

it("protects the neighboring text while allowing the shallow tip of a measured lower glyph", () => {
  const size = { width: 120, height: 110 },
    original = Buffer.alloc(120 * 110 * 4, 255);
  const bounds = { x: 49, y: 53, w: 32, h: 33 },
    peer = { x: 27, y: 20, w: 55, h: 35 };
  const data = new Uint8Array(bounds.w * bounds.h);
  for (let y = 53; y < 74; y++)
    for (let x = 54; x < 59; x++) {
      const k = 4 * (120 * y + x);
      original.fill(44, k, k + 3);
      data[(y - bounds.y) * bounds.w + x - bounds.x] = 1;
    }
  for (let y = 37; y < 47; y++)
    for (let x = 43; x < 48; x++) {
      const k = 4 * (120 * y + x);
      original.fill(33, k, k + 3);
    }
  const test = (rect = peer) =>
    measuredDialoguePeerInk(original, size, { bounds, data }, rect);
  const reserved = test();
  const at = (x: number, y: number) => (y - peer.y) * peer.w + x - peer.x;
  expect(reserved?.data[at(56, 54)]).toBe(0);
  expect(reserved?.data[at(44, 40)]).toBe(1);
  expect(test({ ...peer, h: 50 })).toBeUndefined();
  const page = { ...makePage(), ...size };
  const base = page.blocks[0],
    box = {
      x: (29 * 1000) / size.width,
      y: (22 * 1000) / size.height,
      w: (51 * 1000) / size.width,
      h: (31 * 1000) / size.height,
    };
  for (const role of ["ordinary", "sound", "manual"] as const) {
    const neighbor = {
      ...base,
      id: "peer",
      bbox: box,
      textRole: role === "sound" ? ("sound" as const) : ("ordinary" as const),
      bubbleLayout:
        role === "manual"
          ? {
              version: 1 as const,
              origin: "manual" as const,
              insetRatio: 0,
              direction: "vertical" as const,
              regions: [],
              confidence: 1,
            }
          : undefined,
    };
    const plan = {
      modelMask: { bounds, data },
      compositeMask: { bounds, data },
      constraint: null,
      featherPx: 2,
    };
    protectUnselectedFluxPlan(plan, {
      page: { ...page, blocks: [base, neighbor] },
      blockId: base.id,
      dialogueStrokes: { bitmap: original, model: plan.modelMask },
    });
    expect(
      plan.compositeMask.data[(54 - bounds.y) * bounds.w + 56 - bounds.x],
    ).toBe(role === "ordinary" ? 1 : 0);
  }
  original[0] = 100;
  original[(24 * size.width + 51) * 4 + 1] = 19;
  expect(test()).toBeUndefined();
  original[(24 * size.width + 51) * 4 + 1] = 255;
  const black = Buffer.alloc(original.length, 0);
  for (let i = 3; i < black.length; i += 4) black[i] = 255;
  expect(
    measuredDialoguePeerInk(black, size, { bounds, data }, peer),
  ).toBeUndefined();
  data.fill(0);
  expect(test()).toBeUndefined();
});

it("recovers the original print exactly from its neighbours when dark type covers a screen", () => {
  const { original, stencil, guide } = print();
  const saved = Buffer.from(original);
  expect(uniform(original, stencil, width, height)?.equals(guide)).toBe(true);
  expect(original.equals(saved)).toBe(true);
});

it("declines coloured ink, transparency, broken print at the collar, missing borders and untextured paper", () => {
  const { original, stencil } = print();
  for (const channel of [1, 3]) {
    const data = Buffer.from(original);
    data[4 * (48 * width + 52) + channel] = 33;
    expect(uniform(data, stencil, width, height)).toBeUndefined();
  }
  const crossed = Buffer.from(original);
  for (let y = 18; y < 167; y++)
    for (let x = 65; x < 69; x++)
      crossed.fill(0, (y * width + x) * 4, (y * width + x) * 4 + 3);
  expect(uniform(crossed, stencil, width, height)).toBeUndefined();
  const enclosed = Buffer.from(original);
  for (let y = 80; y < 91; y++)
    for (let x = 61; x < 66; x++)
      enclosed.fill(0, 4 * (y * width + x), 4 * (y * width + x) + 3);
  expect(uniform(enclosed, stencil, width, height)).toBeUndefined();
  expect(
    uniform(Buffer.alloc(original.length, 255), stencil, width, height),
  ).toBeUndefined();
  stencil[1] = 1;
  expect(uniform(original, stencil, width, height)).toBeUndefined();
});

it("requires a blind and textured match before retaining a narrow effect's guide", async () => {
  const input = print(),
    condition = dilateBinaryMaskDisk(input.stencil, width, height, 4);
  const guide = await restoreScreenedQwenGuide(input, input.guide, condition);
  expect(guide?.equals(input.guide)).toBe(true);
  expect(
    await restoreScreenedQwenGuide(
      input,
      Buffer.alloc(input.guide.length, 170),
      condition,
    ),
  ).toBeUndefined();
  expect(
    await restoreScreenedQwenGuide(input, input.guide, input.stencil),
  ).toBeUndefined();
  input.original[3] = 0;
  expect(
    await restoreScreenedQwenGuide(input, input.guide, condition),
  ).toBeUndefined();
});

it("requests a graded print solver only when exposed tiles show a screened bank", () => {
  const input = print(),
    inkBounds = { x: 8, y: 6, w: 103, h: 178 };
  expect(couldContainGradedPrint({ ...input, inkBounds })).toBe(true);
  expect(couldContainGradedPrint(input)).toBe(false);
  expect(
    couldContainGradedPrint({
      ...input,
      inkBounds,
      original: Buffer.alloc(input.original.length, 255),
    }),
  ).toBe(false);
});

it("writes confirmed print through the native and control pipelines and samples rejected lettering normally", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qwen-screen-routing-"));
  const size = { width, height };
  const input = print();
  const source = nativeImage.createFromBitmap(input.original, size);
  const prior = nativeImage.createFromBitmap(input.guide, size);
  const condition = dilateBinaryMaskDisk(input.stencil, width, height, 4);
  const inputs = { ...input, source };
  const request = {
    input: join(dir, "source.png"),
    mask: join(dir, "mask.png"),
    output: join(dir, "restored.png"),
    steps: 40,
    strength: 1,
    maxPixels: width * height,
    maskPadding: 0,
  };
  const signal = new AbortController().signal;
  const native = new QwenNativeReference(controlLaunch().models);
  const control = makeControlCrop();
  const reference = { prior, size, condition, material: undefined };
  try {
    vi.spyOn(native, "prepareCrop").mockResolvedValue(reference);
    const ordinary = await prepareQwenArtworkCrop(
      { native },
      request,
      inputs,
      false,
      signal,
    );
    expect(ordinary.nativeGuide).toBe(reference);
    expect(ordinary.restored).toBe(true);
    expect(await readFile(request.output)).toEqual(prior.toPNG());

    const graded = { ...inputs, inkBounds: { x: 8, y: 6, w: 103, h: 178 } };
    vi.spyOn(control.substrate, "restoreStencil").mockResolvedValue(prior);
    const register = vi
      .spyOn(control.registration, "registerImage")
      .mockResolvedValueOnce(prior)
      .mockResolvedValueOnce(undefined);
    const fallback = {
      ...reference,
      prefix: request.input,
      sourceReference: true,
      registered: false,
    };
    const prepare = vi.spyOn(control, "prepare").mockResolvedValue(fallback);
    await rm(request.output);
    expect(
      (
        await prepareQwenArtworkCrop(
          { control },
          request,
          graded,
          "lettering",
          signal,
        )
      ).restored,
    ).toBe(true);
    expect(await readFile(request.output)).toEqual(prior.toPNG());
    expect(register).toHaveBeenCalledWith(
      "qwen_screen_transfer.py",
      request.input,
      request.mask,
      prior,
      signal,
    );
    expect(prepare).not.toHaveBeenCalled();
    await rm(request.output);
    const declined = await prepareQwenArtworkCrop(
      { control },
      request,
      graded,
      "lettering",
      signal,
    );
    expect(declined.crop).toBe(fallback);
    expect(declined.restored).toBe(false);
    await expect(readFile(request.output)).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await native.dispose();
    await control.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

it("uses the original display inks and accepts only a registered native hatch repair", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qwen-display-"));
  const width = 710,
    height = 350,
    original = Buffer.alloc(width * height * 4, 255),
    stencil = new Uint8Array(width * height);
  for (let i = 0; i < stencil.length; i++) {
    if (i % 5 === 0) continue;
    stencil[i] = 1;
    original.fill([0, 0, 0, 68, 94, 0][i % 6], 4 * i, 4 * i + 3);
  }
  const size = { width, height },
    source = nativeImage.createFromBitmap(original, size);
  const inputs = {
    ...size,
    original,
    stencil,
    source,
    inkBounds: { x: 0, y: 0, w: width, h: height },
  };
  const request = {
    input: join(dir, "input.png"),
    mask: join(dir, "mask.png"),
    output: join(dir, "output.png"),
    steps: 40,
    strength: 1,
    maxPixels: width * height,
    maskPadding: 0,
  };
  const control = makeControlCrop(),
    signal = new AbortController().signal;
  try {
    expect(couldContainDisplayHatching(inputs)).toBe(true);
    const registered = vi
      .spyOn(control.registration, "registerImage")
      .mockResolvedValueOnce(source)
      .mockResolvedValueOnce(undefined);
    const sample = vi.spyOn(control, "prepare").mockResolvedValue({
      prior: source,
      size,
      condition: stencil,
      material: undefined,
      prefix: request.input,
      sourceReference: true,
      registered: false,
    });
    expect(
      (
        await prepareQwenArtworkCrop(
          { control },
          request,
          inputs,
          false,
          signal,
        )
      ).restored,
    ).toBe(true);
    expect(registered).toHaveBeenCalledWith(
      "qwen_screen_transfer.py",
      request.input,
      request.mask,
      source,
      signal,
      "display-hatching",
    );
    expect(sample).not.toHaveBeenCalled();
    expect(
      (
        await prepareQwenArtworkCrop(
          { control },
          request,
          inputs,
          false,
          signal,
        )
      ).restored,
    ).toBe(false);
    expect(sample).toHaveBeenCalledOnce();
    expect(
      couldContainDisplayHatching({
        ...inputs,
        stencil: new Uint8Array(stencil.length),
      }),
    ).toBe(false);
    expect(
      couldContainDisplayHatching({
        ...inputs,
        original: Buffer.alloc(original.length, 255),
      }),
    ).toBe(false);
    original[11 * 4 + 1] = 29;
    expect(couldContainDisplayHatching(inputs)).toBe(false);
  } finally {
    await control.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

it("requires every additional interior mark on joint balloon paper to agree with the detector", () => {
  const frame = { x: 0, y: 0, w: 128, h: 128 },
    box = { x: 20, y: 20, w: 90, h: 90 };
  const raster = Buffer.alloc(128 * 128 * 4, 255),
    detected = new Uint8Array(128 * 128);
  const ink = (x: number, y: number, w: number, h: number, owned: boolean) => {
    for (let dy = 0; dy < h; dy++)
      for (let dx = 0; dx < w; dx++) {
        const i = (y + dy) * 128 + x + dx;
        raster.fill(22, i * 4, i * 4 + 3);
        if (owned) detected[i] = 1;
      }
  };
  const read = () =>
    measureJointBalloonPrint(raster, 128, [box], box, frame, detected);
  for (const y of [30, 60, 85])
    for (const x of [30, 58, 81]) ink(x, y, 4, 5, true);
  ink(0, 15, 15, 3, false);
  ink(5, 60, 3, 7, false);
  expect(read()).toBeDefined();
  ink(41, 30, 1, 1, false);
  expect(read()).toBeUndefined();
  detected[30 * 128 + 41] = 1;
  expect(read()).toBeDefined();
  ink(49, 100, 35, 3, false);
  expect(read()).toBeUndefined();
});
