import type {
  ChapterStoryMemory,
  CharacterProfile,
  GlossaryEntry,
  PageStoryMemory,
  PromptWorkContext,
  WorkStyleGuide,
} from "./workContextTypes";

const WORK_CONTEXT_MIN_OUTPUT_HEADROOM_TOKENS = 2048;
export const WORK_CONTEXT_RECENT_PAGE_COUNT = 6;
const TRANSLATION_PROMPT_BASE_INPUT_TOKENS = 6400;

const CHARS_PER_TOKEN_ESTIMATE = 2;
const PROMPT_GLOSSARY_LIMIT = 80;
const PROMPT_CHARACTER_LIMIT = 40;

export type WorkContextBudgetOmittedPart =
  | "storyMemory"
  | "glossary"
  | "characters";

type WorkContextTokenBreakdown = {
  glossaryTokens: number;
  characterTokens: number;
  storyMemoryTokens: number;
  rulesTokens: number;
  totalTokens: number;
  glossaryCount: number;
  characterCount: number;
  storyPageCount: number;
};

type WorkContextBudgetSnapshot = WorkContextTokenBreakdown & {
  outputHeadroomTokens: number;
  outputHeadroomPercent: number;
};

export type WorkContextBudgetPlan = {
  original: WorkContextBudgetSnapshot;
  effective: WorkContextBudgetSnapshot;
  omittedParts: WorkContextBudgetOmittedPart[];
  minOutputHeadroomTokens: number;
  baseInputTokens: number;
  ctx: number;
  maxTokens: number;
};

export type WorkContextBudgetOptions = {
  ctx: number;
  maxTokens: number;
  minOutputHeadroomTokens?: number;
  baseInputTokens?: number;
};

export function buildWorkContextBudgetPreview({
  ctx,
  maxTokens,
  recentPageCount = WORK_CONTEXT_RECENT_PAGE_COUNT,
  storyMemory,
  styleGuide,
}: {
  ctx: number;
  maxTokens: number;
  recentPageCount?: number;
  storyMemory: ChapterStoryMemory;
  styleGuide: WorkStyleGuide;
}): WorkContextBudgetPlan {
  return planWorkContextBudget(
    {
      styleGuide,
      storyMemory: {
        ...storyMemory,
        pages: selectRecentStoryPages(storyMemory.pages, recentPageCount),
      },
      recentPageCount,
    },
    { ctx, maxTokens },
  );
}

export function prunePromptWorkContextForBudget(
  workContext: PromptWorkContext,
  options: WorkContextBudgetOptions,
): { workContext: PromptWorkContext; budget: WorkContextBudgetPlan } {
  const budget = planWorkContextBudget(workContext, options);
  if (budget.omittedParts.length === 0) {
    return { workContext, budget };
  }

  let nextContext = workContext;
  for (const part of budget.omittedParts) {
    nextContext = omitWorkContextPart(nextContext, part);
  }
  return { workContext: nextContext, budget };
}

function planWorkContextBudget(
  workContext: PromptWorkContext,
  {
    baseInputTokens = TRANSLATION_PROMPT_BASE_INPUT_TOKENS,
    ctx,
    maxTokens,
    minOutputHeadroomTokens = WORK_CONTEXT_MIN_OUTPUT_HEADROOM_TOKENS,
  }: WorkContextBudgetOptions,
): WorkContextBudgetPlan {
  const normalizedOptions = {
    baseInputTokens: normalizeNonNegativeInteger(baseInputTokens),
    ctx: normalizeNonNegativeInteger(ctx),
    maxTokens: normalizeNonNegativeInteger(maxTokens),
    minOutputHeadroomTokens: normalizeNonNegativeInteger(
      minOutputHeadroomTokens,
    ),
  };
  const original = buildBudgetSnapshot(workContext, normalizedOptions);
  let currentContext = workContext;
  let effective = original;
  const omittedParts: WorkContextBudgetOmittedPart[] = [];

  for (const part of [
    "storyMemory",
    "glossary",
    "characters",
  ] satisfies WorkContextBudgetOmittedPart[]) {
    if (
      effective.outputHeadroomTokens >=
      normalizedOptions.minOutputHeadroomTokens
    ) {
      break;
    }
    if (!hasWorkContextPart(currentContext, part)) {
      continue;
    }
    currentContext = omitWorkContextPart(currentContext, part);
    omittedParts.push(part);
    effective = buildBudgetSnapshot(currentContext, normalizedOptions);
  }

  return {
    original,
    effective,
    omittedParts,
    minOutputHeadroomTokens: normalizedOptions.minOutputHeadroomTokens,
    baseInputTokens: normalizedOptions.baseInputTokens,
    ctx: normalizedOptions.ctx,
    maxTokens: normalizedOptions.maxTokens,
  };
}

