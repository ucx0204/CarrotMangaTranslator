type OriginalTitleInput = {
  workTitle: string;
  selection: { text: string };
};

export function needsJapaneseTitleRecovery(value: string): boolean {
  const normalized = value.normalize("NFKC").trim();
  return (
    /[\p{L}\p{N}]/u.test(normalized) &&
    !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(normalized)
  );
}

export function extractQuotedJapaneseTitleCandidates(query: string): string[] {
  const candidates = [
    ...extractQuotedValues(query, /"([^"\n]{1,200})"/gu),
    ...extractQuotedValues(query, /“([^”\n]{1,200})”/gu),
    ...extractQuotedValues(query, /「([^」\n]{1,200})」/gu),
    ...extractQuotedValues(query, /『([^』\n]{1,200})』/gu),
  ];
  return uniqueTitles(
    candidates
      .map((candidate) => candidate.replace(/\s+/gu, " ").trim())
      .filter((candidate) => {
        const key = normalizeTitleIdentity(candidate);
        return (
          key.length >= 8 &&
          !/\p{Script=Hangul}/u.test(candidate) &&
          /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(
            candidate,
          )
        );
      }),
  );
}

export function extractJapaneseTitleQueryCandidates(query: string): string[] {
  const quoted = extractQuotedJapaneseTitleCandidates(query);
  if (quoted.length > 0) return quoted;
  const relaxed = query
    .replace(
      /(?:公式|原題|日本語|登場人物|キャラクター|主人公|設定|用語|世界観|能力|あらすじ|作品紹介|作品|official|character|terminology|lore)/giu,
      " ",
    )
    .replace(/["“”「」『』]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const key = normalizeTitleIdentity(relaxed);
  return key.length >= 8 &&
    !/\p{Script=Hangul}/u.test(relaxed) &&
    /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(relaxed)
    ? [relaxed]
    : [];
}

function extractQuotedValues(value: string, pattern: RegExp): string[] {
  return [...value.matchAll(pattern)].flatMap((match) =>
    match[1] ? [match[1]] : [],
  );
}

export function extractLikelyOriginalTitles(
  input: OriginalTitleInput,
): string[] {
  const workTokens =
    input.workTitle
      .match(/[\p{L}\p{N}]+/gu)
      ?.map(normalizeTitleIdentity)
      .filter((value) => value.length >= 2) ?? [];
  const candidates: Array<{ source: string; score: number }> = [];
  for (const match of input.selection.text.matchAll(
    /source="([^"\n]{4,160})"\s*\|\s*(?:ko|target)="([^"\n]{4,160})"/gu,
  )) {
    const source = normalizeOriginalTitleSpacing(match[1] ?? "");
    const translated = normalizeTitleIdentity(match[2] ?? "");
    if (
      !source ||
      !/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(source)
    ) {
      continue;
    }
    const overlap = workTokens.filter((token) =>
      translated.includes(token),
    ).length;
    if (overlap < Math.min(3, Math.max(2, workTokens.length))) continue;
    candidates.push({
      source,
      score: overlap * 100 + Math.min(source.length, 100),
    });
  }
  return uniqueTitles(
    candidates
      .sort((left, right) => right.score - left.score)
      .map((candidate) => candidate.source),
  ).slice(0, 2);
}

export function extractLatinTitleSearchAnchor(value: string): string {
  if (/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(value)) {
    return "";
  }
  const tokens =
    value
      .normalize("NFKC")
      .match(/[A-Za-z0-9]+/gu)
      ?.filter((token) => !/^(?:raw|manga|comic)$/iu.test(token)) ?? [];
  if (tokens.length < 2) return "";
  const selected = tokens.slice(0, Math.min(tokens.length, 5)).join(" ");
  return selected.length >= 12 ? selected : "";
}

function uniqueTitles(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = normalizeTitleIdentity(value);
    if (
      !key ||
      seen.has(key) ||
      [...seen].some((existing) => existing.includes(key))
    ) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function normalizeTitleIdentity(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

export function titleIdentitySimilarity(left: string, right: string): number {
  const leftKey = normalizeTitleIdentity(left);
  const rightKey = normalizeTitleIdentity(right);
  if (!leftKey || !rightKey) return 0;
  if (leftKey.includes(rightKey) || rightKey.includes(leftKey)) {
    return (
      Math.min(leftKey.length, rightKey.length) /
      Math.max(leftKey.length, rightKey.length)
    );
  }
  const leftPairs = characterPairs(leftKey);
  const rightPairs = characterPairs(rightKey);
  if (leftPairs.size === 0 || rightPairs.size === 0) return 0;
  let shared = 0;
  for (const pair of leftPairs) {
    if (rightPairs.has(pair)) shared += 1;
  }
  return (2 * shared) / (leftPairs.size + rightPairs.size);
}

function normalizeOriginalTitleSpacing(value: string): string {
  let normalized = value.replace(/\s+/g, " ").trim();
  const hasJapaneseBoundary =
    /([\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}々〆ヶ】》」』）])\s+(?=[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}々〆ヶ【《「『（])/u;
  const japaneseBoundaries =
    /([\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}々〆ヶ】》」』）])\s+(?=[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}々〆ヶ【《「『（])/gu;
  while (hasJapaneseBoundary.test(normalized)) {
    normalized = normalized.replace(japaneseBoundaries, "$1");
  }
  return normalized;
}

function characterPairs(value: string): Set<string> {
  const characters = [...value];
  if (characters.length === 1) return new Set(characters);
  const pairs = new Set<string>();
  for (let index = 0; index < characters.length - 1; index += 1) {
    pairs.add(`${characters[index]}${characters[index + 1]}`);
  }
  return pairs;
}
