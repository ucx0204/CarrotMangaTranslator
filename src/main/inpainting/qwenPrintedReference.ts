import { hasOutlinedColumns } from "./qwenOutlinedColumns";
import { nativeLuminance } from "./qwenOutlinedLettering";
import { distanceToMask } from "./pageMaskComposite";
import { maskBoundsInRect } from "./imageRaster";
import type { NativeImage } from "electron";

/** On a low-resolution scan, broad edits can remove a balloon or a collar
 * along with a small effect. Measure the native print and its adjacent pen
 * before using the erased substrate as the masked diffusion reference. */
export function compactSoundCondition(
  source: NativeImage,
  stencil: Uint8Array,
  lightStockOnly = false,
) {
  const { width, height } = source.getSize();
  const bounds = maskBoundsInRect(stencil, width, {
    x: 0,
    y: 0,
    w: width,
    h: height,
  });
  if (
    !bounds ||
    Math.min(bounds.w, bounds.h) < 16 ||
    Math.max(bounds.w, bounds.h) > (lightStockOnly ? 64 : 112)
  )
    return;
  const pixels = source.toBitmap();
  const distance = distanceToMask(stencil, width, height);
  const stock = sampleCompactPrint(pixels, distance);
  if (stock.selected < 96 || stock.chromatic > 0.02 * stock.bank) return;
  if (
    !smallEffectOnLightStock(bounds, stock) &&
    (lightStockOnly || !compactPenStock(stock))
  )
    return;
  return Uint8Array.from(distance, (value) => Number(value <= 3.5));
}

function compactPenStock(stock: ReturnType<typeof sampleCompactPrint>) {
  const { selected, midtone, printed, pen, bank, white } = stock;
  return (
    midtone >= 0.26 * selected &&
    printed >= 0.38 * selected &&
    pen >= Math.max(1, 0.1 * bank) &&
    (white <= 0.65 * bank || pen >= 0.25 * bank) &&
    white >= 0.22 * bank
  );
}

/** A small dark effect next to a light gradient is easy to copy from the
 * original reference. Use the erased gradient when its bank carries no line. */
function smallEffectOnLightStock(
  bounds: { w: number; h: number },
  stock: ReturnType<typeof sampleCompactPrint>,
) {
  const { selected, printed, midtone, bank, darkBank, white, pen } = stock;
  return (
    Math.max(bounds.w, bounds.h) <= 64 &&
    printed > 0.18 * selected &&
    printed < 0.6 * selected &&
    midtone > 0.06 * selected &&
    bank >= 128 &&
    white > 0.82 * bank &&
    darkBank < 0.01 * bank &&
    pen < 0.12 * bank
  );
}

function sampleCompactPrint(pixels: Buffer, distance: Float32Array) {
  let selected = 0,
    midtone = 0,
    printed = 0,
    bank = 0,
    darkBank = 0,
    pen = 0,
    white = 0,
    chromatic = 0;
  for (let i = 0; i < distance.length; i++) {
    const g = pixels[4 * i + 1];
    if (distance[i] === 0) {
      selected++;
      midtone += Number(g > 62 && g < 182);
      printed += Number(g < 160);
    } else if (distance[i] > 3.5 && distance[i] < 11) {
      bank++;
      darkBank += Number(g < 65);
      const b = pixels[4 * i],
        r = pixels[4 * i + 2];
      chromatic += Number(Math.max(b, g, r) - Math.min(b, g, r) > 22);
      pen += Number(g > 69 && g < 212);
      white += Number(g > 227);
    }
  }
  return { selected, midtone, printed, bank, pen, white, chromatic, darkBank };
}

export function describeCoverPrint(
  source: NativeImage,
  stencil: Uint8Array,
  crop: {
    referenceEdit: string;
    editionReading?: string;
    coverReading?: string;
  },
) {
  if (crop.referenceEdit === "edition" && crop.editionReading !== undefined)
    return {
      printDescription: describeStackedEdition(
        source,
        stencil,
        crop.editionReading,
      ),
    };
  if (crop.referenceEdit === "mastheadLines" && crop.coverReading !== undefined)
    return {
      printDescription: describeMagazineMasthead(
        source,
        stencil,
        crop.coverReading,
      ),
    };
}