function estimateWorkContextTokenBreakdown(
  workContext: PromptWorkContext,
): WorkContextTokenBreakdown {
  const guide = workContext.styleGuide;
  const glossary = selectPromptGlossary(guide);
  const characters = selectPromptCharacters(guide);
  const storyPages = selectRecentStoryPages(
    workContext.storyMemory?.pages ?? [],
    workContext.recentPageCount,
  );
  const glossaryTokens =
    glossary.length > 0
      ? estimatePromptTokens(
          [
            "Use these glossary entries for consistency. If the source text matches an entry or alias, prefer the target Korean exactly unless Image 1 clearly proves a different meaning.",
            ...glossary.map(formatGlossaryEntryForBudget),
          ].join("\n"),
        )
      : 0;
  const characterTokens =
    characters.length > 0
      ? estimatePromptTokens(
          [
            "Character/name memory. Keep names and speech style consistent when translating dialogue.",
            ...characters.map(formatCharacterForBudget),
          ].join("\n"),
        )
      : 0;
  const storyMemoryTokens =
    storyPages.length > 0
      ? estimatePromptTokens(
          [
            "Recent story context from previous pages. Use it only to resolve pronouns, omitted subjects, relationships, tone, and continuity. Do not output these notes as records.",
            ...storyPages.map(formatStoryPageForBudget),
          ].join("\n"),
        )
      : 0;
  const rulesTokens = estimatePromptTokens(
    [
      "Work glossary and story memory",
      "Do not output these notes as records.",
      formatRulesForBudget(guide),
    ].join("\n"),
  );

  return {
    glossaryTokens,
    characterTokens,
    storyMemoryTokens,
    rulesTokens,
    totalTokens:
      glossaryTokens + characterTokens + storyMemoryTokens + rulesTokens,
    glossaryCount: glossary.length,
    characterCount: characters.length,
    storyPageCount: storyPages.length,
  };
}

function buildBudgetSnapshot(
  workContext: PromptWorkContext,
  options: {
    baseInputTokens: number;
    ctx: number;
    maxTokens: number;
  },
): WorkContextBudgetSnapshot {
  const breakdown = estimateWorkContextTokenBreakdown(workContext);
  const outputHeadroomTokens = Math.max(
    0,
    options.ctx - options.baseInputTokens - breakdown.totalTokens,
  );
  const outputHeadroomPercent =
    options.maxTokens > 0
      ? Math.max(
          0,
          Math.min(
            100,
            Math.floor(
              (Math.min(outputHeadroomTokens, options.maxTokens) /
                options.maxTokens) *
                100,
            ),
          ),
        )
      : 0;

  return {
    ...breakdown,
    outputHeadroomTokens,
    outputHeadroomPercent,
  };
}

function hasWorkContextPart(
  workContext: PromptWorkContext,
  part: WorkContextBudgetOmittedPart,
): boolean {
  if (part === "storyMemory") {
    return (workContext.storyMemory?.pages ?? []).length > 0;
  }
  if (part === "glossary") {
    return selectPromptGlossary(workContext.styleGuide).length > 0;
  }
  return selectPromptCharacters(workContext.styleGuide).length > 0;
}

