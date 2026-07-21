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

let graphemeSegmenter;
let wordSegmenter;

function wordBreakFor(block) {
  const value = block && block.wordBreak;
  if (
    value === "normal" ||
    value === "break-all" ||
    value === "keep-all" ||
    value === "break-word"
  ) {
    return value;
  }
  return block && block.renderDirection === "vertical"
    ? "break-word"
    : "break-all";
}

function segmentGraphemes(value) {
  const text = value == null ? "" : String(value);
  if (graphemeSegmenter === undefined) {
    graphemeSegmenter = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
      ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
      : null;
  }
  if (graphemeSegmenter) {
    return Array.from(graphemeSegmenter.segment(text), function (entry) { return entry.segment; });
  }
  return segmentGraphemesFallback(text);
}

function segmentGraphemesFallback(value) {
  const clusters = [];
  for (const point of Array.from(value)) {
    const previous = clusters[clusters.length - 1];
    if (!previous || !shouldJoinPreviousCluster(previous, point)) {
      clusters.push(point);
    } else {
      clusters[clusters.length - 1] = previous + point;
    }
  }
  return clusters;
}

function shouldJoinPreviousCluster(previous, point) {
  if (isGraphemeExtend(point) || point === "\\u200d") return true;
  if (previous.endsWith("\\u200d")) return true;
  return isRegionalIndicator(point) && hasOddRegionalIndicatorCount(previous);
}

function isGraphemeExtend(value) {
  const codePoint = value.codePointAt(0) || 0;
  return /\\p{Mark}/u.test(value) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    (codePoint >= 0x1f3fb && codePoint <= 0x1f3ff) ||
    (codePoint >= 0xe0020 && codePoint <= 0xe007f);
}

function isRegionalIndicator(value) {
  const codePoint = value.codePointAt(0) || 0;
  return codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff;
}

function hasOddRegionalIndicatorCount(value) {
  const points = Array.from(value);
  return points.length > 0 && points.every(isRegionalIndicator) && points.length % 2 === 1;
}

function normalizeNewlines(value) {
  return String(value == null ? "" : value).replace(/\\r\\n?/g, "\\n");
}

function measureStyledGraphemes(runs, fontSize, fontFamily) {
  const normalizedRuns = runs.map(function (run) {
    return { text: normalizeNewlines(run.text), bold: !!run.bold, italic: !!run.italic };
  });
  const combinedText = normalizedRuns.map(function (run) { return run.text; }).join("");
  const graphemes = [];
  let runIndex = 0;
  let runEnd = normalizedRuns[0] ? normalizedRuns[0].text.length : 0;
  let textOffset = 0;
  for (const text of segmentGraphemes(combinedText)) {
    while (runIndex < normalizedRuns.length - 1 && textOffset >= runEnd) {
      runIndex += 1;
      runEnd += normalizedRuns[runIndex] ? normalizedRuns[runIndex].text.length : 0;
    }
    const run = normalizedRuns[runIndex] || { bold: false, italic: false };
    context.font = graphemeFont(run, fontSize, fontFamily);
    graphemes.push({
      text: text,
      bold: !!run.bold,
      italic: !!run.italic,
      width: text === "\\n" ? 0 : context.measureText(text).width
    });
    textOffset += text.length;
  }
  return graphemes;
}

function measureStyledWrappedText(runs, maxWidth, lineHeightPx, fontSize, fontFamily, letterSpacingPx, wordBreak) {
  return measureWrappedGraphemes(
    measureStyledGraphemes(runs, fontSize, fontFamily),
    maxWidth,
    lineHeightPx,
    letterSpacingPx,
    wordBreak
  );
}

function measureUniformWrappedText(text, maxWidth, lineHeightPx, graphemeAdvancePx, wordBreak) {
  const graphemes = segmentGraphemes(normalizeNewlines(text)).map(function (value) {
    return {
      text: value,
      bold: false,
      italic: false,
      width: value === "\\n" ? 0 : graphemeAdvancePx
    };
  });
  return measureWrappedGraphemes(graphemes, maxWidth, lineHeightPx, 0, wordBreak);
}

