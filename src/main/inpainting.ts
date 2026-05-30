import { nativeImage } from "electron";
import { once } from "node:events";
import { createWriteStream, existsSync, statSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { bboxToPixels, clamp } from "../shared/geometry";
import type { BBox, InpaintingPoint, MangaPage, TranslationBlock } from "../shared/types";

type OrtModule = typeof import("onnxruntime-node");
type OrtSession = import("onnxruntime-node").InferenceSession;

const LAMA_MODEL_REPO = "mayocream/lama-manga-onnx";
const LAMA_MODEL_FILE = "lama-manga.onnx";
const LAMA_MODEL_URL = `https://huggingface.co/${LAMA_MODEL_REPO}/resolve/main/${LAMA_MODEL_FILE}`;
const LAMA_INPUT_SIZE = 512;

type Rgb = {
  r: number;
  g: number;
  b: number;
};

type PixelRect = {
  x: number;
  y: number;
  w: number;
  h: number;
};

export type InpaintingRuntimeProgress = {
  progressText: string;
  detail?: string;
  progressMode?: "determinate" | "indeterminate" | "log-only";
  progressPercent?: number;
  progressBytes?: number;
  progressTotalBytes?: number;
  installLogLine?: string;
};

export type LamaInpaintingEngine = {
  modelPath: string;
  inpaint: (bitmap: Buffer, width: number, height: number, mask: Uint8Array, windows: PixelRect[], signal?: AbortSignal) => Promise<void>;
  dispose: () => Promise<void>;
};

export type SolidPageInpaintingResult = {
  page: MangaPage;
  blocksErased: number;
};

export type ImageDecodeFallback = (filePath: string) => Promise<Buffer | null>;

export async function inpaintSolidPage(
  page: MangaPage,
  options: {
    signal?: AbortSignal;
    decodeFallback?: ImageDecodeFallback;
    lamaEngine?: LamaInpaintingEngine;
  } = {}
): Promise<SolidPageInpaintingResult> {
  const solidBlocks = page.blocks.filter((block) => block.type === "solid" && hasUsableBbox(block.bbox));
  if (solidBlocks.length === 0) {
    return { page, blocksErased: 0 };
  }

  const image = await loadPageImage(page.inpaintedImagePath ?? page.imagePath, options.decodeFallback);
  const size = image.getSize();
  if (!size.width || !size.height) {
    throw new Error(`페이지 이미지를 읽지 못했습니다: ${page.name}`);
  }

  const bitmap = Buffer.from(image.toBitmap());
  if (bitmap.length < size.width * size.height * 4) {
    throw new Error(`페이지 이미지 비트맵을 만들지 못했습니다: ${page.name}`);
  }
  const pageMask = new Uint8Array(size.width * size.height);
  const inpaintWindows: PixelRect[] = [];
  let blocksErased = 0;
  for (const block of solidBlocks) {
    throwIfAborted(options.signal);
    const rect = expandRect(bboxToPixelRect(block.bbox, page), size.width, size.height, resolveBlockMarginPx(block, page));
    const blockMask = buildTextLikeMask(bitmap, size.width, size.height, rect, resolveDilationRadius(block));
    if (blockMask.count > 0) {
      mergeMaskIntoPage(pageMask, size.width, rect, blockMask.mask);
      inpaintWindows.push(expandRect(rect, size.width, size.height, 128));
      blocksErased += 1;
    }
  }

  if (blocksErased === 0) {
    return { page, blocksErased: 0 };
  }

  if (!options.lamaEngine) {
    throw new Error("LaMA 인페인팅 모델이 준비되지 않았습니다.");
  }

  await options.lamaEngine.inpaint(bitmap, size.width, size.height, pageMask, mergeRects(inpaintWindows), options.signal);

  const outputImage = nativeImage.createFromBitmap(bitmap, {
    width: size.width,
    height: size.height
  });
  if (outputImage.isEmpty()) {
    throw new Error(`인페인팅 결과 이미지를 만들지 못했습니다: ${page.name}`);
  }

  const outputPath = resolveInpaintedImagePath(page.imagePath);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, outputImage.toPNG());

  return {
    blocksErased,
    page: {
      ...page,
      inpaintedImagePath: outputPath,
      updatedAt: new Date().toISOString()
    }
  };
}

