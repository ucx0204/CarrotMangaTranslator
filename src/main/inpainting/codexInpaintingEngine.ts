import { app, nativeImage } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { PNG } from "pngjs";
import type { AppPaths } from "../appPaths";
import type { AppSettings } from "../../shared/settingsTypes";
import { CODEX_TYPESETTING_MODEL } from "../../shared/codexTypesettingDefaults";
import { CodexAppServerClient } from "../codexAppServerClient";
import {
  generateImage,
  erasureImageInputs,
} from "../pipeline/codexTypesettingImageRequest";
import {
  registerTypesettingPatch,
  compositeRegisteredPatch,
} from "../pipeline/codexTypesettingRegistration";
import { compositeFluxOutput, isolateMaskToWindow } from "./imageRaster";
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
  feather: number;
  compositeMask?: Uint8Array;
  constraint?: Uint8Array;
};

export async function acquireCodexInpaintingEngine(
  paths: AppPaths,
  settings: AppSettings,
  signal: AbortSignal,
): Promise<InpaintingEngineLease> {
  const directory = join(paths.dataRoot, "codex", "inpainting", randomUUID());
  await mkdir(directory, { recursive: true });
  const connection = await CodexAppServerClient.start({
    paths: { ...paths, codexWorkspaceDir: directory },
    appVersion: app.getVersion(),
    capability: "image-generation",
    signal,
  });
  try {
    signal.throwIfAborted();
    const account = await connection.readAccount(false);
    if (account.account?.type !== "chatgpt")
      throw new Error("설정에서 Codex 계정을 연결해 주세요.");
    const effort = settings.codex.imageReasoningEffort ?? "low";
    const model = (await connection.listModels()).find(
      (item) => item.id === CODEX_TYPESETTING_MODEL,
    );
    if (!model?.supportedReasoningEfforts.includes(effort))
      throw new Error("선택한 Astra 모델을 사용할 수 없습니다.");
    const client: Client = {
      runEphemeralTurn: (request) =>
        connection.runEphemeralTurn({
          ...request,
          model: CODEX_TYPESETTING_MODEL,
          effort,
        }),
    };
    const engine = createCodexInpaintingEngine(client, directory, signal, () =>
      connection.dispose(),
    );
    return { engine, release: engine.dispose };
  } catch (error) {
    await connection.dispose();
    throw error;
  }
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
        mask,
        windows,
        signal: options?.signal ?? signal,
        feather: options?.featherPx ?? 8,
      };
      const working = Buffer.from(bitmap);
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
      working.copy(bitmap);
    },
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
  const registration = registerTypesettingPatch(
    original,
    candidate,
    erase,
    mask.permission,
  );
  await writeFile(
    join(directory, `splice-${index}-${randomUUID()}.json`),
    JSON.stringify({ rect, erase, registration }),
  );
  if (!registration.supported || !registration.opaque)
    throw new Error("Codex 결과가 선택 영역을 완전히 덮지 못했습니다.");
  const aligned = PNG.sync.read(crop.toPNG());
  compositeRegisteredPatch(
    aligned,
    candidate,
    { x: 0, y: 0, w: rect.w, h: rect.h },
    { x: 0, y: 0 },
    registration.transform,
  );
  const pixels = nativeImage
    .createFromBuffer(PNG.sync.write(aligned))
    .toBitmap();
  // Reuse the existing full-opacity core / outer feather and never paste the whole crop.
  compositeFluxOutput(
    request.bitmap,
    pixels,
    request.compositeMask ?? request.mask,
    request.width,
    rect,
    request.feather,
    expandRect(window, request.width, request.height, request.feather),
    request.constraint,
  );
}

function cropMask(request: Request, rect: PixelRect) {
  const image = new PNG({ width: rect.w, height: rect.h });
  const permission = new Uint8Array(rect.w * rect.h);
  for (let y = 0; y < rect.h; y++)
    for (let x = 0; x < rect.w; x++) {
      const value = request.mask[(y + rect.y) * request.width + x + rect.x]
        ? 255
        : 0;
      const offset = (y * rect.w + x) * 4;
      image.data.fill(value, offset, offset + 3);
      image.data[offset + 3] = 255;
      permission[y * rect.w + x] = value ? 1 : 0;
    }
  return { image, permission };
}

function generateErasedCrop(
  client: Client,
  directory: string,
  signal: AbortSignal,
  crop: string,
  mask: PNG,
) {
  return generateImage(
    client,
    directory,
    signal,
    "Reconstruct every magenta hole in image 1 as background artwork. Image 2 is the WHITE edit-permission mask; image 3 is the original for surrounding-artwork reference only. Remove all masked lettering, outlines, detached marks and extended brush strokes; never restore them from image 3. Preserve unmasked people, objects, balloon outlines, screentone, alignment and framing. Add no replacement lettering or magenta. Return one complete edited crop at the same aspect ratio.",
    erasureImageInputs(crop, mask),
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
  const core = options.compositeMasks?.[index];
  const constraint = options.compositeConstraints?.[index];
  const expand = (mask: NonNullable<typeof owned>) =>
    expandWindowMaskToPage(mask, request.width, request.height);
  return {
    ...request,
    mask: owned
      ? expand(owned)
      : isolateMaskToWindow(request.mask, request.width, window),
    compositeMask: core ? expand(core) : undefined,
    constraint: constraint ? expand(constraint) : undefined,
    feather: options.compositeFeatherPx?.[index] ?? request.feather,
  };
}