/** Resolve the two scales of print from the scan. A year and month underneath
 * a large issue number can be erased independently by the image editor. */
export function describeStackedEdition(
  source: Pick<NativeImage, "getSize" | "toBitmap">,
  stencil: Uint8Array,
  reading: string,
) {
  const parts = /^(\d{1,3})\s+((?:19|20)\d{2})\s+([A-Z]{3,4})$/iu.exec(reading);
  if (!parts) return;
  const { width, height, pigment, darkRows, winner, dark, strength, marked } =
    measurePrintColours(source, stencil);
  if (strength < Math.max(180, 0.04 * marked) || dark < 40) return;
  let below = 0,
    seen = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++)
      seen += Number(pigment[y * width + x] === winner);
    if (seen >= 0.94 * strength) below += darkRows[y];
  }
  if (below < 0.8 * dark) return;
  return `把${printColourName(winner)}大号的「${parts[1]}」和它下面的小号黑色「${parts[2]}」「${parts[3]}」连同白色描边、阴影和外发光全部擦掉。请在这些字原来的位置补全插画，延续周围看得到的发丝、背景、衣饰边缘和装饰线。保留人物的位置、画风及其余所有细节。`;
}

function describeMagazineMasthead(
  source: Pick<NativeImage, "getSize" | "toBitmap">,
  stencil: Uint8Array,
  reading: string,
) {
  const [title, ...lines] = reading.split("」「");
  if (!title || !lines.length) return;
  const { winner, strength, marked } = measurePrintColours(source, stencil);
  if (strength < Math.max(180, 0.04 * marked)) return;
  const latin = lines.filter((line) =>
    /^[\p{Script=Latin}\d\s.-]+$/u.test(line),
  );
  const slogans = lines.filter((line) => !latin.includes(line));
  const submark = latin.length
    ? `、同一标志的小英文「${latin.join("」「")}」`
    : "";
  const taglines = slogans.length
    ? `、周围的小号宣传语「${slogans.join("」「")}」`
    : "";
  return `把画面上方的整组杂志标志都擦掉，包括横跨画面的大号${printColourName(winner)}刊名「${title}」${submark}${taglines}。清除整组印刷文字的发光、描边和阴影。按照原图延续从刊名中间穿过的发丝以及后面的背景和光照。保持人物、衣饰和原画的构图。`;
}

function measurePrintColours(
  source: Pick<NativeImage, "getSize" | "toBitmap">,
  stencil: Uint8Array,
) {
  const { width, height } = source.getSize();
  const pixels = source.toBitmap();
  const bins = new Uint32Array(4096);
  const pigment = new Uint16Array(stencil.length);
  const darkRows = new Uint32Array(height);
  let marked = 0,
    winner = 0,
    dark = 0;
  stencil.forEach((on, i) => {
    if (!on) return;
    marked++;
    const b = pixels[4 * i],
      g = pixels[4 * i + 1],
      r = pixels[4 * i + 2];
    const high = Math.max(r, g, b);
    if (high < 65) {
      darkRows[Math.floor(i / width)]++;
      dark++;
    }
    if (high - Math.min(r, g, b) < 52) return;
    const key = (r >> 4) * 256 + (g >> 4) * 16 + (b >> 4);
    pigment[i] = key;
    if (++bins[key] > bins[winner]) winner = key;
  });
  return {
    width,
    height,
    pigment,
    darkRows,
    winner,
    dark,
    strength: bins[winner],
    marked,
  };
}

function printColourName(winner: number) {
  const r = winner >> 8,
    g = (winner >> 4) & 15,
    b = winner & 15;
  const hue = Math.atan2(Math.sqrt(3) * (g - b), 2 * r - g - b);
  return [
    "红色",
    "橙色",
    "黄色",
    "黄绿色",
    "绿色",
    "青绿色",
    "青色",
    "天蓝色",
    "蓝色",
    "紫色",
    "紫红色",
    "玫红色",
  ][(Math.round((hue * 6) / Math.PI) + 12) % 12];
}