export async function prepareLamaInpaintingEngine(options: {
  modelDir: string;
  signal?: AbortSignal;
  onProgress?: (progress: InpaintingRuntimeProgress) => void;
}): Promise<LamaInpaintingEngine> {
  const modelPath = await ensureLamaModelFile(options);
  options.onProgress?.({
    progressText: "LaMA 인페인팅 모델 로드 중",
    detail: LAMA_MODEL_FILE,
    progressMode: "indeterminate",
    installLogLine: "LaMA 인페인팅 모델을 메모리에 로드합니다."
  });
  const ort = await loadOnnxRuntime();
  const session = await ort.InferenceSession.create(modelPath);
  options.onProgress?.({
    progressText: "LaMA 인페인팅 모델 준비 완료",
    detail: LAMA_MODEL_FILE,
    progressMode: "log-only",
    installLogLine: "LaMA 인페인팅 모델 준비가 완료되었습니다."
  });
  return createLamaEngine(ort, session, modelPath);
}

export async function applyInpaintingRetouch(
  page: MangaPage,
  options: {
    mode: "paint" | "restore";
    points: InpaintingPoint[];
    radiusPx: number;
    color?: string;
    decodeFallback?: ImageDecodeFallback;
  }
): Promise<MangaPage> {
  const points = sanitizePoints(options.points, page.width, page.height);
  if (points.length === 0) {
    return page;
  }

  const baseImage = await loadPageImage(page.inpaintedImagePath ?? page.imagePath, options.decodeFallback);
  const originalImage = await loadPageImage(page.imagePath, options.decodeFallback);
  const size = baseImage.getSize();
  const originalSize = originalImage.getSize();
  if (size.width !== originalSize.width || size.height !== originalSize.height) {
    throw new Error("원본 이미지와 편집 이미지 크기가 다릅니다.");
  }

  const bitmap = Buffer.from(baseImage.toBitmap());
  const originalBitmap = Buffer.from(originalImage.toBitmap());
  const radius = clamp(Math.round(options.radiusPx), 2, 180);
  const paintColor = options.mode === "paint" ? parseHexColor(options.color) : null;

  for (let index = 0; index < points.length; index += 1) {
    const previous = points[index - 1] ?? points[index];
    const current = points[index];
    for (const point of interpolatePoints(previous, current, Math.max(1, radius * 0.35))) {
      applyRetouchCircle(bitmap, originalBitmap, size.width, size.height, point, radius, options.mode, paintColor);
    }
  }

  const outputImage = nativeImage.createFromBitmap(bitmap, {
    width: size.width,
    height: size.height
  });
  if (outputImage.isEmpty()) {
    throw new Error(`리터치 결과 이미지를 만들지 못했습니다: ${page.name}`);
  }

  const outputPath = resolveInpaintedImagePath(page.imagePath, `retouch-${Date.now().toString(36)}`);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, outputImage.toPNG());
  return {
    ...page,
    inpaintedImagePath: outputPath,
    updatedAt: new Date().toISOString()
  };
}

export async function sampleImageColor(
  imagePath: string,
  x: number,
  y: number,
  decodeFallback?: ImageDecodeFallback
): Promise<string> {
  const image = await loadPageImage(imagePath, decodeFallback);
  const size = image.getSize();
  const bitmap = Buffer.from(image.toBitmap());
  const px = clamp(Math.round(x), 0, Math.max(0, size.width - 1));
  const py = clamp(Math.round(y), 0, Math.max(0, size.height - 1));
  return rgbToHex(readRgb(bitmap, size.width, px, py));
}

