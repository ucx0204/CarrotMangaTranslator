import type { ChapterSnapshot } from "../../../shared/libraryTypes";
import type { TranslationBlock } from "../../../shared/textTypes";

export type SearchReplaceScope = "page" | "chapter";
export type SearchReplaceField = "translated" | "source" | "both";

export type SearchReplaceRequest = {
  caseSensitive: boolean;
  field: SearchReplaceField;
  query: string;
  replacement: string;
  scope: SearchReplaceScope;
  useRegex: boolean;
};

export type SearchReplaceMatch = {
  blockId: string;
  count: number;
  field: "translated" | "source";
  pageId: string;
  pageName: string;
  preview: string;
};

export function findSearchReplaceMatches(
  chapter: ChapterSnapshot | null,
  currentPageId: string | null,
  request: SearchReplaceRequest,
): SearchReplaceMatch[] {
  if (!chapter || !request.query) return [];
  const pattern = compileSearchPattern(request);
  const matches: SearchReplaceMatch[] = [];
  for (const page of selectPages(chapter, currentPageId, request.scope)) {
    for (const block of page.blocks) {
      matches.push(...findBlockMatches(page, block, request.field, pattern));
    }
  }
  return matches;
}

function findBlockMatches(
  page: ChapterSnapshot["pages"][number],
  block: TranslationBlock,
  requestedField: SearchReplaceField,
  pattern: RegExp,
): SearchReplaceMatch[] {
  return resolveFields(requestedField).flatMap((field) => {
    const value = field === "source" ? block.sourceText : block.translatedText;
    const count = countMatches(value, pattern);
    return count === 0
      ? []
      : [
          {
            blockId: block.id,
            count,
            field,
            pageId: page.id,
            pageName: page.name,
            preview: createMatchPreview(value, pattern),
          },
        ];
  });
}

export function applySearchReplace(
  chapter: ChapterSnapshot,
  currentPageId: string | null,
  request: SearchReplaceRequest,
): {
  chapter: ChapterSnapshot;
  changedPageIds: string[];
  replacementCount: number;
} {
  if (!request.query) {
    return { chapter, changedPageIds: [], replacementCount: 0 };
  }
  const targetPageIds = new Set(
    selectPages(chapter, currentPageId, request.scope).map((page) => page.id),
  );
  const fields = resolveFields(request.field);
  const pattern = compileSearchPattern(request);
  let replacementCount = 0;
  const changedPageIds: string[] = [];
  const pages = chapter.pages.map((page) => {
    if (!targetPageIds.has(page.id)) return page;
    let pageChanged = false;
    const blocks = page.blocks.map((block) => {
      let next = block;
      for (const field of fields) {
        const property = field === "source" ? "sourceText" : "translatedText";
        const currentValue = next[property];
        const count = countMatches(currentValue, pattern);
        if (count === 0) continue;
        replacementCount += count;
        const value = request.useRegex
          ? currentValue.replace(pattern, request.replacement)
          : currentValue.replace(pattern, () => request.replacement);
        next = { ...next, [property]: value } as TranslationBlock;
        pageChanged = true;
      }
      return next;
    });
    if (!pageChanged) return page;
    changedPageIds.push(page.id);
    return { ...page, blocks, updatedAt: new Date().toISOString() };
  });
  return {
    chapter: changedPageIds.length ? { ...chapter, pages } : chapter,
    changedPageIds,
    replacementCount,
  };
}

export function compileSearchPattern(request: SearchReplaceRequest): RegExp {
  const source = request.useRegex ? request.query : escapeRegExp(request.query);
  return new RegExp(source, request.caseSensitive ? "gu" : "giu");
}

function selectPages(
  chapter: ChapterSnapshot,
  currentPageId: string | null,
  scope: SearchReplaceScope,
) {
  return scope === "chapter"
    ? chapter.pages
    : chapter.pages.filter((page) => page.id === currentPageId);
}

function resolveFields(
  field: SearchReplaceField,
): Array<"translated" | "source"> {
  return field === "both" ? ["source", "translated"] : [field];
}

function countMatches(value: string, pattern: RegExp): number {
  return [...value.matchAll(clonePattern(pattern))].length;
}

function createMatchPreview(value: string, pattern: RegExp): string {
  const match = clonePattern(pattern).exec(value);
  if (!match || match.index === undefined) return value.slice(0, 120);
  const start = Math.max(0, match.index - 45);
  const end = Math.min(value.length, match.index + match[0].length + 75);
  return `${start > 0 ? "…" : ""}${value.slice(start, end)}${
    end < value.length ? "…" : ""
  }`;
}

function clonePattern(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.flags);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
