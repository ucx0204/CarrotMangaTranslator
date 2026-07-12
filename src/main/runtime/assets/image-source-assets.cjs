// @ts-check
const { spawn } = require("node:child_process");
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const { buildUtilityChildEnv } = require("../simple-page-child-env.cjs");
const { resolveFfmpegPath } = require("../simple-page-runtime-paths.cjs");
const { readPositiveInteger } = require("../simple-page-prompts.cjs");
const { mimeFromPath } = require("../simple-page-image-utils.cjs");
const { createDetailedError } = require("../simple-page-runtime-common.cjs");

/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions & { imageHeight?: unknown; imagePath: string; imageWidth?: unknown }} ImageVariantOptions */
/** @typedef {{ width: number; height: number }} ImageSize */
/** @typedef {{ isEmpty(): boolean; getSize(): ImageSize; resize(options: { width: number; height: number; quality?: "good" | "better" | "best" }): NativeImageInstance; toBitmap(): Buffer; toPNG(): Buffer }} NativeImageInstance */
/** @typedef {{ createFromPath(filePath: string): NativeImageInstance; createFromBitmap(buffer: Buffer, size: ImageSize): NativeImageInstance }} NativeImageModule */

/** @returns {NativeImageModule | null} */
function resolveElectronNativeImage() {
  try {
    const electronModule = require("electron");
    const nativeImage =
      electronModule && typeof electronModule === "object"
        ? electronModule.nativeImage
        : null;
    return nativeImage && typeof nativeImage.createFromPath === "function"
      ? /** @type {NativeImageModule} */ (nativeImage)
      : null;
  } catch (_error) {
    // error-policy-allow: node-only contexts use the PowerShell image pipeline.
    return null;
  }
}

/** @param {string} filePath @param {ImageVariantOptions} options @returns {Promise<Buffer>} */
function convertImageToPngBufferWithFfmpeg(filePath, options) {
  return new Promise((resolve, reject) => {
    const ffmpegPath = resolveFfmpegPath(options);
    const state = {
      stdoutChunks: /** @type {Buffer[]} */ ([]),
      stderrChunks: /** @type {Buffer[]} */ ([]),
    };
    const child = spawnFfmpeg(ffmpegPath, filePath, options);
    child.stdout.on("data", (chunk) =>
      state.stdoutChunks.push(toBuffer(chunk)),
    );
    child.stderr.on("data", (chunk) =>
      state.stderrChunks.push(toBuffer(chunk)),
    );
    child.on("error", (error) =>
      reject(buildFfmpegStartError(filePath, ffmpegPath, error)),
    );
    child.on("close", (code) =>
      finishFfmpegConversion(
        filePath,
        ffmpegPath,
        state,
        code,
        resolve,
        reject,
      ),
    );
  });
}

/** @param {string} ffmpegPath @param {string} filePath @param {ImageVariantOptions} options */
function spawnFfmpeg(ffmpegPath, filePath, options) {
  return spawn(
    ffmpegPath,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-i",
      filePath,
      "-frames:v",
      "1",
      "-f",
      "image2pipe",
      "-vcodec",
      "png",
      "pipe:1",
    ],
    {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: buildUtilityChildEnv(options, [path.dirname(ffmpegPath)]),
    },
  );
}

/** @param {unknown} chunk */
function toBuffer(chunk) {
  return Buffer.isBuffer(chunk)
    ? chunk
    : Buffer.from(/** @type {string | Uint8Array} */ (chunk));
}

/** @param {string} filePath @param {string} command @param {unknown} cause */
function buildFfmpegStartError(filePath, command, cause) {
  return createDetailedError(
    "ffmpeg failed to start for image conversion.",
    {
      filePath,
      targetMime: "image/png",
      command,
    },
    cause,
  );
}

/** @param {string} filePath @param {string} command @param {{ stdoutChunks: Buffer[]; stderrChunks: Buffer[] }} state @param {number | null} code @param {(buffer: Buffer) => void} resolve @param {(error: unknown) => void} reject */
function finishFfmpegConversion(
  filePath,
  command,
  state,
  code,
  resolve,
  reject,
) {
  const output = Buffer.concat(state.stdoutChunks);
  const detail = {
    filePath,
    targetMime: "image/png",
    command,
    exitCode: code,
    stderr: Buffer.concat(state.stderrChunks).toString("utf8").trim(),
  };
  if (code !== 0) {
    reject(createDetailedError("ffmpeg image conversion failed.", detail));
    return;
  }
  if (!output.length) {
    reject(
      createDetailedError(
        "ffmpeg image conversion produced no output.",
        detail,
      ),
    );
    return;
  }
  resolve(output);
}

/** @param {string} filePath @param {ImageVariantOptions} options */
async function fileToModelAsset(filePath, options) {
  const sourceMime = mimeFromPath(filePath);
  if (sourceMime === "image/webp") {
    const buffer = await convertImageToPngBufferWithFfmpeg(filePath, options);
    return {
      mime: "image/png",
      convertedFromMime: sourceMime,
      dataUrl: `data:image/png;base64,${buffer.toString("base64")}`,
    };
  }
  const buffer = await readFile(filePath);
  return {
    mime: sourceMime,
    convertedFromMime: null,
    dataUrl: `data:${sourceMime};base64,${buffer.toString("base64")}`,
  };
}

/** @param {Partial<ImageVariantOptions>} [options] @returns {ImageSize} */
function resolveImageSize(options = {}) {
  const configuredWidth = readPositiveInteger(options.imageWidth);
  const configuredHeight = readPositiveInteger(options.imageHeight);
  if (configuredWidth && configuredHeight)
    return { width: configuredWidth, height: configuredHeight };
  const nativeImage = resolveElectronNativeImage();
  if (!nativeImage || !options.imagePath) return { width: 0, height: 0 };
  const size = nativeImage.createFromPath(options.imagePath)?.getSize?.() || {
    width: 0,
    height: 0,
  };
  return {
    width: readPositiveInteger(size.width) || 0,
    height: readPositiveInteger(size.height) || 0,
  };
}

module.exports = {
  convertImageToPngBufferWithFfmpeg,
  fileToModelAsset,
  resolveElectronNativeImage,
  resolveImageSize,
};