async function ensureLamaModelFile(options: {
  modelDir: string;
  signal?: AbortSignal;
  onProgress?: (progress: InpaintingRuntimeProgress) => void;
}): Promise<string> {
  const modelPath = join(options.modelDir, LAMA_MODEL_FILE);
  if (isUsableFile(modelPath)) {
    options.onProgress?.({
      progressText: "LaMA 인페인팅 모델 캐시 사용",
      detail: LAMA_MODEL_FILE,
      progressMode: "log-only",
      installLogLine: `캐시된 LaMA 모델을 사용합니다: ${LAMA_MODEL_FILE}`
    });
    return modelPath;
  }

  await mkdir(options.modelDir, { recursive: true });
  const partPath = `${modelPath}.part`;
  await rm(partPath, { force: true });
  const totalBytes = await probeContentLength(LAMA_MODEL_URL, options.signal);
  options.onProgress?.({
    progressText: "LaMA 인페인팅 모델 다운로드 중",
    detail: LAMA_MODEL_FILE,
    progressMode: totalBytes > 0 ? "determinate" : "log-only",
    progressPercent: totalBytes > 0 ? 0 : undefined,
    progressBytes: totalBytes > 0 ? 0 : undefined,
    progressTotalBytes: totalBytes > 0 ? totalBytes : undefined,
    installLogLine: `LaMA 모델 다운로드 시작: ${LAMA_MODEL_FILE}`
  });

  const response = await fetch(LAMA_MODEL_URL, { signal: options.signal });
  if (!response.ok || !response.body) {
    throw new Error(`LaMA 인페인팅 모델 다운로드에 실패했습니다 (${response.status}).`);
  }

  const responseTotalBytes = totalBytes || readContentLength(response);
  const reader = response.body.getReader();
  const writer = createWriteStream(partPath, { flags: "wx" });
  let receivedBytes = 0;
  let lastEmitAt = 0;
  try {
    while (true) {
      throwIfAborted(options.signal);
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const chunk = Buffer.from(value);
      await writeStreamChunk(writer, chunk);
      receivedBytes += chunk.byteLength;
      const now = Date.now();
      if (now - lastEmitAt > 500) {
        lastEmitAt = now;
        options.onProgress?.({
          progressText: "LaMA 인페인팅 모델 다운로드 중",
          detail: responseTotalBytes > 0 ? `${formatBytes(receivedBytes)} / ${formatBytes(responseTotalBytes)}` : `${formatBytes(receivedBytes)} 받음`,
          progressMode: responseTotalBytes > 0 ? "determinate" : "log-only",
          progressPercent: responseTotalBytes > 0 ? Math.min(1, receivedBytes / responseTotalBytes) : undefined,
          progressBytes: responseTotalBytes > 0 ? receivedBytes : undefined,
          progressTotalBytes: responseTotalBytes > 0 ? responseTotalBytes : undefined,
          installLogLine:
            responseTotalBytes > 0
              ? `LaMA 모델 다운로드 중: ${formatBytes(receivedBytes)} / ${formatBytes(responseTotalBytes)}`
              : `LaMA 모델 다운로드 중: ${formatBytes(receivedBytes)}`
        });
      }
    }
    await finishWriteStream(writer);
    await rm(modelPath, { force: true });
    await rename(partPath, modelPath);
    options.onProgress?.({
      progressText: "LaMA 인페인팅 모델 다운로드 완료",
      detail: `${LAMA_MODEL_FILE} · ${formatBytes(receivedBytes)}`,
      progressMode: responseTotalBytes > 0 ? "determinate" : "log-only",
      progressPercent: responseTotalBytes > 0 ? 1 : undefined,
      progressBytes: responseTotalBytes > 0 ? responseTotalBytes : undefined,
      progressTotalBytes: responseTotalBytes > 0 ? responseTotalBytes : undefined,
      installLogLine: `LaMA 모델 다운로드 완료: ${LAMA_MODEL_FILE} (${formatBytes(receivedBytes)})`
    });
    return modelPath;
  } catch (error) {
    writer.destroy();
    await rm(partPath, { force: true }).catch(() => {});
    throw error;
  }
}