function measureWrappedGraphemes(graphemes, maxWidth, lineHeightPx, letterSpacingPx, wordBreak) {
  const lines = [];
  let paragraph = [];
  const flushParagraph = function () {
    lines.push.apply(lines, wrapParagraph(paragraph, maxWidth, letterSpacingPx, wordBreak));
    paragraph = [];
  };
  for (const grapheme of graphemes) {
    if (grapheme.text === "\\n") flushParagraph();
    else paragraph.push(grapheme);
  }
  flushParagraph();
  let maxLineWidth = 0;
  for (const line of lines) maxLineWidth = Math.max(maxLineWidth, line.width);
  return {
    lines: lines,
    lineCount: lines.length,
    totalHeight: lines.length * lineHeightPx,
    maxLineWidth: maxLineWidth
  };
}

function wrapParagraph(graphemes, maxWidth, letterSpacingPx, wordBreak) {
  if (!graphemes.length) return [{ runs: [], width: 0 }];
  if (wordBreak === "break-all") return wrapEagerly(graphemes, maxWidth, letterSpacingPx);
  return wrapNaturalUnits(
    buildNaturalUnits(graphemes, wordBreak !== "keep-all"),
    maxWidth,
    letterSpacingPx,
    wordBreak === "break-word"
  );
}

function wrapNaturalUnits(units, maxWidth, letterSpacingPx, emergencyBreak) {
  const lines = [];
  let line = [];
  let lineWidth = 0;
  const pushLine = function () {
    lines.push(toBlockTextLine(line, lineWidth));
    line = [];
    lineWidth = 0;
  };
  for (const unit of units) {
    const unitWidth = measureGraphemeSequence(unit, letterSpacingPx);
    const combinedWidth = lineWidth + (line.length ? letterSpacingPx : 0) + unitWidth;
    if (line.length && combinedWidth > maxWidth) pushLine();
    if (emergencyBreak && unitWidth > maxWidth) {
      const emergencyLines = wrapEagerly(unit, maxWidth, letterSpacingPx);
      lines.push.apply(lines, emergencyLines.slice(0, -1));
      const finalLine = emergencyLines[emergencyLines.length - 1];
      line = finalLine ? lineFromRuns(finalLine.runs, unit) : [];
      lineWidth = finalLine ? finalLine.width : 0;
      continue;
    }
    if (line.length) lineWidth += letterSpacingPx;
    line.push.apply(line, unit);
    lineWidth += unitWidth;
  }
  pushLine();
  return lines;
}

function wrapEagerly(graphemes, maxWidth, letterSpacingPx) {
  const lines = [];
  let line = [];
  let lineWidth = 0;
  const pushLine = function () {
    lines.push(toBlockTextLine(line, lineWidth));
    line = [];
    lineWidth = 0;
  };
  for (const grapheme of graphemes) {
    const advance = grapheme.width + (line.length ? letterSpacingPx : 0);
    if (line.length && lineWidth + advance > maxWidth) pushLine();
    if (line.length) lineWidth += letterSpacingPx;
    line.push(grapheme);
    lineWidth += grapheme.width;
  }
  pushLine();
  return lines;
}

function buildNaturalUnits(graphemes, allowCjkBreaks) {
  const units = [];
  const wordBreakOffsets = resolveNaturalWordBreakOffsets(graphemes);
  let unit = [];
  let textOffset = 0;
  for (const grapheme of graphemes) {
    const previous = unit[unit.length - 1];
    if (previous && isNaturalBreakBetween(
      previous.text,
      grapheme.text,
      allowCjkBreaks,
      wordBreakOffsets.has(textOffset)
    )) {
      units.push(unit);
      unit = [];
    }
    unit.push(grapheme);
    textOffset += grapheme.text.length;
  }
  if (unit.length) units.push(unit);
  return units;
}

function isNaturalBreakBetween(previous, next, allowCjkBreaks, hasWordBoundary) {
  if (isWhitespace(next)) return false;
  if (isOpeningPunctuation(previous) || isClosingPunctuation(next)) return false;
  if (isWhitespace(previous) || isBreakAfterPunctuation(previous) || isClosingPunctuation(previous)) return true;
  if (hasWordBoundary && (allowCjkBreaks || (!isCjk(previous) && !isCjk(next)))) return true;
  return allowCjkBreaks && (isCjk(previous) || isCjk(next));
}