export function couldContainTitleStock(
  source: NativeImage,
  stencil: Uint8Array,
) {
  const { width, height } = source.getSize();
  if (stencil.length > 950_000) return false;
  const box = maskBoundsInRect(stencil, width, {
    x: 0,
    y: 0,
    w: width,
    h: height,
  });
  if (!box || box.w < 190 || box.h < 64 || box.w < 1.75 * box.h) return false;
  const bitmap = source.toBitmap();
  const lines = [false, false, false];
  for (let y = 0; y < height; y++) {
    let dark = 0;
    for (let x = box.x; x < box.x + box.w; x += 3)
      dark += Number(bitmap[4 * (y * width + x) + 1] < 126);
    if (dark > 0.6 * Math.ceil(box.w / 3))
      lines[y < box.y ? 0 : y < box.y + box.h ? 1 : 2] = true;
  }
  return lines.every(Boolean);
}

export function luminousTitleMask(
  source: NativeImage,
  stencil: Uint8Array,
  originalMask?: string,
) {
  if (originalMask && couldContainLuminousType(source, stencil))
    return originalMask;
}

function couldContainLuminousType(source: NativeImage, stencil: Uint8Array) {
  const { width, height } = source.getSize();
  if (width < 160 || height < 64 || stencil.length > 900_000) return false;
  const bitmap = source.toBitmap();
  let left = width,
    right = -1;
  let marked = 0,
    bright = 0,
    dark = 0,
    chromatic = 0;
  for (let i = 0; i < stencil.length; i++) {
    if (!stencil[i]) continue;
    left = Math.min(left, i % width);
    right = Math.max(right, i % width);
    marked++;
    bright += Number(bitmap[4 * i + 1] > 229);
    dark += Number(bitmap[4 * i + 1] < 115);
    const p = i * 4;
    chromatic += Number(
      Math.max(bitmap[p], bitmap[p + 1], bitmap[p + 2]) -
        Math.min(bitmap[p], bitmap[p + 1], bitmap[p + 2]) >
        6,
    );
  }
  return (
    // The native circular-boundary fit requires a 130px span of actual ink.
    right - left >= 130 &&
    marked >= 1500 &&
    bright >= 0.36 * marked &&
    dark >= 0.17 * marked &&
    chromatic <= 0.08 * marked
  );
}

/** Broad white flourishes on a solid dark illustration can survive a direct
 * reference edit. Verify the multiple enclosed glyphs and the exposed dark
 * stock before conditioning diffusion on an erased substrate. */
export function hasWhiteTitleOnDarkStock(
  source: NativeImage,
  stencil: Uint8Array,
) {
  const { width, height } = source.getSize();
  const bounds = { x: 0, y: 0, w: width, h: height };
  const box = maskBoundsInRect(stencil, width, bounds);
  if (!box || box.h < 180 || box.h < 1.35 * box.w || stencil.length > 950_000)
    return false;
  const bitmap = source.toBitmap();
  const gray = nativeLuminance(bitmap, width, bounds);
  const distance = distanceToMask(stencil, width, height);
  const { marked, white, ink, bank, dark, coloured } = sampleOutlinedTitleTones(
    bitmap,
    gray,
    stencil,
    distance,
  );
  if (marked < 10_000 || white <= 0.25 * marked || ink <= 0.12 * marked)
    return false;
  return (
    bank > 500 &&
    dark > 0.67 * bank &&
    coloured < 0.02 * bank &&
    hasOutlinedColumns(source, stencil)
  );
}

function sampleOutlinedTitleTones(
  bitmap: Buffer,
  gray: Uint8Array,
  stencil: Uint8Array,
  distance: Float32Array,
) {
  let marked = 0,
    white = 0,
    ink = 0,
    bank = 0,
    dark = 0,
    coloured = 0;
  for (let i = 0; i < stencil.length; i++) {
    if (stencil[i]) {
      marked++;
      white += Number(gray[i] > 218);
      ink += Number(gray[i] < 100);
    } else if (distance[i] > 4 && distance[i] < 26) {
      bank++;
      dark += Number(gray[i] < 62);
      const p = 4 * i;
      coloured += Number(
        Math.max(bitmap[p], bitmap[p + 1], bitmap[p + 2]) -
          Math.min(bitmap[p], bitmap[p + 1], bitmap[p + 2]) >
          12,
      );
    }
  }
  return { marked, white, ink, bank, dark, coloured };
}