function createLamaEngine(ort: OrtModule, session: OrtSession, modelPath: string): LamaInpaintingEngine {
  return {
    modelPath,
    async inpaint(bitmap, width, height, mask, windows, signal) {
      const imageInputName = session.inputNames.find((name) => /image|img/i.test(name)) ?? session.inputNames[0];
      const maskInputName = session.inputNames.find((name) => /mask/i.test(name)) ?? session.inputNames[1];
      if (!imageInputName || !maskInputName) {
        throw new Error("LaMA 모델 입력 이름을 확인하지 못했습니다.");
      }
      for (const window of windows) {
        throwIfAborted(signal);
        if (!rectHasMask(mask, width, window)) {
          continue;
        }
        const input = buildLamaInput(bitmap, mask, width, height, window);
        const outputs = await session.run({
          [imageInputName]: new ort.Tensor("float32", input.image, [1, 3, LAMA_INPUT_SIZE, LAMA_INPUT_SIZE]),
          [maskInputName]: new ort.Tensor("float32", input.mask, [1, 1, LAMA_INPUT_SIZE, LAMA_INPUT_SIZE])
        });
        const output = outputs[session.outputNames[0]] ?? Object.values(outputs)[0];
        if (!output) {
          throw new Error("LaMA 인페인팅 출력이 비어 있습니다.");
        }
        compositeLamaOutput(bitmap, mask, width, window, output.data as Float32Array | number[], output.dims.map(Number));
      }
    },
    async dispose() {
      await session.release();
    }
  };
}

let ortModulePromise: Promise<OrtModule> | null = null;

function loadOnnxRuntime(): Promise<OrtModule> {
  ortModulePromise ??= import("onnxruntime-node");
  return ortModulePromise;
}

function isUsableFile(filePath: string): boolean {
  try {
    return existsSync(filePath) && statSync(filePath).isFile() && statSync(filePath).size > 1024 * 1024;
  } catch {
    return false;
  }
}

async function probeContentLength(url: string, signal?: AbortSignal): Promise<number> {
  try {
    const response = await fetch(url, { method: "HEAD", signal });
    return response.ok ? readContentLength(response) : 0;
  } catch {
    return 0;
  }
}

function readContentLength(response: Response): number {
  const value = Number(response.headers.get("content-length"));
  return Number.isFinite(value) && value > 0 ? value : 0;
}

async function writeStreamChunk(writer: ReturnType<typeof createWriteStream>, chunk: Buffer): Promise<void> {
  if (writer.write(chunk)) {
    return;
  }
  await once(writer, "drain");
}

