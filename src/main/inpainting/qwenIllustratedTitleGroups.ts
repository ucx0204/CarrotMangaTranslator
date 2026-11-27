import type { PatternMaskContext } from "./patternMaskContext";
import type { PixelRect } from "./maskGeometry";
import type { MangaPage } from "../../shared/libraryTypes";

export type PrintedLine = TitleCandidate & { reading: string };
export function hasMagazineMasthead(context: PatternMaskContext) {
  return context.inpaintWindowGroupIds.some((group) =>
    group.some((id) => id.startsWith("qwen-masthead:")),
  );
}

/** A publisher can print a title as several independently detected lines
 * above a creator credit. Resolve them in one view so a neighbouring line
 * cannot become a reference for replacement lettering inside the edit. */
export function groupIllustratedTitleLines(
  context: PatternMaskContext,
  page: MangaPage,
) {
  const blocks = new Map(page.blocks.map((block) => [block.id, block]));
  const candidates = context.validationBlockIds.map((id, i) => {
    const block = blocks.get(id);
    const rect = context.inpaintCompositeMasks[i].bounds;
    const reading = block?.sourceText.normalize("NFKC").trim() ?? "";
    const available =
      !context.inpaintSpeechBubbleWindows[i] &&
      !context.inpaintWindowGroupIds[i].length &&
      block?.bubbleLayout?.origin !== "manual" &&
      block?.textRole !== "sound";
    return { i, rect, reading, available };
  });
  const short = Math.min(page.width, page.height);
  if (
    context.inpaintWindowGroupIds.filter((group) =>
      group.some((id) => id.startsWith("qwen-pigment:")),
    ).length >= 2
  )
    groupTransliteratedTitle(context, candidates, short);
  const magazine = hasMagazineMasthead(context);
  if (magazine) groupSideColumns(context, candidates, short, page);
  groupMastheadCaptions(context, candidates);
  groupTitleCredits(context, page, candidates, magazine, short);
}

/** A large illustrated title may have an independently printed Latin reading
 * immediately above the Japanese rows. Give the model all of that title in
 * one reference so it cannot copy letters back from the neighbouring row. */