function resolveNaturalWordBreakOffsets(graphemes) {
  if (wordSegmenter === undefined) {
    wordSegmenter = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
      ? new Intl.Segmenter(undefined, { granularity: "word" })
      : null;
  }
  if (!wordSegmenter) return new Set();
  const text = graphemes.map(function (grapheme) { return grapheme.text; }).join("");
  return new Set(Array.from(wordSegmenter.segment(text), function (entry) {
    return entry.index;
  }).filter(function (index) { return index > 0; }));
}

function measureGraphemeSequence(graphemes, letterSpacingPx) {
  return graphemes.reduce(function (width, grapheme, index) {
    return width + grapheme.width + (index ? letterSpacingPx : 0);
  }, 0);
}

function toBlockTextLine(graphemes, width) {
  const runs = [];
  for (const grapheme of graphemes) {
    const lastRun = runs[runs.length - 1];
    if (lastRun && lastRun.bold === grapheme.bold && lastRun.italic === grapheme.italic) {
      lastRun.text += grapheme.text;
    } else {
      runs.push({ text: grapheme.text, bold: grapheme.bold, italic: grapheme.italic });
    }
  }
  return { runs: runs, width: width };
}

function lineFromRuns(runs, candidates) {
  const count = runs.reduce(function (total, run) {
    return total + segmentGraphemes(run.text).length;
  }, 0);
  return candidates.slice(Math.max(0, candidates.length - count));
}

function isWhitespace(value) {
  return /^\\s+$/u.test(value) || value === "\\u200b";
}

function isCjk(value) {
  return /[\\p{Script=Han}\\p{Script=Hangul}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Bopomofo}]/u.test(value);
}

function isOpeningPunctuation(value) {
  return "([{<«“‘「『（［｛〈《【〔〖〘〚".includes(value);
}

function isClosingPunctuation(value) {
  return ")]}>»”’,.!?:;」』）］｝〉》】〕〗〙〛、。，．！？：；…".includes(value);
}

function isBreakAfterPunctuation(value) {
  return "-‐‑‒–—―/".includes(value);
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
    letterSpacingPxFor(block, fontSize),
    wordBreakFor(block)
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
    letterSpacingPxFor(block, fontSize),
    wordBreakFor(block)
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
    const verticalAdvance = fontSize * block.lineHeight + letterSpacingPxFor(block, fontSize);
    const measured = measureUniformWrappedText(
      block.text,
      innerHeight,
      1,
      Math.max(fontSize, verticalAdvance),
      wordBreakFor(block)
    );
    const columnCount = Math.max(1, measured.lineCount);
    return columnCount <= 2 &&
      columnCount * fontSize * 1.15 * scaleX <= innerWidth &&
      measured.maxLineWidth <= innerHeight;
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

function wordBreakCssFor(block) {
  const wordBreak = wordBreakFor(block);
  return wordBreak === "break-word"
    ? { wordBreak: wordBreak, overflowWrap: "anywhere" }
    : { wordBreak: wordBreak, overflowWrap: "normal" };
}

function applyTextLayout(block, textWrap, textContent) {
  const rect = block.rect;
  const fontSize = resolveFontSize(block, Math.max(1, rect.width), Math.max(1, rect.height));
  const scaleX = fontWidthScaleFor(block);
  const textContentWidth = block.renderDirection === "vertical"
    ? Math.max(1, rect.width)
    : Math.max(1, rect.width / scaleX);
  const fixedLines = resolveFixedHorizontalTextLines(block, fontSize, textContentWidth);
  const breakStyle = wordBreakCssFor(block);

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
  textContent.style.overflowWrap = breakStyle.overflowWrap;
  textContent.style.wordBreak = breakStyle.wordBreak;
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

function styledGlyphs(block) {
  const glyphs = [];
  for (const run of styledRuns(block)) {
    // Curve layout remains its existing one-code-point-per-glyph path.
    for (const text of Array.from(run.text)) {
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
