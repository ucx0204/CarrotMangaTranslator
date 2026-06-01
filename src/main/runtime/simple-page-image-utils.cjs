function getScaledSize(width, height, maxLongSide) {
  const longSide = Math.max(width, height);
  if (longSide <= 0 || longSide <= maxLongSide) {
    return { width, height };
  }

  const scale = maxLongSide / longSide;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  };
}

function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function enhanceBitmapBuffer(bitmap, contrast = 1, grayscale = false) {
  const output = Buffer.from(bitmap);
  const translation = ((1 - contrast) / 2) * 255;

  for (let offset = 0; offset < output.length; offset += 4) {
    const blue = output[offset];
    const green = output[offset + 1];
    const red = output[offset + 2];

    if (grayscale) {
      const luminance = red * 0.299 + green * 0.587 + blue * 0.114;
      const adjusted = clampByte(luminance * contrast + translation);
      output[offset] = adjusted;
      output[offset + 1] = adjusted;
      output[offset + 2] = adjusted;
      continue;
    }

    output[offset] = clampByte(blue * contrast + translation);
    output[offset + 1] = clampByte(green * contrast + translation);
    output[offset + 2] = clampByte(red * contrast + translation);
  }

  return output;
}

function mimeFromPath(filePath) {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  return "image/png";
}

const OPENAI_ORIGINAL_DETAIL_PATCH_SIZE = 32;
const OPENAI_ORIGINAL_DETAIL_PATCH_BUDGET = 10000;
const OPENAI_ORIGINAL_DETAIL_MAX_DIMENSION = 6000;

function calculateOpenAIOriginalDetailSize(width, height) {
  if (!width || !height) {
    return { width, height };
  }

  const patchCount = (imageWidth, imageHeight) =>
    Math.ceil(imageWidth / OPENAI_ORIGINAL_DETAIL_PATCH_SIZE) * Math.ceil(imageHeight / OPENAI_ORIGINAL_DETAIL_PATCH_SIZE);

  const maxDimensionScale = Math.min(
    1,
    OPENAI_ORIGINAL_DETAIL_MAX_DIMENSION / width,
    OPENAI_ORIGINAL_DETAIL_MAX_DIMENSION / height
  );
  const patchBudgetScale = Math.sqrt(
    (OPENAI_ORIGINAL_DETAIL_PATCH_BUDGET * OPENAI_ORIGINAL_DETAIL_PATCH_SIZE * OPENAI_ORIGINAL_DETAIL_PATCH_SIZE) /
      (width * height)
  );
  let scale = Math.min(maxDimensionScale, patchBudgetScale, 1);
  let targetWidth = Math.max(1, Math.floor(width * scale));
  let targetHeight = Math.max(1, Math.floor(height * scale));

  while (
    targetWidth > OPENAI_ORIGINAL_DETAIL_MAX_DIMENSION ||
    targetHeight > OPENAI_ORIGINAL_DETAIL_MAX_DIMENSION ||
    patchCount(targetWidth, targetHeight) > OPENAI_ORIGINAL_DETAIL_PATCH_BUDGET
  ) {
    scale *= 0.999;
    targetWidth = Math.max(1, Math.floor(width * scale));
    targetHeight = Math.max(1, Math.floor(height * scale));
  }

  return {
    width: targetWidth,
    height: targetHeight
  };
}

module.exports = {
  calculateOpenAIOriginalDetailSize,
  enhanceBitmapBuffer,
  getScaledSize,
  mimeFromPath
};
