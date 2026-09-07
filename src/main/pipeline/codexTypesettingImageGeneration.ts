import { nativeImage } from "electron";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  generateImage,
  erasureImageInputs,
} from "./codexTypesettingImageRequest";
import { PNG } from "pngjs";
import type {
  CodexPageReading,
  CodexPageRegion,
} from "../../shared/codexTypesettingTypes";
import type { MangaPage } from "../../shared/libraryTypes";
import {
  createCodexBackgroundBlend,
  codexBackgroundSupportRect,
} from "../../shared/codexTypesettingBlend";
import type { CodexAppServerClient } from "../codexAppServerClient";
import type {
  TypesettingComposition,
  TypesettingIssue,
  TypesettingRepair,
} from "../application/codexTypesettingContracts";
import {
  compositeRegisteredPatch,
  registerTypesettingPatch,
} from "./codexTypesettingRegistration";

type CropBounds = { left: number; top: number; width: number; height: number };
export type TypesettingBackgroundCache = Map<
  string,
  { output: Buffer; crop: CropBounds }
>;

export async function cleanIllustratedRegions(
  page: MangaPage,
  reading: CodexPageReading,
  client: Pick<CodexAppServerClient, "runEphemeralTurn">,
  directory: string,
  signal: AbortSignal,
  repair?: TypesettingRepair,
  cache: TypesettingBackgroundCache = new Map(),
): Promise<TypesettingComposition> {
  const illustrated = reading.regions.filter(
    (region) => region.action !== "keep" && region.background === "artwork",
  );
  if (!illustrated.length) return { page, issues: [] };
  const issues: TypesettingIssue[] = [];
  const backgroundCandidates: NonNullable<
    TypesettingComposition["backgroundCandidates"]
  > = [];
  if (!page.inpaintedImagePath)
    throw new Error("합성할 배경 이미지가 없습니다.");
  const base = PNG.sync.read(await readFile(page.inpaintedImagePath));
  for (const region of illustrated) {
    signal.throwIfAborted();
    try {
      const prior = reusableBackground(cache, page, region, repair);
      const crop = await generationCrop(page, region, reading, prior?.crop);
      const output =
        prior?.output ??
        (await generateImage(
          client,
          directory,
          signal,
          `Reconstruct ALL magenta holes in image 1 as continuous background artwork. Image 2 is the WHITE edit-permission mask; image 3 is the original crop for surrounding-artwork reference only. Every masked stroke, including disconnected marks, outlines, long brush strokes and clipped letter fragments, must disappear. Do not restore the original lettering from image 3 or interpret its masked strokes as speed lines. The recognized source label ${JSON.stringify(region.sourceText)} is context only, never a limit on the mask. Match linework, screentone and texture. Add no replacement letters or magenta. Return one complete edited crop at the same aspect ratio and alignment; preserve all unmasked pixels. ${repair ? `Correct these observed failures: ${JSON.stringify(repair.issues.filter((issue) => issue.regionId === region.id))}` : ""}`,
          erasureImageInputs(
            crop.image,
            PNG.sync.read(Buffer.from(crop.mask.split(",")[1], "base64")),
          ),
          { width: crop.width, height: crop.height },
        ));
      cache.set(region.id, {
        output,
        crop: {
          left: crop.left,
          top: crop.top,
          width: crop.width,
          height: crop.height,
        },
      });
      backgroundCandidates.push({
        regionId: region.id,
        dataUrl: `data:image/png;base64,${output.toString("base64")}`,
        crop: { x: crop.left, y: crop.top, w: crop.width, h: crop.height },
        sha256: createHash("sha256").update(output).digest("hex"),
        blendMask: crop.blendMask,
        reused: Boolean(prior),
      });
      await applyGeneratedBackground(base, output, crop, directory, region.id);
    } catch (error) {
      signal.throwIfAborted();
      issues.push({
        regionId: region.id,
        kind: "background",
        reason: `배경 생성 실패: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  await writeFile(page.inpaintedImagePath, PNG.sync.write(base));
  return { page, issues, backgroundCandidates };
}

async function generationCrop(
  page: MangaPage,
  region: CodexPageRegion,
  reading: CodexPageReading,
  reusedCrop?: CropBounds,
) {
  const blend = createCodexBackgroundBlend(
    region,
    page,
    reading.regions.filter((item) => item.action === "keep"),
  );
  const { bounds } = blend;
  const padding = Math.round(Math.max(32, Math.max(bounds.w, bounds.h) * 0.35));
  const contextLeft = Math.max(0, bounds.x - padding);
  const contextTop = Math.max(0, bounds.y - padding);
  const { left, top, width, height } = reusedCrop ?? {
    left: contextLeft,
    top: contextTop,
    width: Math.min(page.width, bounds.x + bounds.w + padding) - contextLeft,
    height: Math.min(page.height, bounds.y + bounds.h + padding) - contextTop,
  };
  const image = nativeImage
    .createFromBuffer(await readFile(page.imagePath))
    .crop({ x: left, y: top, width, height })
    .toDataURL();
  const mask = new PNG({ width, height });
  const permission = new Uint8Array(width * height);
  const blendOpacity = new Float64Array(width * height);
  const blendMask = new PNG({ width, height });
  for (let index = 3; index < mask.data.length; index += 4)
    mask.data[index] = 255;
  for (let y = bounds.y; y < bounds.y + bounds.h; y++) {
    for (let x = bounds.x; x < bounds.x + bounds.w; x++) {
      const alpha = blend.data[(y - bounds.y) * bounds.w + x - bounds.x];
      if (!alpha) continue;
      const offset = ((y - top) * width + x - left) * 4;
      mask.data.fill(255, offset, offset + 4);
      permission[offset / 4] = 1;
      blendOpacity[offset / 4] = alpha;
      blendMask.data.fill(Math.round(alpha * 255), offset, offset + 3);
    }
  }
  for (let index = 3; index < blendMask.data.length; index += 4)
    blendMask.data[index] = 255;
  return {
    left,
    top,
    width,
    height,
    bounds,
    permission,
    blendOpacity,
    blendMask: `data:image/png;base64,${PNG.sync.write(blendMask).toString("base64")}`,
    image,
    mask: `data:image/png;base64,${PNG.sync.write(mask).toString("base64")}`,
  };
}

function reusableBackground(
  cache: TypesettingBackgroundCache,
  page: MangaPage,
  region: CodexPageRegion,
  repair?: TypesettingRepair,
) {
  if (!repair?.reuseBackgroundIds?.includes(region.id)) return undefined;
  const previous = cache.get(region.id);
  if (!previous) return undefined;
  const box = codexBackgroundSupportRect(region, page),
    crop = previous.crop;
  return box.x >= crop.left &&
    box.y >= crop.top &&
    box.x + box.w <= crop.left + crop.width &&
    box.y + box.h <= crop.top + crop.height
    ? previous
    : undefined;
}

async function applyGeneratedBackground(
  base: PNG,
  output: Buffer,
  crop: Awaited<ReturnType<typeof generationCrop>>,
  directory: string,
  regionId: string,
): Promise<void> {
  const generated = nativeImage.createFromBuffer(output);
  if (generated.isEmpty())
    throw new Error("ImageGen 배경 결과가 비어 있습니다.");
  const patch = PNG.sync.read(
    generated
      .resize({
        width: crop.width,
        height: crop.height,
        quality: "best",
      })
      .toPNG(),
  );
  const source = PNG.sync.read(Buffer.from(crop.image.split(",")[1], "base64"));
  const { bounds, left, top } = crop;
  const erase = { ...bounds, x: bounds.x - left, y: bounds.y - top };
  const registration = registerTypesettingPatch(
    source,
    patch,
    erase,
    crop.permission,
  );
  const hash = createHash("sha256").update(output).digest("hex");
  const usable =
    registration.samples >= 32 && registration.supported && registration.opaque;
  const planHash = createHash("sha256")
    .update(crop.blendMask)
    .digest("hex")
    .slice(0, 16);
  const name = `clean-source-${regionId.replace(/[^\w-]/g, "_")}-${hash}-splice-${planHash}`;
  await writeFile(resolve(directory, `${name}.png`), output);
  await writeFile(
    resolve(directory, `${name}.json`),
    JSON.stringify(
      {
        regionId,
        generatedSha256: hash,
        crop: { left, top, width: crop.width, height: crop.height },
        erase,
        permissionPixels: crop.permission.reduce(
          (sum, value) => sum + value,
          0,
        ),
        registration,
        status: usable
          ? "staged-for-visual-background-review"
          : "rejected-technical-coverage",
        blend: { mode: "dilated-source-contour-outer-feather", planHash },
      },
      null,
      2,
    ),
  );
  // Numeric difference remains diagnostic. Only the actual background inspection
  // can accept this staged splice; coverage/opacity failures cannot be overridden.
  if (!usable) throw new Error(registration.reason);
  compositeRegisteredPatch(
    base,
    patch,
    erase,
    { x: left, y: top },
    registration.transform,
    crop.permission,
    crop.blendOpacity,
  );
}
