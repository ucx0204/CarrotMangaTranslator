// @ts-check
/** @typedef {import("./prompt-types").PromptOptions} PromptOptions */
/** @typedef {import("./prompt-types").ImageVariant} ImageVariant */
/** @typedef {import("./prompt-types").PromptSection} PromptSection */
/** @typedef {import("./prompt-types").PromptBox} PromptBox */
/** @typedef {import("./prompt-types").PromptCoordinateFrame} PromptCoordinateFrame */

const { readPositiveInteger } = require("./common.cjs");
const { isOpenAICodexProvider } = require("./model-profile.cjs");

/**
 * @param {PromptOptions} [options]
 * @param {ImageVariant[]} [imageVariants]
 * @returns {PromptSection}
 */
function buildCoordinateCalibrationSection(options = {}, imageVariants = []) {
  const originalWidth = readPositiveInteger(options.imageWidth);
  const originalHeight = readPositiveInteger(options.imageHeight);
  if (!originalWidth || !originalHeight) {
    return [];
  }

  const geometryVariant = selectGeometryVariant(imageVariants);
  const sentWidth = readPositiveInteger(geometryVariant?.width);
  const sentHeight = readPositiveInteger(geometryVariant?.height);
  const coordinateFrame = resolvePromptCoordinateFrame(options, imageVariants);
  const lines = [
    "Coordinate calibration",
    `The original page is ${originalWidth}x${originalHeight} px.`,
  ];

  if (coordinateFrame.space === "pixels") {
    return [...lines, ...buildPixelCalibrationLines(coordinateFrame)];
  }

  lines.push(...NORMALIZED_CALIBRATION_LINES);
  if (isPrescaled(sentWidth, sentHeight, originalWidth, originalHeight)) {
    lines.push(
      `For OpenAI vision, Image 1 was pre-scaled to ${sentWidth}x${sentHeight} px for detail: original before sending so the coordinate frame matches what the model sees.`,
      `If measuring in sent pixels, convert directly with x1 = round(left * 1000 / ${sentWidth}), y1 = round(top * 1000 / ${sentHeight}), x2 = round(right * 1000 / ${sentWidth}), y2 = round(bottom * 1000 / ${sentHeight}).`,
    );
  }

  return lines;
}

const NORMALIZED_CALIBRATION_LINES = [
  "Return x1, y1, x2, y2 as normalized 0..1000 corner coordinates over Image 1, not viewport, crop, tile, or model-internal coordinates.",
  "Use the full visible Image 1 frame as the coordinate frame: left edge 0, top edge 0, right edge 1000, bottom edge 1000.",
  "Because Image 1 preserves the original aspect ratio, these normalized coordinates map directly back to the original page.",
];

/** @param {ImageVariant[]} imageVariants @returns {ImageVariant | undefined} */
function selectGeometryVariant(imageVariants) {
  return (
    imageVariants.find((variant) => variant.role === "openai-vision") ||
    imageVariants[0]
  );
}

/**
 * @param {PromptCoordinateFrame} frame
 * @returns {string[]}
 */
function buildPixelCalibrationLines(frame) {
  return [
    `Image 1 was prepared before the API call to match the OpenAI detail: original vision frame, so the model sees Image 1 as ${frame.frame.width}x${frame.frame.height} px.`,
    `Return x1, y1, x2, y2 as integer pixel coordinates in that ${frame.frame.width}x${frame.frame.height} Image 1 frame.`,
    "Do not return width/height, original-page pixels, normalized 0..1000 coordinates, viewport coordinates, crop coordinates, tile coordinates, or model-internal coordinates.",
    `Use the full visible Image 1 frame as the coordinate frame: left edge 0, top edge 0, right edge ${frame.frame.width}, bottom edge ${frame.frame.height}.`,
    "The app will map these sent-image pixels back to the original page after the model response.",
  ];
}

/**
 * @param {number | null} sentWidth
 * @param {number | null} sentHeight
 * @param {number} originalWidth
 * @param {number} originalHeight
 * @returns {boolean}
 */
function isPrescaled(sentWidth, sentHeight, originalWidth, originalHeight) {
  if (!sentWidth || !sentHeight) {
    return false;
  }
  return sentWidth !== originalWidth || sentHeight !== originalHeight;
}

/**
 * @param {PromptBox} box
 * @param {PromptCoordinateFrame} frame
 * @param {number | null} originalWidth
 * @param {number | null} originalHeight
 * @returns {PromptBox}
 */
function convertOriginalPixelBoxToPromptFrame(
  box,
  frame,
  originalWidth,
  originalHeight,
) {
  if (frame.space === "pixels" && originalWidth && originalHeight) {
    const xScale = frame.frame.width / originalWidth;
    const yScale = frame.frame.height / originalHeight;
    return {
      x1: Math.round(Math.min(box.x1, box.x2) * xScale),
      y1: Math.round(Math.min(box.y1, box.y2) * yScale),
      x2: Math.round(Math.max(box.x1, box.x2) * xScale),
      y2: Math.round(Math.max(box.y1, box.y2) * yScale),
    };
  }

  if (originalWidth && originalHeight) {
    return {
      x1: Math.round((Math.min(box.x1, box.x2) / originalWidth) * 1000),
      y1: Math.round((Math.min(box.y1, box.y2) / originalHeight) * 1000),
      x2: Math.round((Math.max(box.x1, box.x2) / originalWidth) * 1000),
      y2: Math.round((Math.max(box.y1, box.y2) / originalHeight) * 1000),
    };
  }

  return {
    x1: Math.round(Math.min(box.x1, box.x2)),
    y1: Math.round(Math.min(box.y1, box.y2)),
    x2: Math.round(Math.max(box.x1, box.x2)),
    y2: Math.round(Math.max(box.y1, box.y2)),
  };
}

/**
 * @param {PromptOptions} [options]
 * @param {ImageVariant[]} [imageVariants]
 * @returns {PromptCoordinateFrame}
 */
function resolvePromptCoordinateFrame(options = {}, imageVariants = []) {
  if (isOpenAICodexProvider(options)) {
    const geometryVariant =
      imageVariants.find((variant) => variant.role === "openai-vision") ||
      imageVariants[0];
    const width =
      readPositiveInteger(geometryVariant?.width) ||
      readPositiveInteger(options.imageWidth) ||
      1000;
    const height =
      readPositiveInteger(geometryVariant?.height) ||
      readPositiveInteger(options.imageHeight) ||
      1000;
    return {
      space: "pixels",
      frame: { width, height },
    };
  }

  return {
    space: "normalized_1000",
    frame: { width: 1000, height: 1000 },
  };
}

module.exports = {
  buildCoordinateCalibrationSection,
  convertOriginalPixelBoxToPromptFrame,
  resolvePromptCoordinateFrame,
};
