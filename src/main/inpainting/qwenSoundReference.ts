import type { NativeImage, Size } from "electron";
import type { PixelRect } from "./maskGeometry";
import { soundStencilWindow } from "./qwenRuledPaper";
import { nativePrintedStock } from "./qwenPrintedStock";
import type { IllustratedTitleHint } from "./fluxWorkerTypes";
import type { InterruptedDialogue } from "./qwenControlReferences";
type PrintWindow = NonNullable<ReturnType<typeof soundStencilWindow>>;
function terminalDots(
  { box, local, darkComponents }: PrintWindow,
  active: PixelRect,
) {
  const parts = darkComponents(108, 17).filter((part) => {
    let owned = 0;
    const { x, y, w } = part.rect;
    part.data.forEach((on, index) => {
      if (on && local[(y + Math.floor(index / w)) * box.w + x + (index % w)])
        owned++;
    });
    return owned > 0.58 * part.area;
  });
  const letters = parts.filter(
    ({ rect, area }) =>
      rect.h >= 0.17 * active.h && area > 0.018 * active.h * active.w,
  );
  if (letters.length < 2) return;
  const lastLetter = Math.max(...letters.map(({ rect }) => rect.y + rect.h));
  const dots = parts.filter(
    ({ rect: { w, h, y }, area }) =>
      y >= lastLetter &&
      w >= 4 &&
      h >= 4 &&
      h < 0.11 * active.h &&
      w >= 0.7 * h &&
      w <= 1.4 * h &&
      area > 0.56 * w * h,
  );
  if (dots.length !== 3) return;
  const centers = dots
    .sort((a, b) => a.rect.y - b.rect.y)
    .map(({ rect }) => ({ x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }));
  const [a, b, c] = centers;
  const pitch = (c.y - a.y) / 2;
  if (
    pitch < 1.7 * dots[1].rect.h ||
    pitch > 5.5 * dots[1].rect.h ||
    Math.abs(2 * b.y - a.y - c.y) > 0.3 * pitch ||
    Math.abs(2 * b.x - a.x - c.x) > 0.23 * pitch ||
    Math.abs(c.x - a.x) > 1.05 * pitch
  )
    return;
  return { center: c, radius: dots[2].rect.h, lastLetter, pitch };
}
function printedScreenBesideDots(
  { box, gray, distance }: PrintWindow,
  dots: NonNullable<ReturnType<typeof terminalDots>>,
) {
  let blank = 0,
    foreground = 0,
    screen = 0,
    architecture = 0;
  for (let at = 0; at < gray.length; at++) {
    const x = at % box.w,
      y = Math.floor(at / box.w);
    if (
      x < 4 ||
      y < 4 ||
      x >= box.w - 4 ||
      y >= box.h - 4 ||
      distance[at] < 5 ||
      distance[at] > 26
    )
      continue;
    if (Math.hypot(x - dots.center.x, y - dots.center.y) < 2.4 * dots.radius) {
      foreground++;
      blank += Number(gray[at] > 244);
    }
    if (y > dots.lastLetter + dots.pitch / 2) continue;
    architecture++;
    screen += Number(isScreenDot(gray, box.w, at));
  }
  return enoughScreenAndPaper(blank, foreground, screen, architecture);
}
function isScreenDot(gray: Uint8Array, stride: number, i: number) {
  return (
    gray[i] < 207 &&
    gray[i] > 35 &&
    Math.max(gray[i + 1], gray[i - 1], gray[i + stride], gray[i - stride]) >
      gray[i] + 33
  );
}
function enoughScreenAndPaper(
  blank: number,
  foreground: number,
  screen: number,
  architecture: number,
) {
  return (
    foreground >= 60 &&
    blank > 0.86 * foreground &&
    architecture >= 350 &&
    screen > 0.063 * architecture
  );
}
/** Three small period marks continue a broad printed sound from a dot-screened molding onto white paper. */
export function crossesScreenedMolding(
  source: Buffer,
  stencil: Uint8Array,
  size: Size,
) {
  const window = soundStencilWindow(
    source,
    stencil,
    size,
    37,
    (active) =>
      active.w >= 35 &&
      active.w <= 170 &&
      active.h >= 95 &&
      active.h <= 340 &&
      active.h >= 1.65 * active.w,
  );
  if (!window) return false;
  const dots = terminalDots(window, window.active);
  return Boolean(dots && printedScreenBesideDots(window, dots));
}