async function finishWriteStream(writer: ReturnType<typeof createWriteStream>): Promise<void> {
  writer.end();
  await once(writer, "finish");
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Math.max(0, bytes);
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const digits = unitIndex === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

function mergeMaskIntoPage(pageMask: Uint8Array, pageWidth: number, rect: PixelRect, rectMask: Uint8Array): void {
  for (let y = 0; y < rect.h; y += 1) {
    for (let x = 0; x < rect.w; x += 1) {
      if (rectMask[y * rect.w + x]) {
        pageMask[(rect.y + y) * pageWidth + rect.x + x] = 1;
      }
    }
  }
}

function mergeRects(rects: PixelRect[]): PixelRect[] {
  const sorted = [...rects].sort((left, right) => left.y - right.y || left.x - right.x);
  const merged: PixelRect[] = [];
  for (const rect of sorted) {
    const existing = merged.find((candidate) => rectsTouchOrOverlap(candidate, rect));
    if (existing) {
      const x1 = Math.min(existing.x, rect.x);
      const y1 = Math.min(existing.y, rect.y);
      const x2 = Math.max(existing.x + existing.w, rect.x + rect.w);
      const y2 = Math.max(existing.y + existing.h, rect.y + rect.h);
      existing.x = x1;
      existing.y = y1;
      existing.w = x2 - x1;
      existing.h = y2 - y1;
    } else {
      merged.push({ ...rect });
    }
  }
  return merged;
}

function rectsTouchOrOverlap(left: PixelRect, right: PixelRect): boolean {
  return left.x <= right.x + right.w && left.x + left.w >= right.x && left.y <= right.y + right.h && left.y + left.h >= right.y;
}

function rectHasMask(mask: Uint8Array, pageWidth: number, rect: PixelRect): boolean {
  for (let y = rect.y; y < rect.y + rect.h; y += 1) {
    for (let x = rect.x; x < rect.x + rect.w; x += 1) {
      if (mask[y * pageWidth + x]) {
        return true;
      }
    }
  }
  return false;
}

function buildLamaInput(
  bitmap: Buffer,
  pageMask: Uint8Array,
  pageWidth: number,
  _pageHeight: number,
  rect: PixelRect
): { image: Float32Array; mask: Float32Array } {
  const pixelCount = LAMA_INPUT_SIZE * LAMA_INPUT_SIZE;
  const image = new Float32Array(pixelCount * 3);
  const mask = new Float32Array(pixelCount);

  for (let y = 0; y < LAMA_INPUT_SIZE; y += 1) {
    const sourceY = clamp(Math.floor(((y + 0.5) * rect.h) / LAMA_INPUT_SIZE), 0, rect.h - 1);
    for (let x = 0; x < LAMA_INPUT_SIZE; x += 1) {
      const sourceX = clamp(Math.floor(((x + 0.5) * rect.w) / LAMA_INPUT_SIZE), 0, rect.w - 1);
      const targetIndex = y * LAMA_INPUT_SIZE + x;
      const pageX = rect.x + sourceX;
      const pageY = rect.y + sourceY;
      const source = readRgb(bitmap, pageWidth, pageX, pageY);
      image[targetIndex] = source.r / 255;
      image[pixelCount + targetIndex] = source.g / 255;
      image[pixelCount * 2 + targetIndex] = source.b / 255;
      mask[targetIndex] = pageMask[pageY * pageWidth + pageX] ? 1 : 0;
    }
  }

  return { image, mask };
}

function compositeLamaOutput(
  bitmap: Buffer,
  pageMask: Uint8Array,
  pageWidth: number,
  rect: PixelRect,
  data: Float32Array | number[],
  dims: number[]
): void {
  const nchw = dims.length === 4 && dims[1] === 3;
  const nhwc = dims.length === 4 && dims[3] === 3;
  if (!nchw && !nhwc) {
    throw new Error(`지원하지 않는 LaMA 출력 형식입니다: ${dims.join("x")}`);
  }
  const minusOneToOne = outputLooksMinusOneToOne(data);
  const pixelCount = LAMA_INPUT_SIZE * LAMA_INPUT_SIZE;
  for (let y = 0; y < rect.h; y += 1) {
    for (let x = 0; x < rect.w; x += 1) {
      const pageX = rect.x + x;
      const pageY = rect.y + y;
      if (!pageMask[pageY * pageWidth + pageX]) {
        continue;
      }
      const outputX = clamp(Math.floor(((x + 0.5) * LAMA_INPUT_SIZE) / rect.w), 0, LAMA_INPUT_SIZE - 1);
      const outputY = clamp(Math.floor(((y + 0.5) * LAMA_INPUT_SIZE) / rect.h), 0, LAMA_INPUT_SIZE - 1);
      const sourceIndex = outputY * LAMA_INPUT_SIZE + outputX;
      const color = nchw
        ? {
            r: outputToByte(data[sourceIndex] ?? 0, minusOneToOne),
            g: outputToByte(data[pixelCount + sourceIndex] ?? 0, minusOneToOne),
            b: outputToByte(data[pixelCount * 2 + sourceIndex] ?? 0, minusOneToOne)
          }
        : {
            r: outputToByte(data[sourceIndex * 3] ?? 0, minusOneToOne),
            g: outputToByte(data[sourceIndex * 3 + 1] ?? 0, minusOneToOne),
            b: outputToByte(data[sourceIndex * 3 + 2] ?? 0, minusOneToOne)
          };
      writeRgb(bitmap, pageWidth, pageX, pageY, color);
    }
  }
}

function outputLooksMinusOneToOne(data: Float32Array | number[]): boolean {
  const sampleCount = Math.min(data.length, 512);
  for (let index = 0; index < sampleCount; index += 1) {
    if ((data[index] ?? 0) < -0.01) {
      return true;
    }
  }
  return false;
}

function outputToByte(value: number, minusOneToOne: boolean): number {
  if (minusOneToOne) {
    return clamp(Math.round((value + 1) * 127.5), 0, 255);
  }
  return clamp(Math.round(value <= 1.5 ? value * 255 : value), 0, 255);
}

function hasUsableBbox(bbox: BBox): boolean {
  return Number.isFinite(bbox.x) && Number.isFinite(bbox.y) && Number.isFinite(bbox.w) && Number.isFinite(bbox.h) && bbox.w > 0 && bbox.h > 0;
}

async function loadPageImage(filePath: string, decodeFallback?: ImageDecodeFallback): Promise<Electron.NativeImage> {
  const direct = nativeImage.createFromPath(filePath);
  if (!direct.isEmpty()) {
    return direct;
  }

  const fallbackBuffer = decodeFallback ? await decodeFallback(filePath) : null;
  if (fallbackBuffer?.length) {
    const fallback = nativeImage.createFromBuffer(fallbackBuffer);
    if (!fallback.isEmpty()) {
      return fallback;
    }
  }

  throw new Error("인페인팅할 이미지를 읽지 못했습니다.");
}

function bboxToPixelRect(bbox: BBox, page: MangaPage): PixelRect {
  const pixelBbox = bboxToPixels(bbox, page.width, page.height);
  const x1 = clamp(Math.floor(pixelBbox.x), 0, Math.max(0, page.width - 1));
  const y1 = clamp(Math.floor(pixelBbox.y), 0, Math.max(0, page.height - 1));
  const x2 = clamp(Math.ceil(pixelBbox.x + pixelBbox.w), x1 + 1, page.width);
  const y2 = clamp(Math.ceil(pixelBbox.y + pixelBbox.h), y1 + 1, page.height);
  return {
    x: x1,
    y: y1,
    w: Math.max(1, x2 - x1),
    h: Math.max(1, y2 - y1)
  };
}

function resolveBlockMarginPx(block: TranslationBlock, page: MangaPage): number {
  const rect = bboxToPixelRect(block.bbox, page);
  const byBox = Math.round(Math.max(rect.w, rect.h) * 0.08);
  const byFont = Math.round((block.fontSizePx || 18) * 0.22);
  return clamp(Math.max(3, byBox, byFont), 3, 18);
}

function resolveDilationRadius(block: TranslationBlock): number {
  return clamp(Math.round((block.fontSizePx || 18) / 9), 1, 5);
}

function expandRect(rect: PixelRect, imageWidth: number, imageHeight: number, margin: number): PixelRect {
  const x1 = clamp(rect.x - margin, 0, Math.max(0, imageWidth - 1));
  const y1 = clamp(rect.y - margin, 0, Math.max(0, imageHeight - 1));
  const x2 = clamp(rect.x + rect.w + margin, x1 + 1, imageWidth);
  const y2 = clamp(rect.y + rect.h + margin, y1 + 1, imageHeight);
  return {
    x: x1,
    y: y1,
    w: Math.max(1, x2 - x1),
    h: Math.max(1, y2 - y1)
  };
}

function estimateDominantBackgroundColor(bitmap: Buffer, width: number, height: number, rect: PixelRect): Rgb {
  const samples: Rgb[] = [];
  const step = Math.max(1, Math.floor(Math.max(rect.w, rect.h) / 110));

  for (let y = rect.y; y < rect.y + rect.h; y += step) {
    for (let x = rect.x; x < rect.x + rect.w; x += step) {
      samples.push(readRgb(bitmap, width, x, y));
    }
  }

  if (samples.length < 8) {
    const fallbackX = clamp(rect.x + Math.floor(rect.w / 2), 0, width - 1);
    const fallbackY = clamp(rect.y + Math.floor(rect.h / 2), 0, height - 1);
    return readRgb(bitmap, width, fallbackX, fallbackY);
  }

  const buckets = new Map<string, Rgb[]>();
  for (const sample of samples) {
    const key = `${Math.round(sample.r / 24)},${Math.round(sample.g / 24)},${Math.round(sample.b / 24)}`;
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.push(sample);
    } else {
      buckets.set(key, [sample]);
    }
  }

  const dominant = [...buckets.values()].sort((left, right) => right.length - left.length)[0] ?? samples;
  return {
    r: median(dominant.map((sample) => sample.r)),
    g: median(dominant.map((sample) => sample.g)),
    b: median(dominant.map((sample) => sample.b))
  };
}

