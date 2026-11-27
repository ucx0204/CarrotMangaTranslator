import { externalImageMask } from "../imageRedactionContext";
import {
  flattenImageRedaction,
  restoreHiddenPixels,
} from "../imageRedactionPixels";
import { nativeImage } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { PNG } from "pngjs";
import { prepareCodexRepairFrames, recordRepair } from "./codexRepairFraming";
import type { AppPaths } from "../appPaths";
import type { AppSettings } from "../../shared/settingsTypes";
import { startCodexImageSession } from "../codexImageSession";
import type { CodexAppServerClient } from "../codexAppServerClient";
import { generateCodexErasedCrop } from "../pipeline/codexTypesettingImageRequest";
import {
  compositeCodexRepair,
  type CodexRepairGeometryError,
} from "./codexRepairComposite";
import {
  applyCodexRepairTiles,
  planCodexRepairTiles,
  prepareCodexRepairMask,
  prepareCodexErasureTargets,
} from "./codexRepairTiles";
import { cropBitmapFromPage, isolateMaskToWindow } from "./imageRaster";
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
    index,
  );
  request.signal.throwIfAborted();
  const decoded = nativeImage.createFromBuffer(output);
  if (decoded.isEmpty())
    throw new Error("Codex 원문 제거 결과를 읽지 못했습니다.");
  const original = PNG.sync.read(crop.toPNG());
  const { candidate, aspectMismatch, crops } = prepareCodexRepairFrames(
    decoded,
    crop,
    mask.permission,
  );
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
    { crops, selection: mask.selection },
  );
  await recordRepair(
    directory,
    index,
    {
      rect,
      erase,
      mode: request.mode,
      generatedSize: decoded.getSize(),
      aspectMismatch,
    },
    repair,
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
  const selection = request.tileBounds
    ? new Uint8Array(permission.length)
    : undefined;
  const core = request.paintedCore
    ? new Uint8Array(permission.length)
    : undefined;
  for (let y = 0; y < rect.h; y++)
    for (let x = 0; x < rect.w; x++) {
      const at = (y + rect.y) * request.width + x + rect.x;
      const local = y * rect.w + x;
      const allowed = permittedPixel(request, at);
      if (selection) selection[local] = Number(allowed);
      const owned = Number(
        allowed && inTile(request.tileBounds, x + rect.x, y + rect.y),
      );
      const offset = local * 4;
      image.data.fill(owned * 255, offset, offset + 3);
      image.data[offset + 3] = 255;
      permission[local] = owned;
      if (core) core[local] = owned && request.paintedCore?.[at] ? 1 : 0;
    }
  return { image, permission, core, selection };
}

function permittedPixel(request: Request, at: number): boolean {
  return Boolean(
    request.mask[at] &&
    !request.protectedMask?.[at] &&
    (!request.constraint || request.constraint[at]),
  );
}

function inTile(bounds: PixelRect | undefined, x: number, y: number): boolean {
  return (
    !bounds ||
    (x >= bounds.x &&
      x < bounds.x + bounds.w &&
      y >= bounds.y &&
      y < bounds.y + bounds.h)
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
  // Pattern pages account for unchanged blocks individually. Brush edits and
  // single-window callers still publish their entire request atomically.
  const partial =
    request.mode === "region" &&
    request.windows.length > 1 &&
    options?.requirePixelChange === false;
  const bounds = request.windows.map(
    (window, index) => options?.windowMasks?.[index]?.bounds ?? window,
  );
  let firstHeld: CodexRepairGeometryError | undefined;
  let completed = false;
  for (const [index, window] of request.windows.entries()) {
    request.signal.throwIfAborted();
    const attemptId = randomUUID();
    const owned = windowRequest(request, window, index, options);
    const tiles = planCodexRepairTiles(
      window,
      request.width,
      request.height,
      owned.mask,
    );
    await writeFile(
      join(directory, `tiles-${attemptId}-${index}.json`),
      JSON.stringify({ window, tiles }),
    );
    const held = await applyCodexRepairTiles(
      owned,
      tiles,
      partial
        ? {
            bounds,
            index,
            // A single-tile rejection occurs before the first page write.
            before:
              tiles.length > 1
                ? cropBitmapFromPage(owned.bitmap, owned.width, bounds[index])
                : undefined,
          }
        : undefined,
      (tile, tileIndex) =>
        inpaintCodexWindow(
          client,
          directory,
          {
            ...owned,
            tileBounds: tiles.length > 1 ? tile.writeBounds : undefined,
          },
          window,
          `${attemptId}-${index}-${tileIndex}`,
          tile.cropBounds,
        ),
    );
    if (held) firstHeld ??= held;
    else if (tiles.length) completed = true;
  }
  if (firstHeld && !completed) throw firstHeld;
}
