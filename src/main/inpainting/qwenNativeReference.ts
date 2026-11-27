import { measuredGuide } from "./qwenGuideContinuity";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { nativeImage, type NativeImage, type Size } from "electron";
import {
  couldContainGradedPrint,
  restoreScreenedQwenGuide,
} from "./qwenScreenedGuide";
import { writeNativeCrop, type readNativeCropInputs } from "./fluxCropIO";
import type { QwenImageModelPaths } from "./qwenImageAssets";
import {
  controlConditionMask,
  writeQwenReferencePair,
} from "./qwenControlReferences";
import { QwenSubstrate } from "./qwenSubstrate";

import type { QwenControlCrop } from "./qwenControlCrop";
import type { FluxWorkerRequest } from "./fluxWorkerTypes";
import { nativePrintedStock } from "./qwenPrintedStock";
import { restoreStoneTexture } from "./qwenStoneTexture";
import { referenceInstructions } from "./qwenPrintedReference";
import {
  qwenCropCompositeWeights,
  qwenTextArtworkWeights,
} from "./qwenTextArtwork";
import {
  measuredPrintNegative,
  qwenSamplingSizes,
  type QwenSamplingCrop,
} from "./qwenControlSampling";
import { printMaskGrid } from "./qwenPrintedPigment";

export type QwenReferenceModels = Omit<QwenImageModelPaths, "vision"> & {
  vision?: string;
  prior: string;
};
type Adapter = { directory: string; name: string; strength: number };

export class QwenNativeReference extends QwenSubstrate {
  private encodersOnCpu = false;

  offloadEncodersAfterPressure() {
    if (!this.device || this.encodersOnCpu) return false;
    this.encodersOnCpu = true;
    return true;
  }
  artworkView(inputs: Size & { original: Buffer; stencil: Uint8Array }) {
    const { original, stencil, width, height } = inputs;
    // A manual selection can cover the small rings attached to a transparent
    // balloon. Its original typeset ink and keyline establish which pixels to edit.
    if (nativePrintedStock(original, stencil, inputs) === "drawnCloth")
      return {
        referenceEdit: "drawnCloth" as const,
        weights: qwenTextArtworkWeights(original, stencil, width, height),
      };
  }

  finish(
    inputs: Size & { original: Buffer; stencil: Uint8Array },
    decoded: Buffer,
  ) {
    const { original, stencil } = inputs;
    return nativePrintedStock(original, stencil, inputs) === "roughStone"
      ? restoreStoneTexture(original, decoded, stencil, inputs)
      : decoded;
  }
  constructor(
    private readonly models: QwenReferenceModels,
    private readonly adapter?: Adapter,
    private readonly device?: string,
  ) {
    super(models.prior);
  }
  async prepareCrop(
    source: NativeImage,
    stencil: Uint8Array,
    request: FluxWorkerRequest,
    signal: AbortSignal,
  ) {
    const size = source.getSize();
    const material = nativePrintedStock(source.toBitmap(), stencil, size);
    // The surviving corners identify the original polygon. A prefilled
    // reference removes those corners together with overlapping hollow type.
    let condition = stencil;
    let prior = source;
    if (material === "drawnCloth") {
      condition = Uint8Array.from(
        printMaskGrid(size.width, size.height).distance(stencil),
        (d) => Number(d <= 3.5),
      );
    } else if (material !== "facetedFrame") {
      condition = controlConditionMask(stencil, size, false);
      prior = await this.restoreStencil(
        source,
        condition,
        request.input,
        signal,
      );
    }
    return { size, condition, prior, material };
  }
  async prepare(
    source: NativeImage,
    stencil: Uint8Array,
    request: FluxWorkerRequest,
    target: Size,
    signal: AbortSignal,
    prepared?: Awaited<ReturnType<QwenNativeReference["prepareCrop"]>>,
  ) {
    const { size, condition, prior, material } =
      prepared ?? (await this.prepareCrop(source, stencil, request, signal));
    const image = request.input + ".qwen.png";
    const mask = request.mask + ".qwen.png";
    await writeQwenReferencePair(
      { size, condition, prior },
      target,
      image,
      mask,
    );
    return async (output: string) => {
      const settings = nativeSettings(
        this.models,
        this.adapter,
        image,
        mask,
        target,
        this.encodersOnCpu ? "cpu" : (this.device ?? "cpu"),
        this.device,
        material,
      );
      const file = request.input + ".native.json";
      await writeFile(file, JSON.stringify({ ...settings, output }), {
        signal,
      });
      return [file];
    };
  }
}