function omitWorkContextPart(
  workContext: PromptWorkContext,
  part: WorkContextBudgetOmittedPart,
): PromptWorkContext {
  if (part === "storyMemory") {
    return {
      ...workContext,
      storyMemory: {
        ...workContext.storyMemory,
        pages: [],
      },
    };
  }
  if (part === "glossary") {
    return {
      ...workContext,
      styleGuide: {
        ...workContext.styleGuide,
        glossary: [],
      },
    };
  }
  return {
    ...workContext,
    styleGuide: {
      ...workContext.styleGuide,
      characters: [],
    },
  };
}

function selectPromptGlossary(guide: WorkStyleGuide): GlossaryEntry[] {
  return Array.isArray(guide.glossary)
    ? guide.glossary
        .filter((entry) => entry && entry.enabled !== false && entry.source)
        .slice(0, PROMPT_GLOSSARY_LIMIT)
    : [];
}

function selectPromptCharacters(guide: WorkStyleGuide): CharacterProfile[] {
  return Array.isArray(guide.characters)
    ? guide.characters
        .filter(
          (character) =>
            character &&
            character.enabled !== false &&
            (character.displayName ||
              character.targetName ||
              character.sourceNames.length > 0),
        )
        .slice(0, PROMPT_CHARACTER_LIMIT)
    : [];
}

function selectRecentStoryPages(
  pages: PageStoryMemory[],
  recentPageCount = WORK_CONTEXT_RECENT_PAGE_COUNT,
): PageStoryMemory[] {
  return pages
    .filter((page) => page && Number.isFinite(page.pageIndex))
    .slice()
    .sort((left, right) => left.pageIndex - right.pageIndex)
    .slice(-Math.max(0, recentPageCount));
}

function formatGlossaryEntryForBudget(entry: GlossaryEntry): string {
  const aliases =
    Array.isArray(entry.aliases) && entry.aliases.length
      ? ` aliases=${entry.aliases.map((value) => sanitizePromptLine(value, 80)).join(", ")}`
      : "";
  const note = entry.note ? ` note=${sanitizePromptLine(entry.note, 160)}` : "";
  return `- [${entry.category || "term"}] ${sanitizePromptLine(entry.source, 80)} => ${sanitizePromptLine(entry.target, 80)}${aliases}${note}`;
}

function formatCharacterForBudget(character: CharacterProfile): string {
  const sourceNames = Array.isArray(character.sourceNames)
    ? character.sourceNames.join(", ")
    : "";
  const style =
    character.speechStyle === "custom"
      ? character.customSpeechStyle || "custom"
      : character.speechStyle || "neutral";
  return `- ${sanitizePromptLine(character.displayName || character.targetName, 80)}: sourceNames=${sanitizePromptLine(sourceNames, 160)} targetName=${sanitizePromptLine(character.targetName, 80)} speechStyle=${sanitizePromptLine(style, 160)}`;
}

function formatStoryPageForBudget(page: PageStoryMemory): string {
  return `- p${Number(page.pageIndex) + 1} ${sanitizePromptLine(page.pageName)}: ${sanitizePromptLine(page.summary || page.translatedDigest || "")}`;
}

function formatRulesForBudget(guide: WorkStyleGuide): string {
  const rules = guide.rules || {};
  return `Rules: honorifics=${rules.honorifics || "adapt"}, sfxMode=${rules.sfxMode || "translate"}, defaultTone=${rules.defaultTone || "natural_korean"}.`;
}

function estimatePromptTokens(text: string): number {
  return Math.ceil(String(text ?? "").length / CHARS_PER_TOKEN_ESTIMATE);
}

function sanitizePromptLine(value: unknown, max = 240): string {
  const text = String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length <= max
    ? text
    : `${text.slice(0, Math.max(0, max - 3))}...`;
}

function normalizeNonNegativeInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}