function fanBanks(
  source: Buffer,
  size: Size,
  { box, gray, distance }: PrintWindow,
) {
  let selected = 0,
    black = 0,
    paper = 0,
    colour = 0,
    bank = 0,
    solid = 0,
    white = 0;
  const ridges: number[] = [];
  for (let i = 0; i < gray.length; i++) {
    const x = i % box.w,
      y = Math.floor(i / box.w);
    if (Math.min(x, y, box.w - 1 - x, box.h - 1 - y) < 10) continue;
    const g = gray[i],
      d = distance[i];
    if (!d) {
      selected++;
      black += Number(g < 65);
      paper += Number(g > 241);
      const at = 4 * ((box.y + y) * size.width + box.x + x);
      colour += Number(
        Math.max(source[at], source[at + 1], source[at + 2]) -
          Math.min(source[at], source[at + 1], source[at + 2]) >
          8,
      );
      continue;
    }
    if (d <= 5 || d >= 40) continue;
    if (d < 27) {
      bank++;
      const cross = [
        g,
        gray[i - 3],
        gray[i + 3],
        gray[i - 3 * box.w],
        gray[i + 3 * box.w],
      ];
      solid += Number(Math.max(...cross) < 40);
      white += Number(Math.min(...cross) > 237);
    }
    if (d > 12 && g > 56 && g < 237) ridges.push(i);
  }
  return { selected, black, paper, colour, bank, solid, white, ridges };
}
function separatedFanInks(data: ReturnType<typeof fanBanks>) {
  const { selected, black, paper, colour, bank, solid, white, ridges } = data;
  return (
    selected >= 520 &&
    selected <= 16000 &&
    black >= 0.38 * selected &&
    paper >= 0.11 * selected &&
    colour <= 0.01 * selected &&
    bank >= 400 &&
    solid >= 0.075 * bank &&
    white >= 0.24 * bank &&
    ridges.length >= 50
  );
}
function hasDivergingShafts(
  gray: Uint8Array,
  stride: number,
  ridges: number[],
) {
  const confirmed: number[] = [];
  for (let degrees = -78; degrees <= 78; degrees += 6) {
    if (Math.abs(degrees) < 8) continue;
    const theta = (degrees * Math.PI) / 180,
      dx = Math.cos(theta),
      dy = Math.sin(theta);
    const offset = (x: number, y: number) =>
      Math.round(y) * stride + Math.round(x);
    const probes = [-8, -4, 0, 4, 8].map((step) => [
      offset(step * dx, step * dy),
      offset(step * dx - 2.7 * dy, step * dy + 2.7 * dx),
      offset(step * dx + 2.7 * dy, step * dy - 2.7 * dx),
    ]);
    const count = ridges.filter((i) =>
      probes.every(([c, a, b]) => {
        const level = Math.min(gray[i + a], gray[i + b]);
        return level > 223 && level - gray[i + c] > 12;
      }),
    ).length;
    if (count < 14) continue;
    if (
      confirmed.some(
        (angle) =>
          angle * degrees > 0 &&
          Math.abs(angle - degrees) >= 24 &&
          Math.abs(angle - degrees) <= 66,
      )
    )
      return true;
    confirmed.push(degrees);
  }
  return false;
}

/** Measured directions and black and white banks distinguish real action lines from a single panel rule. */
export function actionFanCondition(
  source: Buffer,
  stencil: Uint8Array,
  size: Size,
) {
  const window = soundStencilWindow(
    source,
    stencil,
    size,
    56,
    (active) =>
      Math.min(active.w, active.h) >= 44 && Math.max(active.w, active.h) <= 236,
  );
  if (!window) return;
  const evidence = fanBanks(source, size, window);
  if (
    separatedFanInks(evidence) &&
    hasDivergingShafts(window.gray, window.box.w, evidence.ridges)
  )
    return window.expanded(3.5);
}

export function registeredSoundReference(
  source: NativeImage,
  stencil: Uint8Array,
  prefix: string,
  mask: string | undefined,
  edit: "screenedMolding" | "actionFan" | "printedStock",
) {
  if (!mask) return;
  const size = source.getSize(),
    bitmap = source.toBitmap();
  const referenceEdit =
    edit === "printedStock" ? nativePrintedStock(bitmap, stencil, size) : edit;
  if (!referenceEdit) return;
  const condition =
    edit === "printedStock"
      ? stencil
      : edit === "actionFan"
        ? actionFanCondition(bitmap, stencil, size)
        : crossesScreenedMolding(bitmap, stencil, size)
          ? stencil
          : undefined;
  if (condition)
    return {
      size,
      condition,
      prior: source,
      prefix,
      nativeSourceMask: mask,
      sourceReference: true,
      registered: false,
      referenceEdit,
      material: {
        kind:
          referenceEdit === "paperEdgeCaption"
            ? ("caption" as const)
            : ("solid-impact" as const),
      },
    };
}

function canMatchPrintedStock(
  hint: IllustratedTitleHint | InterruptedDialogue,
) {
  return (
    !hint ||
    hint === true ||
    hint === "lettering" ||
    hint === "solid-impact" ||
    (typeof hint === "string" && hint.startsWith("sound:"))
  );
}

export function matchPrintedStock(
  source: NativeImage,
  stencil: Uint8Array,
  prefix: string,
  mask: string | undefined,
  hint: IllustratedTitleHint | InterruptedDialogue,
) {
  if (hint === "caption" || canMatchPrintedStock(hint)) {
    const stock = registeredSoundReference(
      source,
      stencil,
      prefix,
      mask,
      "printedStock",
    );
    if (hint !== "caption" || stock?.referenceEdit === "paperEdgeCaption")
      return stock;
  }
}