function usesIllustratedGuide(crop?: QwenSamplingCrop) {
  return (
    crop && (crop.sourceReference || crop.referenceEdit || crop.pairedWindow)
  );
}

/** Check the original plate before starting a native helper. Two different
 * solid grey inks distinguish layered display type from a plain black heading. */
export function couldContainDisplayHatching(
  inputs: Pick<
    Awaited<ReturnType<typeof readNativeCropInputs>>,
    "inkBounds" | "width" | "height" | "original" | "stencil"
  >,
) {
  const { inkBounds, original, stencil } = inputs;
  if (
    !inkBounds ||
    inkBounds.w < 600 ||
    inkBounds.h < 330 ||
    stencil.length > 1_450_000
  )
    return false;
  return hasOpaqueDisplayInks(original, stencil);
}
function hasOpaqueDisplayInks(original: Buffer, stencil: Uint8Array) {
  const histogram = new Uint32Array(256);
  let count = 0,
    black = 0;
  for (let i = 0; i < stencil.length; i += 11) {
    if (!stencil[i]) continue;
    const p = 4 * i,
      gray = original[p];
    if (
      original[p + 3] !== 255 ||
      gray !== original[p + 1] ||
      gray !== original[p + 2]
    )
      return false;
    histogram[gray]++;
    count++;
    black += Number(gray < 12);
  }
  if (count < 10_000 || black < 0.35 * count) return false;
  const peaks = Array.from({ length: 146 }, (_, i) => i + 25).filter(
    (v) => histogram[v] > 0.045 * count,
  );
  return peaks.length >= 2 && peaks[peaks.length - 1] - peaks[0] >= 15;
}

async function writeMeasuredPrint(
  control: QwenControlCrop | undefined,
  request: FluxWorkerRequest,
  inputs: Awaited<ReturnType<typeof readNativeCropInputs>>,
  hint: Parameters<QwenControlCrop["prepare"]>[5],
  signal: AbortSignal,
) {
  if (
    control &&
    !request.speechBubble &&
    !request.illustratedTitle &&
    couldContainDisplayHatching(inputs)
  ) {
    const hatch = await control.registration.registerImage(
      "qwen_screen_transfer.py",
      request.input,
      request.mask,
      inputs.source,
      signal,
      "display-hatching",
    );
    if (hatch) {
      await writeNativeCrop(request.output, hatch, inputs.original, signal);
      return true;
    }
  }
  if (!control || hint !== "lettering" || !couldContainGradedPrint(inputs))
    return false;
  const size = inputs.source.getSize();
  const condition = controlConditionMask(inputs.stencil, size, false);
  const guide = await control.substrate.restoreStencil(
    inputs.source,
    condition,
    request.input,
    signal,
  );
  const screen = await control.registration.registerImage(
    "qwen_screen_transfer.py",
    request.input,
    request.mask,
    guide,
    signal,
  );
  if (!screen) return false;
  await writeNativeCrop(request.output, screen, inputs.original, signal);
  return true;
}

export async function prepareQwenArtworkCrop(
  pipeline: { control?: QwenControlCrop; native?: QwenNativeReference },
  request: FluxWorkerRequest,
  inputs: Awaited<ReturnType<typeof readNativeCropInputs>>,
  hint: Parameters<QwenControlCrop["prepare"]>[5],
  signal: AbortSignal,
) {
  const { source, stencil } = inputs;
  if (await writeMeasuredPrint(pipeline.control, request, inputs, hint, signal))
    return {
      crop: undefined,
      nativeGuide: undefined,
      restored: true,
      guide: undefined,
    };
  const crop = await pipeline.control?.prepare(
    source,
    stencil,
    request.input,
    signal,
    request.mask,
    hint,
  );
  const plain = !hint && !request.speechBubble;
  const nativeGuide = plain
    ? await pipeline.native?.prepareCrop(source, stencil, request, signal)
    : undefined;
  const guide = crop ?? nativeGuide;
  const ordinary =
    plain && guide && !guide.material && !usesIllustratedGuide(crop);
  const restored = ordinary
    ? await restoreScreenedQwenGuide(
        inputs,
        guide.prior.toBitmap(),
        guide.condition,
        signal,
      )
    : undefined;
  if (restored) {
    await writeNativeCrop(
      request.output,
      nativeImage.createFromBitmap(restored, source.getSize()),
      inputs.original,
      signal,
    );
    return { crop, nativeGuide, restored: true, guide: undefined };
  }
  const guidePixels = await measuredGuide(
    pipeline.control,
    crop,
    inputs,
    request,
    signal,
  );
  return { crop, nativeGuide, restored: false, guide: guidePixels };
}

