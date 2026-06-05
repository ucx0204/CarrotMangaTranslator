const { spawn } = require("node:child_process");
const { mkdir, readFile, writeFile } = require("node:fs/promises");
const path = require("node:path");

const { buildUtilityChildEnv } = require("./simple-page-child-env.cjs");
const { resolveWorkingDir } = require("./simple-page-cache-paths.cjs");
const { resolveFfmpegPath } = require("./simple-page-runtime-paths.cjs");
const { isOpenAICodexProvider } = require("./simple-page-model-config.cjs");
const { readPositiveInteger } = require("./simple-page-prompts.cjs");
const {
  calculateOpenAIOriginalDetailSize,
  enhanceBitmapBuffer,
  getScaledSize,
  mimeFromPath
} = require("./simple-page-image-utils.cjs");
const { shrinkBuffer } = require("./simple-page-shell-utils.cjs");
const {
  createDetailedError,
  truncateText
} = require("./simple-page-runtime-common.cjs");

function buildEnhancedVariantFailureDetail(error, options = {}) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      imagePath: options.imagePath,
      format: path.extname(options.imagePath || "").toLowerCase() || null,
      reason: "enhanced-variant-unavailable",
      cause: error.cause
    };
  }

  return {
    name: "Error",
    message: String(error),
    imagePath: options.imagePath,
    format: path.extname(options.imagePath || "").toLowerCase() || null,
    reason: "enhanced-variant-unavailable"
  };
}

function resolveElectronNativeImage() {
  try {
    const electronModule = require("electron");
    if (
      electronModule &&
      typeof electronModule === "object" &&
      electronModule.nativeImage &&
      typeof electronModule.nativeImage.createFromPath === "function"
    ) {
      return electronModule.nativeImage;
    }
  } catch {
    // Ignore node-only contexts and fall back to the PowerShell pipeline.
  }

  return null;
}

