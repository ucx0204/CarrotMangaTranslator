import { externalImageMask } from "../imageRedactionContext";
import { flattenImageRedaction } from "../imageRedactionPixels";
import { nativeImage } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { PNG } from "pngjs";
import type { AppPaths } from "../appPaths";
import type { AppSettings } from "../../shared/settingsTypes";
import { startCodexImageSession } from "../codexImageSession";
import type { CodexAppServerClient } from "../codexAppServerClient";
import {
  generateImage,
  erasureImageInputs,
} from "../pipeline/codexTypesettingImageRequest";
import { compositeCodexRepair } from "./codexRepairComposite";
import { dilateBinaryMaskDisk } from "./patternMaskMorphology";
import { isolateMaskToWindow } from "./imageRaster";
import { expandWindowMaskToPage } from "./inpaintingWindowMask";
import { expandRect, type PixelRect } from "./maskGeometry";
import type { InpaintingEngine } from "./inpaintingEngine";
import type { InpaintingEngineLease } from "./inpaintingEnginePool";

type Client = Pick<CodexAppServerClient, "runEphemeralTurn">;
type Request = {
  bitmap: Buffer;
  width: number;
  height: number;
  mask: Uint8Array;
  windows: PixelRect[];
  signal: AbortSignal;
  mode: "region" | "paint";
  paintedCore?: Uint8Array;
  feather: number;
  constraint?: Uint8Array;
};

export async function acquireCodexInpaintingEngine(
  paths: AppPaths,
  settings: AppSettings,
  signal: AbortSignal,
): Promise<InpaintingEngineLease> {
  const directory = join(paths.dataRoot, "codex", "inpainting", randomUUID());
  await mkdir(directory, { recursive: true });
  const client = await startCodexImageSession(
    paths,
    settings,
    directory,
    signal,
  );
  const engine = createCodexInpaintingEngine(
    client,
    directory,
    signal,
    client.dispose,
  );
  return { engine, release: engine.dispose };
}

/** One generated crop per requested window; no local-model fallback or repair loop. */
export function createCodexInpaintingEngine(
  client: Client,
  directory: string,
  signal: AbortSignal,
  dispose: () => Promise<void>,
): InpaintingEngine {
  return {
    model: "codex",
    backend: "imagegen",
    runtimePath: "codex",
    runRootDir: directory,
    dispose,
    inpaint: async (bitmap, width, height, mask, windows, options) => {
      const request = {
        bitmap,
        width,
        height,
        ...prepareRepairMask(mask, width, height, options),
        windows,
        signal: options?.signal ?? signal,
      };
      const hidden = externalImageMask(options?.sourceImagePath, width, height);
      if (hidden?.some((value, pixel) => value > 0 && request.mask[pixel] > 0))
        throw new Error(
          "가리기와 겹치는 원문 제거 영역을 제외하거나 가리기를 수정해 주세요.",
        );
      const working = hidden
        ? flattenImageRedaction(bitmap, hidden)
        : Buffer.from(bitmap);
      for (const [index, window] of windows.entries()) {
        request.signal.throwIfAborted();
        await inpaintCodexWindow(
          client,
          directory,
          windowRequest(
            { ...request, bitmap: working },
            window,
            index,
            options,
          ),
          window,
          index,
        );
      }
      request.signal.throwIfAborted();
      restoreHiddenPixels(bitmap, working, hidden);
      working.copy(bitmap);
    },
  };
}

function prepareRepairMask(
  mask: Uint8Array,
  width: number,
  height: number,
  options: Parameters<InpaintingEngine["inpaint"]>[5],
) {
  const mode = options?.codexMaskMode ?? "paint";
  const feather = Math.max(
    0,
    Math.min(24, Math.round(options?.featherPx ?? 8)),
  );
  return {
    mode,
    feather,
    paintedCore: mode === "paint" ? mask : undefined,
    mask:
      mode === "paint"
        ? dilateBinaryMaskDisk(mask, width, height, feather)
        : mask,
  };
}

async function inpaintCodexWindow(
  client: Client,
  directory: string,
  request: Request,
  window: PixelRect,
  index: number,
) {
  const source = nativeImage.createFromBitmap(request.bitmap, {
    width: request.width,
    height: request.height,
  });
  const rect = expandRect(
    window,
    request.width,
    request.height,
    Math.max(48, Math.ceil(Math.max(window.w, window.h) * 0.35)),
  );
  const crop = source.crop({
    x: rect.x,
    y: rect.y,
    width: rect.w,
    height: rect.h,
  });
  const mask = cropMask(request, rect);
  const output = await generateErasedCrop(
    client,
    directory,
    request.signal,
    crop.toDataURL(),
    mask.image,
    request.mode,
  );
  request.signal.throwIfAborted();
  const decoded = nativeImage.createFromBuffer(output);
  if (decoded.isEmpty())
    throw new Error("Codex 원문 제거 결과를 읽지 못했습니다.");
  const candidate = PNG.sync.read(
    decoded.resize({ width: rect.w, height: rect.h, quality: "best" }).toPNG(),
  );
  const original = PNG.sync.read(crop.toPNG());
  const erase = {
    x: window.x - rect.x,
    y: window.y - rect.y,
    w: window.w,
    h: window.h,
  };
  const repair = compositeCodexRepair(
    original,
    candidate,
    erase,
    mask.permission,
    request.mode,
    mask.core,
  );
  await writeFile(
    join(directory, `splice-${index}-${randomUUID()}.json`),
    JSON.stringify({
      rect,
      erase,
      mode: request.mode,
      registration: repair.registration,
      thresholds: repair.difference.thresholds,
      tone: repair.tone,
      changedPixels: repair.difference.changedPixels,
    }),
  );
  pasteRepair(request, rect, repair);
}

