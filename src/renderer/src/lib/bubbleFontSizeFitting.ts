import type { TranslationBlock } from "../../../shared/textTypes";
import { parseRichText } from "../../../shared/richTextMarkup";
import { isGeneratedBubbleLayout } from "../../../shared/bubbleLayout";
import { MIN_READABLE_FONT_SIZE_PX } from "../../../shared/readableTextBox";
import {
  assessWrappedTextQuality,
  type SlottedWrappedTextMeasurement,
} from "./bubbleTextWrapping";
import { SOURCE_MATCH_OPTICAL_SCALE } from "./sourceFontSizeMatching";

type ParagraphDamage = { splits: number; punctuation: number; orphans: number };

/** The nearest readable size with fewer damaged boundaries wins; equal quality keeps size. */
export function selectSourceMatchedParagraphSize(
  plainText: string,
  preferred: number,
  measure: (size: number) => SlottedWrappedTextMeasurement | null,
): number {
  let best = preferred;
  let bestDamage = measureDamage(plainText, measure(best));
  while (!bestDamage && best > MIN_READABLE_FONT_SIZE_PX) {
    best = Math.max(MIN_READABLE_FONT_SIZE_PX, Math.floor(best) - 1);
    bestDamage = measureDamage(plainText, measure(best));
  }
  if (!bestDamage || isUndamaged(bestDamage)) return best;
  const hasBrokenBoundary = bestDamage.splits > 0 || bestDamage.punctuation > 0;
  const tolerance = hasBrokenBoundary ? 0.8 : 0.92;
  const minimum = Math.max(
    MIN_READABLE_FONT_SIZE_PX,
    Math.floor((best * tolerance) / SOURCE_MATCH_OPTICAL_SCALE),
  );
  for (let size = Math.floor(best) - 1; size >= minimum; size--) {
    const damage = measureDamage(plainText, measure(size));
    if (damage && compareDamage(damage, bestDamage) < 0) {
      best = size;
      bestDamage = damage;
      if (isUndamaged(damage)) break;
    }
  }
  return best;
}

function measureDamage(
  text: string,
  measured: SlottedWrappedTextMeasurement | null,
): ParagraphDamage | null {
  if (!measured) return null;
  if (measured.lines.length === 1)
    return { splits: 0, punctuation: 0, orphans: 0 };
  const quality = assessWrappedTextQuality(text, measured.lines);
  const contentCount = Array.from(text).filter((g) =>
    /[\p{Letter}\p{Number}]/u.test(g),
  ).length;
  return {
    splits: quality.intraWordSplitCount,
    punctuation:
      contentCount === 0
        ? 0
        : measured.lines.filter(
            (line) =>
              !line.runs.some((run) =>
                /[\p{Letter}\p{Number}\p{Mark}]/u.test(run.text),
              ),
          ).length,
    orphans: contentCount > 4 ? quality.orphanLineCount : 0,
  };
}

function compareDamage(left: ParagraphDamage, right: ParagraphDamage): number {
  return (
    left.splits - right.splits ||
    left.punctuation - right.punctuation ||
    left.orphans - right.orphans
  );
}

function isUndamaged(value: ParagraphDamage): boolean {
  return value.splits === 0 && value.punctuation === 0 && value.orphans === 0;
}

export function resolveSourceMatchedBubbleFontSize(
  block: TranslationBlock,
  text: string,
  preferred: number,
  measure: ((size: number) => SlottedWrappedTextMeasurement | null) | null,
): number {
  if (
    !measure ||
    block.fontSizeIntent !== "source-match" ||
    !isGeneratedBubbleLayout(block.bubbleLayout) ||
    block.renderDirection !== "horizontal" ||
    /[\r\n]/u.test(text)
  )
    return preferred;
  const { plainText } = parseRichText(
    text,
    Boolean(block.bold),
    Boolean(block.italic),
  );
  return selectSourceMatchedParagraphSize(plainText, preferred, measure);
}