async function convertImageToPngBufferWithFfmpeg(filePath, options = {}) {
  const ffmpegPath = resolveFfmpegPath(options);
  return new Promise((resolve, reject) => {
    const stdoutChunks = [];
    const stderrChunks = [];
    const child = spawn(
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
        "pipe:1"
      ],
      {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: buildUtilityChildEnv(options, [path.dirname(ffmpegPath)])
      }
    );

    child.stdout.on("data", (chunk) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    child.stderr.on("data", (chunk) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    child.on("error", (error) => {
      reject(
        createDetailedError(
          "ffmpeg failed to start for image conversion.",
          {
            filePath,
            targetMime: "image/png",
            command: ffmpegPath
          },
          error
        )
      );
    });

    child.on("close", (code) => {
      const output = Buffer.concat(stdoutChunks);
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();

      if (code !== 0) {
        reject(
          createDetailedError("ffmpeg image conversion failed.", {
            filePath,
            targetMime: "image/png",
            command: ffmpegPath,
            exitCode: code,
            stderr
          })
        );
        return;
      }

      if (!output.length) {
        reject(
          createDetailedError("ffmpeg image conversion produced no output.", {
            filePath,
            targetMime: "image/png",
            command: ffmpegPath,
            exitCode: code,
            stderr
          })
        );
        return;
      }

      resolve(output);
    });
  });
}

async function fileToModelAsset(filePath, options = {}) {
  const sourceMime = mimeFromPath(filePath);

  if (sourceMime === "image/webp") {
    const convertedBuffer = await convertImageToPngBufferWithFfmpeg(filePath, options);
    return {
      mime: "image/png",
      convertedFromMime: sourceMime,
      dataUrl: `data:image/png;base64,${convertedBuffer.toString("base64")}`
    };
  }

  const buffer = await readFile(filePath);
  return {
    mime: sourceMime,
    convertedFromMime: null,
    dataUrl: `data:${sourceMime};base64,${buffer.toString("base64")}`
  };
}

async function buildEnhancedVariant(options) {
  const nativeImage = resolveElectronNativeImage();
  let electronError = null;

  if (nativeImage) {
    try {
      return await buildEnhancedVariantWithElectron(options, nativeImage);
    } catch (error) {
      electronError = error;
    }
  }

  try {
    return await buildEnhancedVariantWithPowerShell(options);
  } catch (error) {
    if (!electronError) {
      throw error;
    }

    throw createDetailedError(
      "Enhanced variant generation failed in both Electron and PowerShell pipelines.",
      {
        imagePath: options.imagePath,
        outputDir: options.outputDir,
        electronError
      },
      error
    );
  }
}

function resolveImageSize(options = {}) {
  const configuredWidth = readPositiveInteger(options.imageWidth);
  const configuredHeight = readPositiveInteger(options.imageHeight);
  if (configuredWidth && configuredHeight) {
    return { width: configuredWidth, height: configuredHeight };
  }

  const nativeImage = resolveElectronNativeImage();
  if (!nativeImage || !options.imagePath) {
    return { width: 0, height: 0 };
  }

  const image = nativeImage.createFromPath(options.imagePath);
  const size = image?.getSize?.() || { width: 0, height: 0 };
  return {
    width: readPositiveInteger(size.width) || 0,
    height: readPositiveInteger(size.height) || 0
  };
}

async function buildOpenAIVisionVariant(options) {
  const sourceSize = resolveImageSize(options);
  const targetSize = calculateOpenAIOriginalDetailSize(sourceSize.width, sourceSize.height);
  const base = {
    role: "openai-vision",
    originalWidth: sourceSize.width,
    originalHeight: sourceSize.height,
    width: targetSize.width || sourceSize.width,
    height: targetSize.height || sourceSize.height
  };

  if (!sourceSize.width || !sourceSize.height || !targetSize.width || !targetSize.height) {
    return { ...base, role: "original", path: options.imagePath, width: sourceSize.width, height: sourceSize.height };
  }

  if (targetSize.width === sourceSize.width && targetSize.height === sourceSize.height) {
    return { ...base, path: options.imagePath };
  }

  const nativeImage = resolveElectronNativeImage();
  if (!nativeImage) {
    return { ...base, role: "original", path: options.imagePath, width: sourceSize.width, height: sourceSize.height };
  }

  const image = nativeImage.createFromPath(options.imagePath);
  if (!image || image.isEmpty()) {
    return { ...base, role: "original", path: options.imagePath, width: sourceSize.width, height: sourceSize.height };
  }

  const outputPath = path.join(options.outputDir, "input-openai-vision.png");
  const resized = image.resize({
    width: targetSize.width,
    height: targetSize.height,
    quality: "best"
  });
  await mkdir(options.outputDir, { recursive: true });
  await writeFile(outputPath, resized.toPNG());
  return { ...base, path: outputPath };
}

async function buildEnhancedVariantWithElectron(options, nativeImage) {
  const outputPath = path.join(options.outputDir, "input-enhanced.png");
  const image = nativeImage.createFromPath(options.imagePath);
  if (!image || image.isEmpty()) {
    throw createDetailedError("Electron nativeImage could not decode the source image.", {
      imagePath: options.imagePath,
      outputPath,
      format: path.extname(options.imagePath).toLowerCase()
    });
  }

  const sourceSize = image.getSize();
  if (!sourceSize.width || !sourceSize.height) {
    throw createDetailedError("Electron nativeImage returned an empty size for the source image.", {
      imagePath: options.imagePath,
      outputPath,
      format: path.extname(options.imagePath).toLowerCase(),
      sourceSize
    });
  }

  const scaled = getScaledSize(sourceSize.width, sourceSize.height, options.enhancedMaxLongSide);
  const resized =
    scaled.width === sourceSize.width && scaled.height === sourceSize.height
      ? image
      : image.resize({
          width: scaled.width,
          height: scaled.height,
          quality: "best"
        });

  if (!resized || resized.isEmpty()) {
    throw createDetailedError("Electron nativeImage resize returned an empty image.", {
      imagePath: options.imagePath,
      outputPath,
      format: path.extname(options.imagePath).toLowerCase(),
      sourceSize,
      scaled
    });
  }

  const bitmap = resized.toBitmap();
  if (!bitmap || bitmap.length === 0) {
    throw createDetailedError("Electron nativeImage returned an empty bitmap buffer.", {
      imagePath: options.imagePath,
      outputPath,
      format: path.extname(options.imagePath).toLowerCase(),
      sourceSize,
      scaled
    });
  }

  const enhancedBitmap = enhanceBitmapBuffer(bitmap, options.enhancedContrast, true);
  const enhancedImage = nativeImage.createFromBitmap(enhancedBitmap, {
    width: scaled.width,
    height: scaled.height
  });
  if (!enhancedImage || enhancedImage.isEmpty()) {
    throw createDetailedError("Electron nativeImage could not create the enhanced bitmap.", {
      imagePath: options.imagePath,
      outputPath,
      format: path.extname(options.imagePath).toLowerCase(),
      sourceSize,
      scaled
    });
  }

  await mkdir(options.outputDir, { recursive: true });
  await writeFile(outputPath, enhancedImage.toPNG());
  return outputPath;
}

async function buildEnhancedVariantWithPowerShell(options) {
  const outputPath = path.join(options.outputDir, "input-enhanced.png");
  const scriptPath = path.join(__dirname, "build-page-variant.ps1");
  const args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
    "-Path",
    options.imagePath,
    "-OutputPath",
    outputPath,
    "-MaxLongSide",
    String(options.enhancedMaxLongSide),
    "-Contrast",
    String(options.enhancedContrast),
    "-Grayscale"
  ];

  await new Promise((resolve, reject) => {
    const child = spawn("powershell", args, {
      cwd: resolveWorkingDir(options),
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      env: buildUtilityChildEnv(options)
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout = shrinkBuffer(stdout, chunk, 4000);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = shrinkBuffer(stderr, chunk, 4000);
    });
    child.on("error", (error) => {
      reject(
        createDetailedError(
          "Failed to launch build-page-variant.ps1.",
          {
            scriptPath,
            imagePath: options.imagePath,
            outputPath,
            stdout: truncateText(stdout, 4000),
            stderr: truncateText(stderr, 4000),
            parameters: {
              maxLongSide: options.enhancedMaxLongSide,
              contrast: options.enhancedContrast,
              grayscale: true
            }
          },
          error
        )
      );
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        createDetailedError(`build-page-variant.ps1 failed (${code ?? "null"}).`, {
          scriptPath,
          imagePath: options.imagePath,
          outputPath,
          stdout: truncateText(stdout.trim(), 4000),
          stderr: truncateText(stderr.trim(), 4000),
          parameters: {
            maxLongSide: options.enhancedMaxLongSide,
            contrast: options.enhancedContrast,
            grayscale: true
          }
        })
      );
    });
  });

  return outputPath;
}