function groupTransliteratedTitle(
  context: PatternMaskContext,
  candidates: PrintedLine[],
  width: number,
) {
  const rows = candidates.filter(
    (v) =>
      v.available &&
      v.rect.w > 0.5 * width &&
      v.rect.w > 2.8 * v.rect.h &&
      /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー・]+$/u.test(
        v.reading,
      ),
  );
  for (const latin of candidates.filter(
    (v) =>
      v.available &&
      v.rect.w > 0.32 * width &&
      /^[A-Za-z]+(?:[ .'-]+[A-Za-z]+){2,}$/u.test(v.reading),
  )) {
    const below = rows
      .filter(
        (row) =>
          row.rect.y > latin.rect.y &&
          row.rect.y < latin.rect.y + 0.32 * width &&
          Math.abs(
            row.rect.x + row.rect.w / 2 - latin.rect.x - latin.rect.w / 2,
          ) <
            0.13 * width,
      )
      .sort((a, b) => a.rect.y - b.rect.y);
    if (below.length !== 2) continue;
    const [upper, lower] = below;
    if (
      upper.rect.y - latin.rect.y - latin.rect.h > 0.055 * width ||
      Math.abs(lower.rect.y - upper.rect.y - upper.rect.h) > 0.075 * width
    )
      continue;
    bindMagazineLines(context, "qwen-layered-title", [latin, upper, lower]);
  }
}

function groupSideColumns(
  context: PatternMaskContext,
  candidates: PrintedLine[],
  short: number,
  page: MangaPage,
) {
  const columns = candidates.filter(({ i, available }) => {
    const b = context.inpaintWindowMasks[i].bounds;
    return (
      available &&
      b.h > 2.1 * b.w &&
      b.h > 0.25 * short &&
      b.w < 0.2 * short &&
      (b.x > 0.61 * page.width || b.x + b.w < 0.39 * page.width)
    );
  });
  for (const column of columns) {
    if (!column.available || !column.reading) continue;
    const a = context.inpaintWindowMasks[column.i].bounds;
    const next = columns.find(({ i, available }) => {
      const b = context.inpaintWindowMasks[i].bounds;
      return (
        available &&
        i !== column.i &&
        Math.abs(a.y - b.y) < 0.24 * Math.min(a.h, b.h) &&
        Math.min(a.h, b.h) > 0.42 * Math.max(a.h, b.h) &&
        Math.abs(a.x + a.w / 2 - b.x - b.w / 2) < 0.85 * (a.w + b.w)
      );
    });
    if (next) bindMagazineLines(context, "qwen-cover-columns", [column, next]);
  }
}
function groupMastheadCaptions(
  context: PatternMaskContext,
  candidates: PrintedLine[],
) {
  for (const header of candidates) {
    const ids = context.inpaintWindowGroupIds[header.i];
    if (!ids.some((id) => id.startsWith("qwen-masthead:"))) continue;
    const b = context.inpaintWindowMasks[header.i].bounds;
    const lines = candidates.filter(({ i, available, reading }) => {
      if (!available || !reading || reading.length > 100) return false;
      const line = context.inpaintWindowMasks[i].bounds;
      const middle = line.y + line.h / 2;
      return (
        line.h <= 0.3 * b.h &&
        line.w >= 1.65 * line.h &&
        line.w < 0.72 * b.w &&
        line.x >= b.x - 0.03 * b.w &&
        line.x + line.w <= b.x + 1.03 * b.w &&
        middle >= b.y - 0.12 * b.h &&
        middle <= b.y + b.h
      );
    });
    if (!lines.length) continue;
    // Use the actual readings selected by the editor, including a small
    // translation or tagline printed across the main logo's outer glow.
    bindMagazineLines(context, "qwen-masthead-lines", [header, ...lines]);
  }
}
function groupTitleCredits(
  context: PatternMaskContext,
  page: MangaPage,
  candidates: PrintedLine[],
  magazine: boolean,
  short: number,
) {
  for (const credit of candidates) {
    if (magazine && isMagazineCredit(credit, page)) {
      const display = magazineCreditDisplay(credit, candidates, short);
      if (display) {
        bindMagazineLines(context, "qwen-magazine-credit", [display, credit]);
        continue;
      }
    }
    if (
      !credit.available ||
      credit.rect.y < page.height * 0.52 ||
      !/^(?:[【[(]\s*)?(?:漫画|作画|原作|原案|Story\s+by|Illustrated\s+by|그림|원작)/iu.test(
        credit.reading,
      )
    )
      continue;
    const selected =
      titleBelowCredit(candidates, credit, short) ??
      titleAboveCredit(candidates, credit, short);
    const id = "qwen-illustrated-title:" + context.validationBlockIds[credit.i];
    for (const line of selected) {
      line.available = false;
      context.inpaintWindowGroupIds[line.i].push(id);
      context.inpaintWindowConstraints[line.i] ??=
        context.inpaintCompositeMasks[line.i];
    }
  }
}

type TitleCandidate = { i: number; rect: PixelRect; available: boolean };

export function bindMagazineLines(
  context: PatternMaskContext,
  kind: string,
  lines: Array<TitleCandidate & { reading: string }>,
) {
  const reading = lines
    .map((line) => line.reading)
    .filter(Boolean)
    .join("」「");
  const id =
    kind +
    ":" +
    encodeURIComponent(reading) +
    ":" +
    context.validationBlockIds[lines[0].i];
  for (const line of lines) {
    line.available = false;
    context.inpaintWindowGroupIds[line.i].push(id);
    context.inpaintWindowConstraints[line.i] ??=
      context.inpaintCompositeMasks[line.i];
  }
}

// The credit and the narrow subtitle can bracket a single large display title.
function titleBelowCredit(
  candidates: TitleCandidate[],
  credit: TitleCandidate,
  short: number,
) {
  const { x, y, w, h } = credit.rect;
  const display = candidates.find(
    ({ i, available, rect: r }) =>
      i !== credit.i &&
      available &&
      r.w >= 0.55 * short &&
      r.h >= 0.14 * short &&
      r.w > 1.65 * r.h &&
      r.y >= y + 0.2 * h &&
      r.y <= y + h + 0.16 * short &&
      r.x < x + w &&
      r.x + r.w > x,
  );
  if (!display) return;
  const base = display.rect;
  const near = candidates.filter(
    ({ available, rect: r }) =>
      available &&
      r.x < base.x + base.w &&
      r.x + r.w > base.x &&
      r.y >= y - 0.14 * short &&
      r.y + r.h <= base.y + base.h + 0.12 * short,
  );
  return near.some(
    ({ rect: r }) =>
      r.y >= base.y + 0.75 * base.h &&
      r.w >= 0.42 * base.w &&
      r.h < 0.17 * base.h,
  )
    ? near
    : undefined;
}

function titleAboveCredit(
  candidates: TitleCandidate[],
  credit: TitleCandidate,
  short: number,
) {
  const { x, y, w, h } = credit.rect;
  const lines = candidates
    .filter((entry) => {
      const r = entry.rect;
      return (
        entry.available &&
        entry.i !== credit.i &&
        r.y + r.h * 0.5 < y + h * 0.5 &&
        r.y > y - 0.5 * short &&
        r.w > 0.16 * short &&
        r.w > 1.4 * r.h &&
        r.x < x + w + 0.15 * short &&
        r.x + r.w > x - 0.1 * short
      );
    })
    .sort((a, b) => b.rect.y + b.rect.h - a.rect.y - a.rect.h);
  let above = y;
  const adjacent = [];
  for (const line of lines) {
    if (
      above - line.rect.y - line.rect.h >
      Math.max(0.044 * short, 0.85 * line.rect.h)
    )
      break;
    adjacent.push(line);
    above = Math.min(above, line.rect.y);
  }
  if (
    adjacent.length < 3 ||
    y - above < 0.18 * short ||
    !adjacent.some((v) => v.rect.w > 0.36 * short)
  )
    return [];
  return [credit, ...adjacent];
}

function magazineCreditDisplay(
  credit: PrintedLine,
  candidates: PrintedLine[],
  short: number,
) {
  const c = credit.rect;
  return candidates.find(
    ({ i, rect: t, available, reading }) =>
      i !== credit.i &&
      available &&
      reading.length >= 3 &&
      t.w >= 0.38 * short &&
      t.h >= 0.12 * short &&
      t.w >= 1.5 * t.h &&
      c.w >= 0.68 * t.w &&
      c.w <= 1.6 * t.w &&
      c.h <= 0.48 * t.h &&
      Math.abs(c.x - t.x) < 0.15 * t.w &&
      Math.abs(c.y - t.y - t.h) < 0.24 * t.h,
  );
}

function isMagazineCredit(credit: PrintedLine, page: MangaPage) {
  return (
    credit.available &&
    credit.rect.y > page.height * 0.58 &&
    /(?:原作|原案|作画|漫画|Story\s+by|Illustrated\s+by|그림|원작)\s*[:：]/iu.test(
      credit.reading,
    )
  );
}
