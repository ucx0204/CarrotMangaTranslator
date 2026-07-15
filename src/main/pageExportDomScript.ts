/* eslint-disable max-lines -- this is one self-contained browser script injected into the sandboxed export page */
/**
 * Browser-side DOM renderer injected into the offscreen PNG export window.
 * It mirrors the editor overlay DOM/CSS and lets Chromium capture the composed
 * page, avoiding a second canvas text-layout implementation for final output.
 */
export const PAGE_EXPORT_DOM_SCRIPT = `
const MIN_FONT_SIZE = 10;
const MAX_AUTOFIT_FONT_SIZE = 256;
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const CURVE_EPSILON = 0.000001;
const measureCanvas = document.createElement("canvas");
const context = measureCanvas.getContext("2d");

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function buildFont(size, family, weight, italic) {
  return (italic ? "italic " : "") + (weight || 400) + " " + size + "px " + family;
}

function fontWidthScaleFor(block) {
  const value = Number(block.fontWidthScale);
  if (!Number.isFinite(value)) return 1;
  return Math.min(1.5, Math.max(0.5, value));
}

function letterSpacingPxFor(block, fontSize) {
  const em = Number(block.letterSpacing);
  if (!em || !Number.isFinite(em)) return 0;
  return em * fontSize;
}

function styledRuns(block) {
  const runs = block.runs && block.runs.length
    ? block.runs
    : [{ text: block.text, bold: block.bold, italic: block.italic }];
  return runs.map(function (run) {
    const text = run && run.text != null ? String(run.text) : "";
    return {
      text: text,
      bold: !!(run && run.bold),
      italic: !!(run && run.italic)
    };
  });
}

function measureStyledWrappedText(runs, maxWidth, lineHeightPx, fontSize, fontFamily, letterSpacingPx) {
  const lines = [];
  let lineRuns = [];
  let lineCount = 0;
  let lineWidth = 0;
  let maxLineWidth = 0;
  let lineHasContent = false;

  const breakLine = function () {
    lines.push({ runs: lineRuns, width: lineWidth });
    maxLineWidth = Math.max(maxLineWidth, lineWidth);
    lineCount += 1;
    lineRuns = [];
    lineWidth = 0;
    lineHasContent = false;
  };

  const appendChar = function (char, bold, italic) {
    const lastRun = lineRuns[lineRuns.length - 1];
    if (lastRun && lastRun.bold === bold && lastRun.italic === italic) {
      lastRun.text += char;
      return;
    }
    lineRuns.push({ text: char, bold: bold, italic: italic });
  };

  for (const run of runs) {
    context.font = graphemeFont(run, fontSize, fontFamily);
    for (const char of Array.from(run.text)) {
      if (char === "\\n") {
        breakLine();
        continue;
      }
      const charWidth = context.measureText(char).width;
      const advance = charWidth + (lineHasContent ? letterSpacingPx : 0);
      if (lineHasContent && lineWidth + advance > maxWidth) {
        breakLine();
        appendChar(char, run.bold, run.italic);
        lineWidth = charWidth;
      } else {
        appendChar(char, run.bold, run.italic);
        lineWidth += advance;
      }
      lineHasContent = true;
    }
  }
  breakLine();

  return {
    lines: lines,
    lineCount: lineCount,
    totalHeight: lineCount * lineHeightPx,
    maxLineWidth: maxLineWidth
  };
}

function resolveFixedHorizontalTextLines(block, fontSize, contentWidth) {
  if (!block.text.trim() || block.renderDirection === "vertical") {
    return null;
  }
  return measureStyledWrappedText(
    styledRuns(block),
    contentWidth,
    fontSize * block.lineHeight,
    fontSize,
    block.fontFamily,
    letterSpacingPxFor(block, fontSize)
  ).lines;
}

function graphemeFont(g, fontSize, fontFamily) {
  return buildFont(fontSize, fontFamily, g.bold ? 800 : 400, g.italic);
}

function measureHorizontal(block, fontSize, innerWidth) {
  const measured = measureStyledWrappedText(
    styledRuns(block),
    innerWidth,
    fontSize * block.lineHeight,
    fontSize,
    block.fontFamily,
    letterSpacingPxFor(block, fontSize)
  );
  return {
    totalHeight: measured.totalHeight,
    maxLineWidth: measured.maxLineWidth
  };
}

function fits(block, fontSize, innerWidth, innerHeight) {
  const scaleX = fontWidthScaleFor(block);
  if (block.renderDirection === "vertical") {
    if (!block.text.trim()) return true;
    const verticalSlots = Array.from(block.text.replace(/\\r/g, "").replace(/\\n/g, " "));
    const verticalAdvance = fontSize * block.lineHeight + letterSpacingPxFor(block, fontSize);
    const charsPerColumn = Math.max(1, Math.floor(innerHeight / Math.max(fontSize, verticalAdvance)));
    const columnCount = Math.max(1, Math.ceil(verticalSlots.length / charsPerColumn));
    return columnCount <= 2 && columnCount * fontSize * 1.15 * scaleX <= innerWidth;
  }
  const effectiveWidth = innerWidth / scaleX;
  const measured = measureHorizontal(block, fontSize, effectiveWidth);
  return measured.totalHeight <= innerHeight && measured.maxLineWidth <= effectiveWidth;
}

function resolveFontSize(block, innerWidth, innerHeight) {
  const preferred = Math.max(MIN_FONT_SIZE, Math.floor(block.fontSizePx));
  if (!block.autoFitText || !block.text.trim()) {
    return preferred;
  }
  const heightBound = Math.floor(innerHeight / Math.max(1, block.lineHeight || 1));
  const widthBound = block.renderDirection === "vertical"
    ? Math.floor(innerWidth / (1.15 * fontWidthScaleFor(block)))
    : MAX_AUTOFIT_FONT_SIZE;
  const capped = clamp(Math.max(MIN_FONT_SIZE, heightBound, widthBound), MIN_FONT_SIZE, MAX_AUTOFIT_FONT_SIZE);
  let low = MIN_FONT_SIZE;
  let high = Math.floor(capped);
  let best = MIN_FONT_SIZE;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (fits(block, mid, innerWidth, innerHeight)) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return Math.min(best, capped);
}

function resolveTextOutlinePx(fontSize) {
  return Math.round(Math.min(4, Math.max(0.35, fontSize * 0.055)) * 10) / 10;
}

function resolveTextOutlineShadow(block, fontSize) {
  const outlineScale = block.outlineWidthScale == null ? 1 : block.outlineWidthScale;
  if (outlineScale <= 0) return "none";
  const radius = resolveTextOutlinePx(fontSize) * outlineScale;
  const halfRadius = Math.round(radius * 0.55 * 10) / 10;
  const offsets = [
    [0, -radius],
    [radius, 0],
    [0, radius],
    [-radius, 0],
    [radius, -radius],
    [radius, radius],
    [-radius, radius],
    [-radius, -radius],
    [halfRadius, -halfRadius],
    [halfRadius, halfRadius],
    [-halfRadius, halfRadius],
    [-halfRadius, -halfRadius],
  ];
  return offsets.map(function (offset) {
    return offset[0] + "px " + offset[1] + "px 0 " + block.outlineColor;
  }).join(", ");
}

function resolveFontWidthOrigin(block) {
  if (block.renderDirection === "vertical") {
    return "center center";
  }
  if (block.textAlign === "left") {
    return "left center";
  }
  if (block.textAlign === "right") {
    return "right center";
  }
  return "center center";
}

function applyTextLayout(block, textWrap, textContent) {
  const rect = block.rect;
  const fontSize = resolveFontSize(block, Math.max(1, rect.width), Math.max(1, rect.height));
  const scaleX = fontWidthScaleFor(block);
  const textContentWidth = block.renderDirection === "vertical"
    ? Math.max(1, rect.width)
    : Math.max(1, rect.width / scaleX);
  const fixedLines = resolveFixedHorizontalTextLines(block, fontSize, textContentWidth);

  textWrap.style.color = block.textColor;
  textWrap.style.fontFamily = block.fontFamily;
  textWrap.style.fontSize = fontSize + "px";
  textWrap.style.lineHeight = String(block.lineHeight);
  textWrap.style.letterSpacing = block.letterSpacing ? block.letterSpacing + "em" : "";
  textWrap.style.opacity = String(block.textOpacity == null ? 1 : block.textOpacity);
  textWrap.style.textAlign = block.textAlign || "center";

  textContent.style.boxSizing = "border-box";
  textContent.style.writingMode = block.renderDirection === "vertical" ? "vertical-rl" : "horizontal-tb";
  textContent.style.textOrientation = block.renderDirection === "vertical" ? "upright" : "";
  textContent.style.width = block.renderDirection === "vertical" ? "max-content" : textContentWidth + "px";
  textContent.style.height = block.renderDirection === "vertical" ? Math.max(1, rect.height) + "px" : "";
  textContent.style.maxWidth = "100%";
  textContent.style.maxHeight = "100%";
  textContent.style.overflow = "visible";
  textContent.style.overflowWrap = fixedLines ? "normal" : "";
  textContent.style.wordBreak = fixedLines ? "normal" : "";
  textContent.style.whiteSpace = fixedLines ? "normal" : "";
  textContent.style.fontWeight = block.bold ? "800" : "400";
  textContent.style.fontStyle = block.italic ? "italic" : "normal";
  textContent.style.fontSynthesis = "weight style";
  textContent.style.textShadow = resolveTextOutlineShadow(block, fontSize);
  textContent.style.transform = scaleX === 1 ? "" : "scaleX(" + scaleX + ")";
  textContent.style.transformOrigin = resolveFontWidthOrigin(block);
  renderTextContent(block, textContent, fixedLines);
}

function renderTextContent(block, textContent, fixedLines) {
  while (textContent.firstChild) {
    textContent.removeChild(textContent.firstChild);
  }
  if (fixedLines) {
    renderFixedHorizontalLines(fixedLines, textContent);
    return;
  }
  renderTextRuns(styledRuns(block), textContent);
}

function renderFixedHorizontalLines(lines, textContent) {
  for (const line of lines) {
    const lineSpan = document.createElement("span");
    lineSpan.className = "overlay-text-line";
    lineSpan.style.display = "block";
    lineSpan.style.whiteSpace = "pre";
    if (line.runs.length > 0) {
      renderTextRuns(line.runs, lineSpan);
    } else {
      lineSpan.textContent = "\\u00a0";
    }
    textContent.appendChild(lineSpan);
  }
}

function renderTextRuns(runs, parent) {
  for (const run of runs) {
    const span = document.createElement("span");
    span.style.fontWeight = run && run.bold ? "800" : "400";
    span.style.fontStyle = run && run.italic ? "italic" : "normal";
    span.textContent = run && run.text != null ? String(run.text) : "";
    parent.appendChild(span);
  }
}

function canRenderCurveText(block) {
  return !!(
    block.curveLayout &&
    block.renderDirection === "horizontal" &&
    !/[\\r\\n]/.test(block.text) &&
    Array.isArray(block.curveLayout.samples) &&
    block.curveLayout.samples.length >= 2
  );
}

function segmentGraphemes(value) {
  const text = value == null ? "" : String(value);
  return Array.from(text);
}

function styledGlyphs(block) {
  const glyphs = [];
  for (const run of styledRuns(block)) {
    for (const text of segmentGraphemes(run.text)) {
      glyphs.push({ text: text, bold: run.bold, italic: run.italic });
    }
  }
  return glyphs;
}

function measureCurveGlyphs(block, fontSize) {
  const scaleX = fontWidthScaleFor(block);
  return styledGlyphs(block).map(function (glyph) {
    context.font = graphemeFont(glyph, fontSize, block.fontFamily);
    return {
      text: glyph.text,
      bold: glyph.bold,
      italic: glyph.italic,
      width: Math.max(0, context.measureText(glyph.text).width * scaleX)
    };
  });
}

function renderCurveText(block, svg) {
  while (svg.firstChild) {
    svg.removeChild(svg.firstChild);
  }

  const rect = block.rect;
  const fontSize = resolveFontSize(
    block,
    Math.max(1, rect.width),
    Math.max(1, rect.height)
  );
  const curve = block.curveLayout;
  const glyphs = measureCurveGlyphs(block, fontSize);
  if (!curve || glyphs.length === 0) {
    return;
  }

  const scaleX = fontWidthScaleFor(block);
  const naturalGap = letterSpacingPxFor(block, fontSize);
  const widthSum = glyphs.reduce(function (sum, glyph) {
    return sum + glyph.width;
  }, 0);
  const pathLength = Math.max(0, Number(curve.pathLength) || 0);
  let gap = naturalGap;
  if (
    curve.fitSpacing &&
    glyphs.length > 1 &&
    pathLength + CURVE_EPSILON >= widthSum
  ) {
    gap = (pathLength - widthSum) / (glyphs.length - 1);
  }
  const textLength = widthSum + Math.max(0, glyphs.length - 1) * gap;
  const startDistance = resolveCurveStartDistance(
    curve.alignment,
    pathLength,
    textLength
  );
  const offsetPx = (Number(curve.offsetEm) || 0) * fontSize;
  const outlineScale = block.outlineWidthScale == null
    ? 1
    : Math.max(0, block.outlineWidthScale);
  const strokeWidth = resolveTextOutlinePx(fontSize) * outlineScale * 2;

  svg.style.opacity = String(block.textOpacity == null ? 1 : block.textOpacity);
  let cursor = startDistance;
  for (const glyph of glyphs) {
    const centerDistance = cursor + glyph.width / 2;
    const placement = curvePlacementAtDistance(
      curve.samples,
      pathLength,
      centerDistance
    );
    const x = placement.x - placement.tangentY * offsetPx;
    const y = placement.y + placement.tangentX * offsetPx;
    const angle = curve.orientation === "tangent"
      ? Math.atan2(placement.tangentY, placement.tangentX) * 180 / Math.PI
      : 0;
    const element = createCurveGlyphElement(
      block,
      glyph,
      fontSize,
      strokeWidth,
      x,
      y,
      angle,
      scaleX
    );
    svg.appendChild(element);
    cursor += glyph.width + gap;
  }
}

function resolveCurveStartDistance(alignment, pathLength, textLength) {
  if (alignment === "end") {
    return pathLength - textLength;
  }
  if (alignment === "center") {
    return (pathLength - textLength) / 2;
  }
  return 0;
}

function curvePlacementAtDistance(samples, pathLength, distance) {
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (distance <= 0 || pathLength <= CURVE_EPSILON) {
    return extrapolateCurveSample(first, distance);
  }
  if (distance >= pathLength) {
    return extrapolateCurveSample(last, distance - pathLength);
  }

  let low = 1;
  let high = samples.length - 1;
  while (low < high) {
    const midpoint = Math.floor((low + high) / 2);
    if (samples[midpoint].distance < distance) {
      low = midpoint + 1;
    } else {
      high = midpoint;
    }
  }
  const after = samples[low];
  const before = samples[low - 1];
  const span = after.distance - before.distance;
  const ratio = span > CURVE_EPSILON
    ? (distance - before.distance) / span
    : 0;
  const tangent = normalizeVector(
    before.tangentX + (after.tangentX - before.tangentX) * ratio,
    before.tangentY + (after.tangentY - before.tangentY) * ratio
  );
  return {
    x: before.x + (after.x - before.x) * ratio,
    y: before.y + (after.y - before.y) * ratio,
    tangentX: tangent.x,
    tangentY: tangent.y
  };
}

function extrapolateCurveSample(sample, delta) {
  const tangent = normalizeVector(sample.tangentX, sample.tangentY);
  return {
    x: sample.x + tangent.x * delta,
    y: sample.y + tangent.y * delta,
    tangentX: tangent.x,
    tangentY: tangent.y
  };
}

function normalizeVector(x, y) {
  const magnitude = Math.hypot(x, y);
  if (magnitude <= CURVE_EPSILON) {
    return { x: 1, y: 0 };
  }
  return { x: x / magnitude, y: y / magnitude };
}

function createCurveGlyphElement(
  block,
  glyph,
  fontSize,
  strokeWidth,
  x,
  y,
  angle,
  scaleX
) {
  const element = document.createElementNS(SVG_NAMESPACE, "text");
  element.setAttribute("x", "0");
  element.setAttribute("y", "0");
  element.setAttribute("text-anchor", "middle");
  element.setAttribute("dominant-baseline", "central");
  element.setAttribute("xml:space", "preserve");
  element.setAttribute("fill", block.textColor);
  if (strokeWidth > 0) {
    element.setAttribute("stroke", block.outlineColor);
    element.setAttribute("stroke-width", String(strokeWidth));
    element.setAttribute("stroke-linejoin", "round");
    element.setAttribute("paint-order", "stroke fill");
  }
  const transforms = ["translate(" + formatCurveNumber(x) + " " + formatCurveNumber(y) + ")"];
  if (angle) {
    transforms.push("rotate(" + formatCurveNumber(angle) + ")");
  }
  if (scaleX !== 1) {
    transforms.push("scale(" + formatCurveNumber(scaleX) + " 1)");
  }
  element.setAttribute("transform", transforms.join(" "));
  element.style.fontFamily = block.fontFamily;
  element.style.fontSize = fontSize + "px";
  element.style.fontWeight = glyph.bold ? "800" : "400";
  element.style.fontStyle = glyph.italic ? "italic" : "normal";
  element.style.fontSynthesis = "weight style";
  element.style.whiteSpace = "pre";
  element.textContent = glyph.text;
  return element;
}

function formatCurveNumber(value) {
  const finite = Number.isFinite(value) ? value : 0;
  const rounded = Math.round(finite * 1000000) / 1000000;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

function renderExportBlocks(stage) {
  const rendered = [];
  for (const block of EXPORT_BLOCKS) {
    const rect = block.rect;
    const outer = document.createElement("div");
    outer.className = "overlay-block block-" + (block.type === "nonsolid" ? "nonsolid" : "nonsolid") + " chrome-hidden";
    outer.style.left = rect.left + "px";
    outer.style.top = rect.top + "px";
    outer.style.width = Math.max(1, rect.width) + "px";
    outer.style.height = Math.max(1, rect.height) + "px";
    outer.style.overflow = "visible";
    outer.style.transform = block.rotationDeg ? "rotate(" + block.rotationDeg + "deg)" : "";
    outer.style.transformOrigin = "center center";
    outer.style.pointerEvents = "none";

    const contentHost = createExportContentHost(block, outer);
    if (canRenderCurveText(block)) {
      const svg = createCurveTextLayer(block);
      contentHost.appendChild(svg);
      rendered.push({ block: block, curveSvg: svg });
    } else {
      const textWrap = document.createElement("div");
      textWrap.className = "overlay-text";

      const textContent = document.createElement("span");
      textContent.className = "overlay-text-content";

      textWrap.appendChild(textContent);
      contentHost.appendChild(textWrap);
      rendered.push({ block: block, textWrap: textWrap, textContent: textContent });
    }
    stage.appendChild(outer);
  }
  return rendered;
}

function createExportContentHost(block, outer) {
  if (!block.perspectiveMatrix3d) {
    return outer;
  }
  const layer = document.createElement("div");
  layer.className = "overlay-perspective-layer";
  layer.style.position = "absolute";
  layer.style.inset = "0";
  layer.style.width = "100%";
  layer.style.height = "100%";
  layer.style.overflow = "visible";
  layer.style.transform = block.perspectiveMatrix3d;
  layer.style.transformOrigin = "top left";
  layer.style.transformStyle = "preserve-3d";
  layer.style.pointerEvents = "none";
  outer.appendChild(layer);
  return layer;
}

function createCurveTextLayer(block) {
  const svg = document.createElementNS(SVG_NAMESPACE, "svg");
  svg.setAttribute("class", "curve-text-layer");
  svg.setAttribute(
    "viewBox",
    "0 0 " + Math.max(1, block.rect.width) + " " + Math.max(1, block.rect.height)
  );
  svg.setAttribute("width", String(Math.max(1, block.rect.width)));
  svg.setAttribute("height", String(Math.max(1, block.rect.height)));
  svg.style.position = "absolute";
  svg.style.inset = "0";
  svg.style.display = "block";
  svg.style.overflow = "visible";
  svg.style.pointerEvents = "none";
  return svg;
}

function renderExportImage(stage) {
  const image = document.createElement("img");
  image.className = "page-image";
  image.src = EXPORT_IMAGE_DATA_URL;
  image.alt = EXPORT_PAGE_NAME || "";
  image.draggable = false;
  stage.appendChild(image);
  return image;
}

function waitForImage(image) {
  if (image.complete && image.naturalWidth > 0) {
    return Promise.resolve();
  }
  if (image.decode) {
    return image.decode().catch(function () {
      return waitForImageEvent(image);
    });
  }
  return waitForImageEvent(image);
}

function waitForImageEvent(image) {
  return new Promise(function (resolve, reject) {
    image.addEventListener("load", function () { resolve(); }, { once: true });
    image.addEventListener("error", function () { reject(new Error("export image load failed")); }, { once: true });
  });
}

async function preloadExportFonts() {
  if (!document.fonts) {
    return;
  }
  const loads = [];
  for (const block of EXPORT_BLOCKS) {
    const size = Math.max(MIN_FONT_SIZE, Math.floor(block.fontSizePx || 20));
    loads.push(document.fonts.load("400 " + size + "px " + block.fontFamily));
    loads.push(document.fonts.load("600 " + size + "px " + block.fontFamily));
    loads.push(document.fonts.load("700 " + size + "px " + block.fontFamily));
    loads.push(document.fonts.load("800 " + size + "px " + block.fontFamily));
    loads.push(document.fonts.load("italic 400 " + size + "px " + block.fontFamily));
  }
  await Promise.all(loads.map(ignoreFontLoadFailure));
  await document.fonts.ready;
}

async function ignoreFontLoadFailure(load) {
  try {
    return await load;
  } catch (_error) {
    return [];
  }
}

function applyAllTextLayouts(renderedBlocks) {
  for (const rendered of renderedBlocks) {
    if (rendered.curveSvg) {
      renderCurveText(rendered.block, rendered.curveSvg);
    } else {
      applyTextLayout(rendered.block, rendered.textWrap, rendered.textContent);
    }
  }
}

window.addEventListener("load", async () => {
  const stage = document.getElementById("stage");
  const image = renderExportImage(stage);
  const renderedBlocks = renderExportBlocks(stage);
  await Promise.all([waitForImage(image), preloadExportFonts()]);
  applyAllTextLayouts(renderedBlocks);
  if (document.fonts && document.fonts.ready) {
    await document.fonts.ready;
    applyAllTextLayouts(renderedBlocks);
  }
  requestAnimationFrame(() => requestAnimationFrame(() => {
    document.body.dataset.ready = "1";
  }));
});
`;