async function prepareImageVariants(options) {
  const sourceSize = resolveImageSize(options);
  const variants = isOpenAICodexProvider(options)
    ? [await buildOpenAIVisionVariant({ ...options, imageWidth: sourceSize.width, imageHeight: sourceSize.height })]
    : [{ role: "original", path: options.imagePath, width: sourceSize.width, height: sourceSize.height }];
  let diagnostics = [];
  if (options.includeEnhancedVariant) {
    try {
      variants.push({ role: "enhanced", path: await buildEnhancedVariant(options), originalWidth: sourceSize.width, originalHeight: sourceSize.height });
    } catch (error) {
      diagnostics = [buildEnhancedVariantFailureDetail(error, options)];
      process.stderr.write(
        `[runtime:${options.label}:warn] enhanced variant unavailable; continuing with original image only (${diagnostics[0].message})\n`
      );
    }
  }

  return {
    imageVariants: await Promise.all(
      variants.map(async (variant) => ({
        ...variant,
        ...(await fileToModelAsset(variant.path, options))
      }))
    ),
    diagnostics
  };
}

module.exports = {
  buildEnhancedVariant,
  buildEnhancedVariantFailureDetail,
  buildEnhancedVariantWithElectron,
  buildEnhancedVariantWithPowerShell,
  buildOpenAIVisionVariant,
  convertImageToPngBufferWithFfmpeg,
  fileToModelAsset,
  prepareImageVariants,
  resolveElectronNativeImage,
  resolveImageSize
};