function buildTextLikeMask(
  bitmap: Buffer,
  width: number,
  height: number,
  rect: PixelRect,
  dilationRadius: number
): { mask: Uint8Array; count: number } {
  const background = estimateDominantBackgroundColor(bitmap, width, height, rect);
  const mask = new Uint8Array(rect.w * rect.h);
  const threshold = resolveMaskThreshold(bitmap, width, rect, background);
  let initialCount = 0;
  const backgroundSamples: Rgb[] = [];

  for (let y = 0; y < rect.h; y += 1) {
    for (let x = 0; x < rect.w; x += 1) {
      const source = readRgb(bitmap, width, rect.x + x, rect.y + y);
      if (isTextLikePixel(source, background, threshold)) {
        mask[y * rect.w + x] = 1;
        initialCount += 1;
      } else if (colorDistance(source, background) <= Math.max(12, threshold * 0.65)) {
        backgroundSamples.push(source);
      }
    }
  }

  const coverage = initialCount / Math.max(1, rect.w * rect.h);
  if (initialCount === 0 || coverage > 0.68 || !looksLikeFlatBackground(backgroundSamples, background)) {
    return { mask: new Uint8Array(rect.w * rect.h), count: 0 };
  }

  const dilated = dilateMask(mask, rect.w, rect.h, dilationRadius);
  let count = 0;
  for (const value of dilated) {
    if (value) {
      count += 1;
    }
  }
  return { mask: dilated, count };
}