export function originalViewSampling(
  crop: QwenSamplingCrop | undefined,
  inputs: Size & { original: Buffer; stencil: Uint8Array },
  speech: boolean | undefined,
  native?: QwenNativeReference,
) {
  const view = native?.artworkView(inputs);
  return {
    weights: qwenCropCompositeWeights(inputs, speech, crop) ?? view?.weights,
    sizes: qwenSamplingSizes(crop ?? view),
    maxUpscale: originalViewUpscale(crop, Boolean(view)),
  };
}

function originalViewUpscale(
  crop: QwenSamplingCrop | undefined,
  nativeView: boolean,
) {
  if (
    crop?.pairedWindow ||
    (crop?.referenceEdit &&
      ["brush", "effect", "caption", "roughStone", "washedTitle"].includes(
        crop.referenceEdit,
      ))
  )
    return;
  return crop?.nativeSourceMask || nativeView ? 1.9 : 1.25;
}

export async function prepareQwenSamplingInputs(
  pipeline: { control?: QwenControlCrop; native?: QwenNativeReference },
  request: FluxWorkerRequest,
  inputs: {
    source: NativeImage;
    stencil: Uint8Array;
    nativeGuide?: Awaited<ReturnType<QwenNativeReference["prepareCrop"]>>;
  },
  crop: QwenSamplingCrop | undefined,
  size: Size,
  signal: AbortSignal,
) {
  if (pipeline.native)
    return pipeline.native.prepare(
      inputs.source,
      inputs.stencil,
      request,
      size,
      signal,
      inputs.nativeGuide,
    );
  const { control } = pipeline;
  if (!control || !crop)
    throw new Error("Qwen 인페인팅 실행기 설정이 올바르지 않습니다.");
  const image = request.input + ".qwen.png";
  if (!crop.pairedWindow && !crop.nativeSourceMask)
    await writeFile(
      image,
      inputs.source.resize({ ...size, quality: "best" }).toPNG(),
    );
  return (output: string) =>
    control.argumentsFor(crop, size, image, output, signal);
}
const instruction =
  "Restore the first manga illustration. The lettering has been cleared from the area shown in white in the second image. Finish the underlying artwork using the visible ends of the original pen lines, shading, paper grain and screentone. Preserve the original framing, objects and empty paper. Keep the repaired illustration completely free of text or lettering.";
function nativeSettings(
  models: Omit<QwenImageModelPaths, "vision"> & { vision?: string },
  adapter: { directory: string; name: string; strength: number } | undefined,
  imagePath: string,
  stencilPath: string,
  size: { width: number; height: number },
  encoderDevice: string,
  device?: string,
  material?: ReturnType<typeof nativePrintedStock>,
) {
  if (!models.vision) throw new Error("Qwen 이미지 참조 인코더가 없습니다.");
  return {
    context: {
      diffusion_model_path: models.diffusion,
      llm_path: models.text,
      llm_vision_path: models.vision,
      vae_path: models.vae,
      backend: device
        ? `clip=${encoderDevice},vae=${encoderDevice},diffusion=${device}`
        : "clip=cpu,vae=cpu",
      params_backend: "*=cpu",
      max_vram: "3.5",
      flash_attn_mode: "off,diffusion=on",
      enable_mmap: true,
      n_threads: 8,
    },
    generation: {
      prompt: material ? referenceInstructions[material] : instruction,
      negative_prompt:
        (material === "drawnCloth" && measuredPrintNegative(material)) ||
        "letters, Japanese writing, watermark, ghost strokes, residual text, altered pose, duplicated arms, extra fingers",
      width: size.width,
      height: size.height,
      seed: material ? 20 : 42,
      "sample.steps": material ? 28 : 40,
      "sample.guidance.txt_cfg": material ? 2.5 : 3.1,
      "sample.method": "euler",
      ...(material === "drawnCloth" ? { "sample.scheduler": "simple" } : {}),
      "vae_tiling.enabled": true,
      "vae_tiling.tile_size_w": 512,
      "vae_tiling.tile_size_h": 512,
    },
    references: [imagePath, stencilPath],
    ...(adapter
      ? {
          lora: {
            path: join(adapter.directory, adapter.name + ".safetensors"),
            multiplier: adapter.strength,
            is_high_noise: false,
          },
        }
      : {}),
  };
}
