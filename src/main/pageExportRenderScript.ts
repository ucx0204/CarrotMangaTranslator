/**
 * Browser-side canvas renderer injected into the offscreen PNG export window.
 * Kept as a standalone string module so the HTML builder stays small. The
 * companion serializer (pageExportBlocks.ts) defines the EXPORT_BLOCKS shape.
 */
export const PAGE_EXPORT_RENDER_SCRIPT = `
const MIN_FONT_SIZE = 10;
const MAX_AUTOFIT_FONT_SIZE = 256;
const canvas = document.createElement("canvas");
const context = canvas.getContext("2d");

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function buildFont(size, family, weight, italic) {
  return (italic ? "italic " : "") + (weight || 600) + " " + size + "px " + family;
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

// Flatten inline-style runs into per-grapheme {ch,bold,italic}. Falls back to
// the plain block text when no runs were serialized.
function styledGraphemes(block) {
  const runs = (block.runs && block.runs.length)
    ? block.runs
    : [{ text: block.text, bold: block.bold, italic: block.italic }];
  const out = [];
  for (const run of runs) {
    const text = run && run.text != null ? String(run.text) : "";
    for (const ch of Array.from(text)) {
      out.push({ ch: ch, bold: !!(run && run.bold), italic: !!(run && run.italic) });
    }
  }
  return out;
}

function graphemeFont(g, fontSize, fontFamily) {
  return buildFont(fontSize, fontFamily, g.bold ? 800 : 400, g.italic);
}

function wrapStyledGraphemes(graphemes, maxWidth, fontSize, fontFamily, letterSpacingPx) {
  const lines = [];
  let current = [];
  let lineWidth = 0;
  const pushLine = function () {
    lines.push({ graphemes: current, width: lineWidth });
    current = [];
    lineWidth = 0;
  };
  for (const g of graphemes) {
    if (g.ch === "\\n") {
      pushLine();
      continue;
    }
    context.font = graphemeFont(g, fontSize, fontFamily);
    const w = context.measureText(g.ch).width;
    const advance = w + (current.length ? letterSpacingPx : 0);
    if (current.length && lineWidth + advance > maxWidth) {
      pushLine();
      current.push({ ch: g.ch, bold: g.bold, italic: g.italic, w: w });
      lineWidth = w;
    } else {
      current.push({ ch: g.ch, bold: g.bold, italic: g.italic, w: w });
      lineWidth += advance;
    }
  }
  pushLine();
  return lines;
}

function measureHorizontal(block, fontSize, innerWidth) {
  const graphemes = styledGraphemes(block);
  const letterSpacingPx = letterSpacingPxFor(block, fontSize);
  const lines = wrapStyledGraphemes(graphemes, innerWidth, fontSize, block.fontFamily, letterSpacingPx);
  let maxLineWidth = 0;
  for (const line of lines) {
    if (line.width > maxLineWidth) maxLineWidth = line.width;
  }
  return {
    lines: lines,
    totalHeight: lines.length * fontSize * block.lineHeight,
    maxLineWidth: maxLineWidth
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
  const widthBound = block.renderDirection === "vertical" ? Math.floor(innerWidth / (1.15 * fontWidthScaleFor(block))) : MAX_AUTOFIT_FONT_SIZE;
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

function resolveOutlineWidth(fontSize) {
  return Math.round(Math.min(4, Math.max(0.35, fontSize * 0.055)) * 2 * 10) / 10;
}

function drawOutlinedText(ctx, text, x, y, block, fontSize) {
  const outlineScale = block.outlineWidthScale == null ? 1 : block.outlineWidthScale;
  ctx.fillStyle = block.textColor;
  if (outlineScale > 0) {
    ctx.lineJoin = "round";
    ctx.miterLimit = 2;
    ctx.lineWidth = resolveOutlineWidth(fontSize) * outlineScale;
    ctx.strokeStyle = block.outlineColor;
    ctx.strokeText(text, x, y);
  }
  ctx.fillText(text, x, y);
}

function drawHorizontalText(ctx, block, rect, fontSize) {
  const scaleX = fontWidthScaleFor(block);
  const innerWidth = Math.max(1, rect.width) / scaleX;
  const measured = measureHorizontal(block, fontSize, innerWidth);
  const lineHeightPx = fontSize * block.lineHeight;
  const totalHeight = measured.lines.length * lineHeightPx;
  const startY = rect.top + Math.max(0, (rect.height - totalHeight) / 2);
  const align = block.textAlign || "center";
  const letterSpacingPx = letterSpacingPxFor(block, fontSize);
  const anchorX = align === "left" ? rect.left : align === "right" ? rect.left + rect.width : rect.left + rect.width / 2;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  for (const [index, line] of measured.lines.entries()) {
    const y = startY + index * lineHeightPx;
    let x = align === "left" ? rect.left : align === "right" ? rect.left + rect.width - line.width : rect.left + (rect.width - line.width) / 2;
    ctx.save();
    ctx.translate(anchorX, 0);
    ctx.scale(scaleX, 1);
    ctx.translate(-anchorX, 0);
    for (const g of line.graphemes) {
      ctx.font = buildFont(fontSize, block.fontFamily, g.bold ? 800 : 400, g.italic);
      if (g.ch.trim()) {
        drawOutlinedText(ctx, g.ch, x, y, block, fontSize);
      }
      x += g.w + letterSpacingPx;
    }
    ctx.restore();
  }
}

function drawVerticalText(ctx, block, rect, fontSize) {
  const scaleX = fontWidthScaleFor(block);
  const graphemes = styledGraphemes(block).map(function (g) {
    return g.ch === "\\n" ? { ch: " ", bold: g.bold, italic: g.italic } : g;
  });
  let hasInk = false;
  for (const g of graphemes) {
    if (g.ch.trim()) { hasInk = true; break; }
  }
  if (!hasInk) {
    return;
  }
  const lineHeightPx = fontSize * block.lineHeight + letterSpacingPxFor(block, fontSize);
  const charsPerColumn = Math.max(1, Math.floor(Math.max(1, rect.height) / lineHeightPx));
  const columns = [];
  for (let index = 0; index < graphemes.length; index += charsPerColumn) {
    columns.push(graphemes.slice(index, index + charsPerColumn));
  }
  const columnGap = fontSize * 1.15 * scaleX;
  const totalWidth = Math.max(columnGap, columns.length * columnGap);
  const firstX = rect.left + rect.width / 2 + totalWidth / 2 - columnGap / 2;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (const [columnIndex, column] of columns.entries()) {
    const x = firstX - columnIndex * columnGap;
    const columnHeight = column.length * lineHeightPx;
    const startY = rect.top + Math.max(0, (rect.height - columnHeight) / 2);
    ctx.save();
    ctx.translate(x, 0);
    ctx.scale(scaleX, 1);
    ctx.translate(-x, 0);
    for (const [rowIndex, g] of column.entries()) {
      if (!/\\s/u.test(g.ch)) {
        ctx.font = buildFont(fontSize, block.fontFamily, g.bold ? 800 : 400, g.italic);
        drawOutlinedText(ctx, g.ch, x, startY + rowIndex * lineHeightPx, block, fontSize);
      }
    }
    ctx.restore();
  }
}

function drawExportBlock(ctx, block) {
  const rect = block.rect;
  const innerWidth = Math.max(1, rect.width);
  const innerHeight = Math.max(1, rect.height);
  const fontSize = resolveFontSize(block, innerWidth, innerHeight);
  ctx.save();
  let drawRect = rect;
  if (block.rotationDeg) {
    ctx.translate(rect.left + rect.width / 2, rect.top + rect.height / 2);
    ctx.rotate((block.rotationDeg * Math.PI) / 180);
    drawRect = { left: -rect.width / 2, top: -rect.height / 2, width: rect.width, height: rect.height };
  }
  if (block.renderDirection === "vertical") {
    drawVerticalText(ctx, block, drawRect, fontSize);
  } else {
    drawHorizontalText(ctx, block, drawRect, fontSize);
  }
  ctx.restore();
}

function loadExportImage() {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("export image load failed"));
    image.src = EXPORT_IMAGE_DATA_URL;
  });
}

async function renderCanvasPng() {
  const outputCanvas = document.getElementById("exportCanvas");
  const ctx = outputCanvas.getContext("2d");
  if (!ctx) {
    throw new Error("canvas context unavailable");
  }
  const image = await loadExportImage();
  ctx.clearRect(0, 0, outputCanvas.width, outputCanvas.height);
  ctx.drawImage(image, 0, 0, outputCanvas.width, outputCanvas.height);
  for (const block of EXPORT_BLOCKS) {
    drawExportBlock(ctx, block);
  }
  window.__exportPngDataUrl = outputCanvas.toDataURL("image/png");
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

window.addEventListener("load", async () => {
  await preloadExportFonts();
  await renderCanvasPng();
  if (document.fonts && document.fonts.ready) {
    await document.fonts.ready;
  }
  requestAnimationFrame(() => requestAnimationFrame(() => {
    document.body.dataset.ready = "1";
  }));
});
`;