function looksLikeFlatBackground(samples: Rgb[], background: Rgb): boolean {
  if (samples.length < 12) {
    return true;
  }
  const std = colorStddev(samples, background);
  return Math.max(std.r, std.g, std.b) < 18;
}

function resolveMaskThreshold(bitmap: Buffer, width: number, rect: PixelRect, background: Rgb): number {
  const distances: number[] = [];
  const step = Math.max(1, Math.floor(Math.max(rect.w, rect.h) / 80));
  for (let y = rect.y; y < rect.y + rect.h; y += step) {
    for (let x = rect.x; x < rect.x + rect.w; x += step) {
      distances.push(colorDistance(readRgb(bitmap, width, x, y), background));
    }
  }
  const sorted = distances.sort((left, right) => left - right);
  const p35 = sorted[Math.floor(sorted.length * 0.35)] ?? 24;
  const p70 = sorted[Math.floor(sorted.length * 0.7)] ?? 42;
  return clamp(Math.max(24, p35 + (p70 - p35) * 0.45), 24, 74);
}

function isTextLikePixel(source: Rgb, background: Rgb, threshold: number): boolean {
  const distance = colorDistance(source, background);
  const luminanceDiff = Math.abs(luminance(source) - luminance(background));
  return distance >= threshold && luminanceDiff >= 16;
}

function dilateMask(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  if (radius <= 0) {
    return mask;
  }
  const output = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!mask[y * width + x]) {
        continue;
      }
      for (let dy = -radius; dy <= radius; dy += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          if (dx * dx + dy * dy > radius * radius) {
            continue;
          }
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
            output[ny * width + nx] = 1;
          }
        }
      }
    }
  }
  return output;
}

function readRgb(bitmap: Buffer, width: number, x: number, y: number): Rgb {
  const offset = (y * width + x) * 4;
  return {
    b: bitmap[offset] ?? 0,
    g: bitmap[offset + 1] ?? 0,
    r: bitmap[offset + 2] ?? 0
  };
}

