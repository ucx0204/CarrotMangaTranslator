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
import { generateCodexErasedCrop } from "../pipeline/codexTypesettingImageRequest";
import { compositeCodexRepair } from "./codexRepairComposite";
import {
  planCodexRepairTiles,
  prepareCodexRepairMask,
  prepareCodexErasureTargets,
} from "./codexRepairTiles";
import { isolateMaskToWindow } from "./imageRaster";
import { expandWindowMaskToPage } from "./inpaintingWindowMask";
import { expandRect, type PixelRect } from "./maskGeometry";
import type {
  InpaintingEngine,
  CodexRepairRequest as Request,
} from "./inpaintingEngine";
import type { CodexErasureTarget } from "../application/codexTypesettingContracts";
import type { InpaintingEngineLease } from "./inpaintingEnginePool";
import {
  inpaintWithNativePageContext,
  verifyCodexInputBitmap,
  type CodexNativePageContext,
} from "./codexNativePageContext";

type Client = Pick<CodexAppServerClient, "runEphemeralTurn">;

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

/** One generation per planned native tile; no fallback or repair loop. */
export function createCodexInpaintingEngine(
  client: Client,
  directory: string,
  signal: AbortSignal,
  dispose: () => Promise<void>,
  protectedMask?: Uint8Array,
  nativeContext?: CodexNativePageContext,
  targets?: CodexErasureTarget[],
): InpaintingEngine {
  return {
    model: "codex",
    backend: "imagegen",
    runtimePath: "codex",
    runRootDir: directory,
    dispose,
    inpaint: async (bitmap, width, height, mask, windows, options) => {
      options = { ...options, codexTargets: options?.codexTargets ?? targets };
      const original = Buffer.from(bitmap);
      const request = {
        bitmap: original,
        width,
        height,
        ...prepareCodexRepairMask(mask, width, height, options),
        windows,
        signal: options?.signal ?? signal,
        protectedMask,
        targets: options.codexTargets,
      };
      if (protectedMask && protectedMask.length !== width * height)
        throw new Error("제외 영역의 이미지 크기가 다릅니다.");
      const hidden = externalImageMask(options?.sourceImagePath, width, height);
      if (hidden?.some((value, pixel) => value > 0 && request.mask[pixel] > 0))
        throw new Error(
          "가리기와 겹치는 원문 제거 영역을 제외하거나 가리기를 수정해 주세요.",
        );
      request.signal.throwIfAborted();
      await verifyCodexInputBitmap(request, options);
      if (
        await tryNativeContext(
          {
            client,
            directory,
            signal: request.signal,
            protectedMask,
            nativeContext,
          },
          [original, width, height, mask, windows, options],
        )
      ) {
        original.copy(bitmap);
        return;
      }
      const working = hidden
        ? flattenImageRedaction(original, hidden)
        : original;
      await inpaintWindows(
        client,
        directory,
        { ...request, bitmap: working },
        options,
      );
      request.signal.throwIfAborted();
      restoreHiddenPixels(original, working, hidden);
      working.copy(bitmap);
    },
  };
}

async function inpaintCodexWindow(
  client: Client,
  directory: string,
  request: Request,
  window: PixelRect,
  index: string,
  rect: PixelRect,
) {
  const source = nativeImage.createFromBitmap(request.bitmap, {
    width: request.width,
    height: request.height,
  });
  const crop = source.crop({
    x: rect.x,
    y: rect.y,
    width: rect.w,
    height: rect.h,
  });
  const mask = cropMask(request, rect);
  await writeFile(join(directory, `source-${index}.png`), crop.toPNG());
  await writeFile(
    join(directory, `permission-${index}.png`),
    PNG.sync.write(mask.image),
  );
  const output = await generateCodexErasedCrop(
    client,
    directory,
    request.signal,
    crop.toDataURL(),
    mask.image,
    request.mode,
    prepareCodexErasureTargets(request.targets, rect, window),
  );
  request.signal.throwIfAborted();
  const decoded = nativeImage.createFromBuffer(output);
  if (decoded.isEmpty())
    throw new Error("Codex 원문 제거 결과를 읽지 못했습니다.");
  const generated = decoded.getSize();
  if (
    Math.abs(Math.log(generated.width / generated.height / (rect.w / rect.h))) >
    0.025
  )
    throw new Error(
      "생성된 배경의 비율이 요청한 작업 영역과 다릅니다. 결과를 확인해 주세요.",
    );
  const candidate = PNG.sync.read(
    decoded.resize({ width: rect.w, height: rect.h, quality: "best" }).toPNG(),
  );
  const original = PNG.sync.read(crop.toPNG());
  const erase = {
    x: Math.max(0, window.x - rect.x),
    y: Math.max(0, window.y - rect.y),
    w:
      Math.min(rect.x + rect.w, window.x + window.w) -
      Math.max(rect.x, window.x),
    h:
      Math.min(rect.y + rect.h, window.y + window.h) -
      Math.max(rect.y, window.y),
  };
  const repair = compositeCodexRepair(
    original,
    candidate,
    erase,
    mask.permission,
    request.mode,
    mask.core,
  );
  await recordRepair(
    directory,
    index,
    { rect, erase, mode: request.mode, generatedSize: decoded.getSize() },
    repair,
  );
  pasteRepair(request, rect, repair);
}