function pasteRepair(
  request: Request,
  rect: PixelRect,
  repair: ReturnType<typeof compositeCodexRepair>,
) {
  const repairedPng = Object.assign(
    new PNG({ width: rect.w, height: rect.h }),
    repair.output,
  );
  const pixels = nativeImage
    .createFromBuffer(PNG.sync.write(repairedPng))
    .toBitmap();
  for (let y = 0; y < rect.h; y++) {
    for (let x = 0; x < rect.w; x++) {
      if (!repair.difference.opacity[y * rect.w + x]) continue;
      const from = (y * rect.w + x) * 4;
      pixels.copy(
        request.bitmap,
        ((y + rect.y) * request.width + x + rect.x) * 4,
        from,
        from + 4,
      );
    }
  }
}

function cropMask(request: Request, rect: PixelRect) {
  const image = new PNG({ width: rect.w, height: rect.h });
  const permission = new Uint8Array(rect.w * rect.h);
  const core = request.paintedCore
    ? new Uint8Array(permission.length)
    : undefined;
  for (let y = 0; y < rect.h; y++)
    for (let x = 0; x < rect.w; x++) {
      const at = (y + rect.y) * request.width + x + rect.x;
      const value =
        request.mask[at] && (!request.constraint || request.constraint[at])
          ? 255
          : 0;
      const offset = (y * rect.w + x) * 4;
      image.data.fill(value, offset, offset + 3);
      image.data[offset + 3] = 255;
      permission[y * rect.w + x] = value ? 1 : 0;
      if (core)
        core[y * rect.w + x] = value && request.paintedCore?.[at] ? 1 : 0;
    }
  return { image, permission, core };
}

function generateErasedCrop(
  client: Client,
  directory: string,
  signal: AbortSignal,
  crop: string,
  mask: PNG,
  mode: "region" | "paint",
) {
  return generateImage(
    client,
    directory,
    signal,
    mode === "region"
      ? "Remove all lettering within the WHITE permitted region in image 2 from the original crop in image 1. This is a selection boundary, not a request to clear all artwork in that region. Locate the entire visible lettering yourself, including outlines, shadows, halos, detached marks, pale or colored lettering, and extended strokes. Remove decorative backplates and embellishments that belong to the typography as one complete graphic, rather than leaving its empty backing behind. Keep narrative balloon boundaries. Reconstruct the artwork behind only those letters. Preserve all non-lettering shapes, people, objects, borders, screentone, color, framing and their exact positions, including inside the permitted region. Do not mistake illustration contours or motion lines for lettering. If the selected area contains no identifiable typography, leave it unchanged. Do not add replacement text. Return one complete cleaned crop with the original aspect ratio."
      : "Reconstruct every magenta hole in image 1 as background artwork. Image 2 is the WHITE edit-permission mask; image 3 is the original for surrounding-artwork reference only. Remove all masked typography including its backplates, decorative marks, outlines, shadows and extended brush strokes; never restore them from image 3. Preserve unmasked people, objects, balloon outlines, screentone, alignment and framing. Add no replacement lettering or magenta. Return one complete edited crop at the same aspect ratio.",
    mode === "region"
      ? [
          crop,
          `data:image/png;base64,${PNG.sync.write(mask).toString("base64")}`,
        ]
      : erasureImageInputs(crop, mask),
    { width: mask.width, height: mask.height },
  );
}

function windowRequest(
  request: Request,
  window: PixelRect,
  index: number,
  options: NonNullable<Parameters<InpaintingEngine["inpaint"]>[5]> = {},
): Request {
  const owned = options.windowMasks?.[index];
  const constraint = options.compositeConstraints?.[index];
  const expand = (mask: NonNullable<typeof owned>) =>
    expandWindowMaskToPage(mask, request.width, request.height);
  return {
    ...request,
    mask: owned
      ? expand(owned)
      : isolateMaskToWindow(
          request.mask,
          request.width,
          request.mode === "paint"
            ? expandRect(window, request.width, request.height, request.feather)
            : window,
        ),
    constraint: constraint ? expand(constraint) : undefined,
  };
}

function restoreHiddenPixels(
  original: Buffer,
  working: Buffer,
  hidden?: Uint8Array,
): void {
  if (!hidden) return;
  for (let pixel = 0; pixel < hidden.length; pixel++)
    if (hidden[pixel])
      original.copy(working, pixel * 4, pixel * 4, pixel * 4 + 4);
}