export const namedCoverPrint = new Set([
  "washedTitle",
  "edition",
  "mastheadLines",
  "coverTitle",
  "coverColumns",
  "jacket",
  "promo",
  "strap",
]);

export function isBrushHint(hint?: string): hint is "brush" | "solid-impact" {
  return hint === "brush" || hint === "solid-impact";
}

export const referenceInstructions = {
  paperEdgeCaption:
    "Edit this monochrome manga crop. Erase the printed Japanese caption, small readings and punctuation marked in the second reference. There is blank white paper on one side of the original drawing. Continue the tapered outer pen contours and any black panel borders through the removed type. Preserve the native fine screentone within the drawing, the original strands projecting onto the white paper, and all other artwork. Remove any white type outline without adding shading on the white side.",
  facetedFrame:
    "Remove only the repeated outlined Japanese sound letters and punctuation inside this black-and-white manga panel. Keep and complete the closed faceted speech frame, its double ink rule, the small pointed corners at its top and bottom, and the thin straight motion strokes outside it. The open inside of the frame is unprinted white paper. Use the surviving straight portions of the polygon as exact guides through every erased letter. The second reference marks the overprinted letters.",
  roughStone:
    "Erase the selected black Japanese sound lettering and its thin white outline in the first manga image, as marked in the second reference. Continue the original angular rock contour across the motion lettering with the same thickness. Fill the rest with the native varied dark flecks, short diagonal cuts, fine straight vertical motion lines and white rock surface visible on either side. Preserve the shape of each separate rock and every line outside the lettering.",
  drawnCloth:
    "Remove the black Japanese dialogue indicated in the second image from the first manga image. The rounded thought balloon is transparent. Continue the underlying drawing through the cleared lettering, including the long hair strands, slim contours, and the small pale floral dots on the fabric. Match the light ink density and texture of the exposed drawing inside this same balloon. Preserve the scalloped balloon border, the three small decorative bubbles, and the original dark artwork outside it.",

  screenedMolding:
    "Edit the first manga crop. Only remove the thick black Japanese lettering and the three black trailing dots shown in the second image, including their white printed outlines. Rebuild the original molding, vertical pillar edges, straight inclined edges and flat dot screentone on each face from the visible matching parts of the same architectural drawing. Continue each diagonal at the same angle and thickness as on either side. Keep the original blank white foreground and all other drawing.",
  actionFan:
    "Edit the original black and white manga panel. The second image marks the printed sound effect to erase. Remove the ink of those letters and their white outline. Continue the existing solid black silhouette and its native edge. Reconstruct the thin tapering action lines on the white paper following the original angles, narrowing toward their common origin. Preserve every visible pen line, screentone, character and background edge. Keep the empty white paper and solid black clean.",
  "solid-impact":
    "Edit the original black and white manga. The second image marks the solid printed sound effect. Remove all marked black strokes, detached accents, and the narrow white printed outline. Reconstruct the original background. Continue the visible panel borders, the outlines of solid white action shapes, and the architectural contours accurately through the former lettering. Follow the width and orientation of each line and the original printed halftone.",
  washedTitle:
    "清除整组标题的笔画、小装饰、白色描边和渐变白光。沿着原图两侧可见的边缘补全被遮住的清晰墨线、细密网点、衣褶和背景。保留其余物品、轮廓和独立标签，恢复未印刷标题的黑白漫画原画。",
  uprightJacket:
    "Remove every printed Japanese or Latin character, number, title, byline, outline and lettering glow from the original manga book cover. Reconstruct the illustrated figures and their original clothing, arms, hands, artifacts, colours and border. Keep expressions, poses and the composition consistent with the original. Return the unlettered illustration.",
  layeredTitle:
    "Repair the erased parts of the first full-colour manga crop. The second image shows the unedited artwork with the overprinted main title and the small Latin lettering. Restore only the art behind the print. Match the original colour of fabric, cast shadows, hard edges, ornaments and printed textures where visible on either side. Remove all dark type, bright outlines and their soft white halos.",
  pigment:
    "Edit the original colour manga illustration in the first image. The white area in the second image marks printed lettering and its coloured glow. Remove every letter face and its entire printed halo, including faint scattered colour at the edges. Continue the unprinted illustration, outlines, original colour fields, shading and paper texture from the visible surroundings. Preserve decorative artwork and the original composition.",
  brush:
    "Edit the first image. The white area of the second black-and-white mask marks the printed Japanese sound effects. Remove the marked lettering, including brush strokes, detached tips and white keylines. Reconstruct the manga illustration underneath, following the visible edges of clothing, folds, gestures and action lines. Continue the original printed textures across the gap. Preserve the panel border and all the unmarked drawing. Return the first crop without text or replacement symbols.",
  jacket:
    "还原成印刷文字之前的原版封面插画。把所有日文汉字、假名、西文、数字、标题、作者名、卷号和所有与文字相连的底框、白边和阴影都去掉。画面上每一处印字都恢复成完整的绘画，尤其是左边整列大字、右边的色块和右下的小字。严格按原图延续头发、人体、衣袖、背景的轮廓和原色，保持人物位置不动。",
  promo:
    "把这行横排宣传文字整行擦去，连同所有白色的大字、标点、彩色外发光、投影和印刷痕迹。按照旁边原来可见的插画把被遮起来的衣物、阴影、纹理和背景延续成一体。保留下面各本小封面的边框和画面。",
  strap:
    "擦去横幅上的这一行印刷文字，包括白字、笔画的投影和标点。按原图延续横幅已有的颜色、底纹和明暗，保持横幅形状和其他插画原样。",
  coverColumns:
    "请擦掉这两列竖排宣传文字，连同各列文字所有颜色的外发光、白色笔画、标点和投影都要擦干净。按周围原画接回人物、服装、金属线条和背景。保留其余的印刷内容。",
  coverTitle:
    "把插画前面的大标题、小号英文副标题和作者名以及所有字的投影、彩色描边和衬底都抹去，还原各处被遮住的原画。让人物衣饰、背景和颜色接回周围原有的轮廓。保留其他小封面和印刷内容。",
  mastheadLines:
    "擦掉整组期刊标志，包括宣传语、小字、描边、阴影和外发光。按照周围原有的线条、色彩和亮度恢复被标志遮住的插画。保留其余文字和数字。",
  edition:
    "擦掉所选的期号、年月、数字、描边、投影和外发光。在它们遮住的位置续画背景和人物，让光照、发丝、服饰轮廓和装饰线与两边可见的原画相接。其余插画与文字保持原样。",
  caption:
    "去掉画面中心叠加的手写对白及其白色描边。沿着文字两边看得到的原画接续被截断的轮廓、透视线和线条粗细。保留完整的物品、人物、原有气泡边线和分格框，保持原来的纸张、网点和明暗。",
  effect:
    "仅擦除画面中心叠加的手写拟声词、白边和投影。按文字两侧可见的原画连续还原同一处表面的明暗、网点、纸纹及线条。保留书上的图案、印刷符号、原有的人物和物体。平坦的背景保持平坦。",
  dialogue:
    "擦除这格漫画里叠加的对白文字和白色衬底，恢复文字背后被遮住的原画。保留原来的所有空白对白气泡，连贯地延伸可见的气泡轮廓、衣服边缘和地面透视线，保持人物和原构图一致。",
  masthead:
    "仅去掉画面上最大的彩色杂志标志和它周围的光晕，恢复标志背后的原画。完整保留遮在标志前面的头发和细线，保留其余的小字、数字、背景的色彩、亮度和原图构图。",
  cover:
    "去掉这幅漫画插画上叠加的书名、作者姓名、标点、文字底框、描边和投影，恢复它们遮住的原画。延续可见轮廓、自然的明暗、纹理和线条。保留原图中的所有人物、物品、姿势、色彩、网点、画面大小和构图。",
  lettering:
    "擦除叠印在漫画插画上的文字、拟声词以及文字的描边和底色。延续画面中实际存在的线稿、网点、放射线和背景图案，保留所有人物的姿势、衣着、表情、画框和原作的构图。只还原文字遮挡的画面，保持原有的黑白明暗和线条粗细。",
};