async function recordRepair(
  directory: string,
  index: string,
  geometry: {
    rect: PixelRect;
    erase: PixelRect;
    mode: Request["mode"];
    generatedSize: { width: number; height: number };
  },
  repair: ReturnType<typeof compositeCodexRepair>,
) {
  await writeFile(
    join(directory, `splice-${index}-${randomUUID()}.json`),
    JSON.stringify({
      ...geometry,
      registration: repair.registration,
      thresholds: repair.difference.thresholds,
      tone: repair.tone,
      changedPixels: repair.difference.changedPixels,
    }),
  );
  // Misaligned context is not image noise. An inflated noise threshold can
  // suppress most removed glyphs while leaving a few changed pixels behind.
  // Those few pixels must not turn an unusable splice into a successful edit.
  if (
    (repair.difference.changedPixels === 0 ||
      (repair.difference.thresholds.fine > 72 &&
        repair.difference.thresholds.coarse > 42)) &&
    repair.registration.samples >= 32 &&
    repair.registration.contextErrorAfter > 0.06 &&
    repair.registration.boundary.worst > 0.12
  )
    throw new Error(
      "생성된 배경의 구도·경계가 원본과 맞지 않아 적용하지 못했습니다.",
    );
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
      if (request.protectedMask?.[(y + rect.y) * request.width + x + rect.x])
        continue;
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
      const value = permittedPixel(request, at) ? 255 : 0;
      const offset = (y * rect.w + x) * 4;
      image.data.fill(value, offset, offset + 3);
      image.data[offset + 3] = 255;
      permission[y * rect.w + x] = value ? 1 : 0;
      if (core)
        core[y * rect.w + x] = value && request.paintedCore?.[at] ? 1 : 0;
    }
  return { image, permission, core };
}

function permittedPixel(request: Request, at: number): boolean {
  const bounds = request.tileBounds;
  if (bounds) {
    const x = at % request.width,
      y = Math.floor(at / request.width);
    if (
      x < bounds.x ||
      x >= bounds.x + bounds.w ||
      y < bounds.y ||
      y >= bounds.y + bounds.h
    )
      return false;
  }
  return Boolean(
    request.mask[at] &&
    !request.protectedMask?.[at] &&
    (!request.constraint || request.constraint[at]),
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

async function tryNativeContext(
  owner: {
    client: Client;
    directory: string;
    signal: AbortSignal;
    protectedMask?: Uint8Array;
    nativeContext?: CodexNativePageContext;
  },
  args: Parameters<InpaintingEngine["inpaint"]>,
): Promise<boolean> {
  const { client, directory, signal, protectedMask, nativeContext } = owner;
  const [bitmap, width, height, mask, windows, options] = args;
  if (!nativeContext || Math.max(width, height) <= Math.min(width, height) * 3)
    return false;
  await inpaintWithNativePageContext(
    nativeContext,
    (keep) =>
      createCodexInpaintingEngine(
        client,
        directory,
        signal,
        async () => {},
        keep,
      ),
    directory,
    protectedMask,
    [bitmap, width, height, mask, windows, { ...options, signal }],
  );
  return true;
}

async function inpaintWindows(
  client: Client,
  directory: string,
  request: Request,
  options: Parameters<InpaintingEngine["inpaint"]>[5],
) {
  for (const [index, window] of request.windows.entries()) {
    request.signal.throwIfAborted();
    const owned = windowRequest(request, window, index, options);
    const tiles = planCodexRepairTiles(
      window,
      request.width,
      request.height,
      owned.mask,
    );
    await writeFile(
      join(directory, `tiles-${index}-${randomUUID()}.json`),
      JSON.stringify({ window, tiles }),
    );
    for (const [tileIndex, tile] of tiles.entries()) {
      request.signal.throwIfAborted();
      await inpaintCodexWindow(
        client,
        directory,
        {
          ...owned,
          tileBounds: tiles.length > 1 ? tile.writeBounds : undefined,
        },
        window,
        `${index}-${tileIndex}`,
        tile.cropBounds,
      );
    }
  }
}
