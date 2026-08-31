import { stripRichTextMarkup } from "../../../shared/richTextMarkup";

export type ConsistentEditSuggestion = {
  find: string;
  replace: string;
};

/**
 * Converts one continuous visible-text edit into a conservative find/replace
 * suggestion. Insert-only and likely multi-region edits are intentionally
 * ignored so the batch editor never guesses at an ambiguous intention.
 */
// eslint-disable-next-line complexity -- prefix/suffix bounds and ambiguity guards form one conservative suggestion gate
export function deriveSingleTextReplacement(
  beforeMarkup: string,
  afterMarkup: string,
): ConsistentEditSuggestion | null {
  const before = Array.from(stripRichTextMarkup(beforeMarkup));
  const after = Array.from(stripRichTextMarkup(afterMarkup));
  if (before.join("") === after.join("")) return null;

  let prefix = 0;
  while (
    prefix < before.length &&
    prefix < after.length &&
    before[prefix] === after[prefix]
  ) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const find = before.slice(prefix, before.length - suffix).join("");
  const replace = after.slice(prefix, after.length - suffix).join("");
  if (
    find.length === 0 ||
    find.length > 80 ||
    replace.length > 80 ||
    /\r|\n/u.test(find + replace) ||
    longestCommonSubstringLength(find, replace) >= 3
  ) {
    return null;
  }
  return { find, replace };
}

function longestCommonSubstringLength(left: string, right: string): number {
  const leftChars = Array.from(left);
  const rightChars = Array.from(right);
  const previous = new Array<number>(rightChars.length + 1).fill(0);
  let longest = 0;
  for (const leftChar of leftChars) {
    let diagonal = 0;
    for (let index = 1; index <= rightChars.length; index += 1) {
      const above = previous[index] ?? 0;
      const next = leftChar === rightChars[index - 1] ? diagonal + 1 : 0;
      previous[index] = next;
      diagonal = above;
      longest = Math.max(longest, next);
    }
  }
  return longest;
}