function applyRetouchCircle(
  bitmap: Buffer,
  originalBitmap: Buffer,
  width: number,
  height: number,
  point: InpaintingPoint,
  radius: number,
  mode: "paint" | "restore",
  paintColor: Rgb | null
): void {
  const cx = clamp(Math.round(point.x), 0, Math.max(0, width - 1));
  const cy = clamp(Math.round(point.y), 0, Math.max(0, height - 1));
  const x1 = clamp(cx - radius, 0, Math.max(0, width - 1));
  const y1 = clamp(cy - radius, 0, Math.max(0, height - 1));
  const x2 = clamp(cx + radius, x1, Math.max(0, width - 1));
  const y2 = clamp(cy + radius, y1, Math.max(0, height - 1));
  for (let y = y1; y <= y2; y += 1) {
    for (let x = x1; x <= x2; x += 1) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy > radius * radius) {
        continue;
      }
      if (mode === "paint" && paintColor) {
        writeRgb(bitmap, width, x, y, paintColor);
      } else {
        copyPixel(originalBitmap, bitmap, width, x, y);
      }
    }
  }
}

function sanitizePoints(points: InpaintingPoint[], width: number, height: number): InpaintingPoint[] {
  return points
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    .map((point) => ({
      x: clamp(Math.round(point.x), 0, Math.max(0, width - 1)),
      y: clamp(Math.round(point.y), 0, Math.max(0, height - 1))
    }))
    .slice(0, 1200);
}

function interpolatePoints(from: InpaintingPoint, to: InpaintingPoint, step: number): InpaintingPoint[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.sqrt(dx * dx + dy * dy);
  const count = Math.max(1, Math.ceil(distance / Math.max(1, step)));
  const points: InpaintingPoint[] = [];
  for (let index = 0; index <= count; index += 1) {
    const ratio = index / count;
    points.push({
      x: from.x + dx * ratio,
      y: from.y + dy * ratio
    });
  }
  return points;
}

function parseHexColor(value?: string): Rgb {
  const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(value ?? "");
  if (!match) {
    return { r: 255, g: 255, b: 255 };
  }
  return {
    r: Number.parseInt(match[1], 16),
    g: Number.parseInt(match[2], 16),
    b: Number.parseInt(match[3], 16)
  };
}

function rgbToHex(color: Rgb): string {
  return `#${toHex(color.r)}${toHex(color.g)}${toHex(color.b)}`;
}

function toHex(value: number): string {
  return clamp(Math.round(value), 0, 255).toString(16).padStart(2, "0");
}

function colorStddev(samples: Rgb[], center: Rgb): Rgb {
  const sum = samples.reduce(
    (acc, sample) => ({
      r: acc.r + (sample.r - center.r) ** 2,
      g: acc.g + (sample.g - center.g) ** 2,
      b: acc.b + (sample.b - center.b) ** 2
    }),
    { r: 0, g: 0, b: 0 }
  );
  const count = Math.max(1, samples.length);
  return {
    r: Math.sqrt(sum.r / count),
    g: Math.sqrt(sum.g / count),
    b: Math.sqrt(sum.b / count)
  };
}

function writeRgb(bitmap: Buffer, width: number, x: number, y: number, color: Rgb): void {
  const offset = (y * width + x) * 4;
  bitmap[offset] = color.b;
  bitmap[offset + 1] = color.g;
  bitmap[offset + 2] = color.r;
  bitmap[offset + 3] = 255;
}

function copyPixel(source: Buffer, target: Buffer, width: number, x: number, y: number): void {
  const offset = (y * width + x) * 4;
  target[offset] = source[offset] ?? 0;
  target[offset + 1] = source[offset + 1] ?? 0;
  target[offset + 2] = source[offset + 2] ?? 0;
  target[offset + 3] = source[offset + 3] ?? 255;
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return Math.round(sorted[Math.floor(sorted.length / 2)] ?? 0);
}

function colorDistance(left: Rgb, right: Rgb): number {
  const dr = left.r - right.r;
  const dg = left.g - right.g;
  const db = left.b - right.b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function luminance(color: Rgb): number {
  return color.r * 0.299 + color.g * 0.587 + color.b * 0.114;
}

function resolveInpaintedImagePath(imagePath: string, suffix = "solid"): string {
  const imageDir = dirname(imagePath);
  const chapterDir = dirname(imageDir);
  const name = basename(imagePath, extname(imagePath));
  const safeSuffix = suffix.replace(/[^a-z0-9_-]/gi, "-");
  return join(chapterDir, "inpainted", `${name}-${safeSuffix}.png`);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
}
