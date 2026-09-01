/* eslint-disable complexity, max-lines, max-lines-per-function -- the exhaustive typed rule evaluator keeps preview and apply on one deterministic pipeline */
import { resolveBlockStylePresetPatchFields } from "./blockStylePresetFormat";
import {
  formatConditionalBatchFieldValue,
  readConditionalBatchField,
  type ConditionalBatchFieldReadContext,
} from "./conditionalBatchFieldRegistry";
import type { ChapterSnapshot, MangaPage } from "./libraryTypes";
import {
  applyTextStyleToRuns,
  clearTextStylesFromRuns,
  mergeTextStyleRuns,
  parseRichText,
  serializeRichTextRuns,
  type TextStylePatch,
  type TextStyleRun,
} from "./richTextMarkup";
import type { TextEffect, TextGlow, TranslationBlock } from "./textTypes";
import { DEFAULT_TEXT_EFFECT, resolveTextEffect } from "./textEffect";
import { DEFAULT_TEXT_GLOW, resolveTextGlow } from "./textGlow";
import type { GlossaryEntry } from "./workContextTypes";
import {
  createConditionalLiteralMatcher,
  findConditionalTextMatches,
  testConditionalTextMatcher,
  type ConditionalTextMatchRange,
} from "./conditionalTextPattern";
import type {
  ConditionalBatchActionTrace,
  ConditionalBatchActionV2,
  ConditionalBatchApplyResult,
  ConditionalBatchConditionEvaluation,
  ConditionalBatchConditionGroupV2,
  ConditionalBatchConditionV2,
  ConditionalBatchMatchV2,
  ConditionalBatchPreview,
  ConditionalBatchPreviewResult,
  ConditionalBatchReplaceTextActionV2,
  ConditionalBatchSchemeDraftV2,
  ConditionalBatchScope,
  ConditionalBatchSequencePreview,
  ConditionalBatchSequenceV2,
  ConditionalBatchSnapshotV2,
  ConditionalBatchStyleTextActionV2,
  ConditionalBatchTextStyleMatch,
  ConditionalBatchTextStyleMatchCondition,
  ConditionalBatchTextValues,
  ConditionalBatchWritableField,
} from "./conditionalBatchRules";

export type ConditionalBatchEngineOptions = {
  glossary?: readonly GlossaryEntry[];
};

type MatchEvaluation = {
  matched: boolean;
  conditionEvaluations: ConditionalBatchConditionEvaluation[];
};

type AppliedActions = {
  block: TranslationBlock;
  actionTrace: ConditionalBatchActionTrace[];
};

export function evaluateConditionalBatchMatch(
  block: TranslationBlock,
  match: ConditionalBatchMatchV2,
  context: ConditionalBatchFieldReadContext = FALLBACK_READ_CONTEXT,
): MatchEvaluation {
  if (match.mode === "allBlocks") {
    return { matched: true, conditionEvaluations: [] };
  }

  const conditionEvaluations = match.conditions.map((condition) =>
    evaluateConditionalBatchCondition(block, condition, context),
  );
  const directResults = conditionEvaluations
    .filter((evaluation) => evaluation.enabled)
    .map((evaluation) => evaluation.matched);
  const groupResults: boolean[] = [];

  for (const group of match.groups) {
    const groupEvaluations = group.conditions.map((condition) =>
      evaluateConditionalBatchCondition(
        block,
        group.enabled ? condition : { ...condition, enabled: false },
        context,
      ),
    );
    conditionEvaluations.push(...groupEvaluations);
    if (!group.enabled) continue;
    groupResults.push(evaluateConditionGroup(group, groupEvaluations));
  }

  const results = [...directResults, ...groupResults];
  return {
    matched:
      results.length > 0 &&
      (match.mode === "any" ? results.some(Boolean) : results.every(Boolean)),
    conditionEvaluations,
  };
}

export function createConditionalBatchPreview(
  chapter: ChapterSnapshot,
  scope: ConditionalBatchScope,
  scheme: ConditionalBatchSchemeDraftV2,
  options: ConditionalBatchEngineOptions = {},
): ConditionalBatchPreview {
  const results: ConditionalBatchPreviewResult[] = [];
  let matchedCount = 0;
  const inspectionOnly = !scheme.actions.some((action) => action.enabled);
  const orderedPages = selectScopePages(chapter, scope);

  for (const [pageIndex, page] of orderedPages.entries()) {
    const blocks = selectScopeBlocks(page, scope);
    for (const [blockIndex, block] of blocks.entries()) {
      const context: ConditionalBatchFieldReadContext = {
        page,
        pageIndex: resolveChapterPageIndex(chapter, page.id, pageIndex),
        blockIndex: resolvePageBlockIndex(page, block.id, blockIndex),
        glossary: options.glossary,
      };
      const evaluation = evaluateConditionalBatchMatch(
        block,
        scheme.match,
        context,
      );
      if (!evaluation.matched) continue;
      matchedCount += 1;

      const applied = applyConditionalBatchActions(block, scheme.actions);
      const changedFields = resolveChangedFields(block, applied.block);
      const actionTargetFields = resolveActionTargetFields(scheme.actions);
      if (!inspectionOnly && changedFields.length === 0) continue;

      results.push({
        key: createConditionalBatchResultKey(page.id, block.id),
        pageId: page.id,
        pageName: page.name,
        blockId: block.id,
        before: readTextValues(block),
        after: readTextValues(applied.block),
        beforeBlock: cloneBlock(block),
        afterBlock: cloneBlock(applied.block),
        changedFields,
        actionTargetFields,
        conditionEvaluations: evaluation.conditionEvaluations,
        actionTrace: applied.actionTrace,
        conflictFingerprint: createConflictFingerprint(
          block,
          evaluation.conditionEvaluations,
          actionTargetFields,
        ),
      });
    }
  }

  return {
    chapterId: chapter.id,
    matchedCount,
    unchangedMatchCount: inspectionOnly ? 0 : matchedCount - results.length,
    inspectionOnly,
    results,
  };
}

export function createConditionalBatchPreviewPage(
  page: MangaPage,
  preview: ConditionalBatchPreview,
  excludedResultKeys: ReadonlySet<string>,
  showAfter: boolean,
): MangaPage {
  if (!showAfter) return page;
  const changes = new Map(
    preview.results
      .filter(
        (result) =>
          result.pageId === page.id &&
          result.changedFields.length > 0 &&
          !excludedResultKeys.has(result.key),
      )
      .map((result) => [result.blockId, result.afterBlock]),
  );
  if (changes.size === 0) return page;
  return {
    ...page,
    blocks: page.blocks.map((block) => changes.get(block.id) ?? block),
  };
}

export function applyConditionalBatchPreview(
  chapter: ChapterSnapshot,
  scheme: ConditionalBatchSchemeDraftV2,
  preview: ConditionalBatchPreview,
  excludedResultKeys: ReadonlySet<string>,
  timestamp = new Date().toISOString(),
  options: ConditionalBatchEngineOptions = {},
): ConditionalBatchApplyResult {
  if (preview.chapterId !== chapter.id || preview.inspectionOnly) {
    return {
      chapter,
      appliedCount: 0,
      conflictCount:
        preview.chapterId === chapter.id ? 0 : preview.results.length,
      dirtyPageIds: [],
    };
  }

  const resultByKey = new Map(
    preview.results
      .filter((result) => !excludedResultKeys.has(result.key))
      .map((result) => [result.key, result]),
  );
  const counts = { applied: 0, conflicts: 0 };
  const dirtyPageIds: string[] = [];
  const orderedPageIndex = new Map(
    orderChapterPages(chapter).map((page, index) => [page.id, index]),
  );
  const pages = chapter.pages.map((page) =>
    applyPreviewToPage({
      chapter,
      counts,
      dirtyPageIds,
      options,
      page,
      pageIndex: orderedPageIndex.get(page.id) ?? 0,
      resultByKey,
      scheme,
      timestamp,
    }),
  );
  return {
    chapter:
      dirtyPageIds.length === 0
        ? chapter
        : { ...chapter, pages, updatedAt: timestamp },
    appliedCount: counts.applied,
    conflictCount: counts.conflicts,
    dirtyPageIds,
  };
}

export function createConditionalBatchSequencePreview(
  chapter: ChapterSnapshot,
  scope: ConditionalBatchScope,
  sequence: ConditionalBatchSequenceV2,
  snapshot: ConditionalBatchSnapshotV2,
  options: ConditionalBatchEngineOptions = {},
): ConditionalBatchSequencePreview {
  let current = chapter;
  const steps: ConditionalBatchSequencePreview["steps"] = [];
  const traceByResultKey = new Map<
    string,
    NonNullable<ConditionalBatchPreviewResult["sequenceTrace"]>
  >();
  let hasMutatingStep = false;
  for (const step of sequence.steps) {
    if (!step.enabled) continue;
    const scheme = snapshot.schemes.find(
      (candidate) => candidate.id === step.schemeId,
    );
    if (!scheme) {
      throw new Error(`연속 실행 규칙을 찾을 수 없습니다: ${step.schemeId}`);
    }
    const preview = createConditionalBatchPreview(
      current,
      scope,
      scheme,
      options,
    );
    hasMutatingStep ||= !preview.inspectionOnly;
    steps.push({
      stepId: step.id,
      schemeId: scheme.id,
      preview,
    });
    for (const result of preview.results) {
      const trace = traceByResultKey.get(result.key) ?? [];
      trace.push({
        stepId: step.id,
        schemeId: scheme.id,
        schemeName: scheme.name,
        beforeBlock: cloneBlock(result.beforeBlock),
        afterBlock: cloneBlock(result.afterBlock),
        changedFields: [...result.changedFields],
        actionTargetFields: [...result.actionTargetFields],
        conditionEvaluations: result.conditionEvaluations.map((evaluation) => ({
          ...evaluation,
        })),
        actionTrace: result.actionTrace.map((entry) => ({ ...entry })),
        conflictFingerprint: result.conflictFingerprint,
      });
      traceByResultKey.set(result.key, trace);
    }
    current = applyConditionalBatchPreview(
      current,
      scheme,
      preview,
      EMPTY_RESULT_KEYS,
      current.updatedAt,
      options,
    ).chapter;
  }
  const combinedResults: ConditionalBatchPreviewResult[] = [];
  for (const [key, sequenceTrace] of traceByResultKey) {
    const first = sequenceTrace[0];
    const last = sequenceTrace.at(-1);
    if (!first || !last) continue;
    const [pageId, blockId] = parseConditionalBatchResultKey(key);
    const originalPage = chapter.pages.find((page) => page.id === pageId);
    const finalPage = current.pages.find((page) => page.id === pageId);
    const beforeBlock =
      originalPage?.blocks.find((block) => block.id === blockId) ??
      first.beforeBlock;
    const afterBlock =
      finalPage?.blocks.find((block) => block.id === blockId) ??
      last.afterBlock;
    const changedFields = resolveChangedFields(beforeBlock, afterBlock);
    if (hasMutatingStep && changedFields.length === 0) continue;
    const actionTargetFields = uniqueWritableFields(
      sequenceTrace.flatMap((trace) => trace.actionTargetFields),
    );
    combinedResults.push({
      key,
      pageId,
      pageName: originalPage?.name ?? finalPage?.name ?? "",
      blockId,
      before: readTextValues(beforeBlock),
      after: readTextValues(afterBlock),
      beforeBlock: cloneBlock(beforeBlock),
      afterBlock: cloneBlock(afterBlock),
      changedFields,
      actionTargetFields,
      conditionEvaluations: sequenceTrace.flatMap((trace) =>
        trace.conditionEvaluations.map((evaluation) => ({
          ...evaluation,
          conditionId: `${trace.stepId}:${evaluation.conditionId}`,
        })),
      ),
      actionTrace: sequenceTrace.flatMap((trace) =>
        trace.actionTrace.map((entry) => ({
          ...entry,
          stepId: trace.stepId,
          schemeId: trace.schemeId,
          schemeName: trace.schemeName,
        })),
      ),
      conflictFingerprint: JSON.stringify(
        sequenceTrace.map((trace) => [
          trace.stepId,
          trace.schemeId,
          trace.conflictFingerprint,
        ]),
      ),
      sequenceTrace,
    });
  }
  const combinedPreview: ConditionalBatchPreview = {
    chapterId: chapter.id,
    matchedCount: traceByResultKey.size,
    unchangedMatchCount: hasMutatingStep
      ? traceByResultKey.size - combinedResults.length
      : 0,
    inspectionOnly: !hasMutatingStep,
    results: combinedResults,
  };
  return {
    sequenceId: sequence.id,
    chapterId: chapter.id,
    scope: cloneScope(scope),
    steps,
    preview: combinedPreview,
    chapterAfter: current,
  };
}

export function applyConditionalBatchSequencePreview(
  chapter: ChapterSnapshot,
  sequence: ConditionalBatchSequenceV2,
  snapshot: ConditionalBatchSnapshotV2,
  sequencePreview: ConditionalBatchSequencePreview,
  excludedResultKeys: ReadonlySet<string>,
  timestamp = new Date().toISOString(),
  options: ConditionalBatchEngineOptions = {},
): ConditionalBatchApplyResult {
  if (
    sequencePreview.chapterId !== chapter.id ||
    sequencePreview.sequenceId !== sequence.id ||
    sequencePreview.preview.inspectionOnly
  ) {
    return {
      chapter,
      appliedCount: 0,
      conflictCount:
        sequencePreview.chapterId === chapter.id &&
        sequencePreview.sequenceId === sequence.id
          ? 0
          : sequencePreview.preview.results.length,
      dirtyPageIds: [],
    };
  }
  const fresh = createConditionalBatchSequencePreview(
    chapter,
    sequencePreview.scope,
    sequence,
    snapshot,
    options,
  );
  const freshByKey = new Map(
    fresh.preview.results.map((result) => [result.key, result]),
  );
  const requested = new Map(
    sequencePreview.preview.results
      .filter((result) => !excludedResultKeys.has(result.key))
      .map((result) => [result.key, result]),
  );
  const counts = { applied: 0, conflicts: 0 };
  const dirtyPageIds: string[] = [];
  const pages = chapter.pages.map((page) => {
    let changed = false;
    const blocks = page.blocks.map((block) => {
      const key = createConditionalBatchResultKey(page.id, block.id);
      const expected = requested.get(key);
      if (!expected) return block;
      const current = freshByKey.get(key);
      if (
        !current ||
        current.conflictFingerprint !== expected.conflictFingerprint ||
        !sameChangedFields(current.changedFields, expected.changedFields) ||
        expected.changedFields.some(
          (field) =>
            !sameValue(
              readConditionalBatchWritableValue(current.afterBlock, field),
              readConditionalBatchWritableValue(expected.afterBlock, field),
            ),
        )
      ) {
        counts.conflicts += 1;
        return block;
      }
      counts.applied += 1;
      changed = true;
      return current.afterBlock;
    });
    if (!changed) return page;
    dirtyPageIds.push(page.id);
    return { ...page, blocks, updatedAt: timestamp };
  });
  return {
    chapter:
      dirtyPageIds.length === 0
        ? chapter
        : { ...chapter, pages, updatedAt: timestamp },
    appliedCount: counts.applied,
    conflictCount: counts.conflicts,
    dirtyPageIds,
  };
}

function applyConditionalBatchActions(
  block: TranslationBlock,
  actions: readonly ConditionalBatchActionV2[],
): AppliedActions {
  let updated = block;
  const actionTrace: ConditionalBatchActionTrace[] = [];
  const orderedActions = actions
    .map((action, index) => ({ action, index }))
    .filter(({ action }) => action.enabled)
    .sort(
      (left, right) =>
        actionStage(left.action) - actionStage(right.action) ||
        left.index - right.index,
    );

  for (const { action } of orderedActions) {
    const before = updated;
    updated = applyConditionalBatchAction(updated, action);
    const changedFields = resolveChangedFields(before, updated);
    actionTrace.push({
      actionId: action.id,
      actionType: action.type,
      changedFields,
    });
  }
  return { block: updated, actionTrace };
}

function applyConditionalBatchAction(
  block: TranslationBlock,
  action: ConditionalBatchActionV2,
): TranslationBlock {
  if (action.type === "replaceText") {
    return applyReplaceTextAction(block, action);
  }
  if (action.type === "setFields") {
    return action.changes.reduce(applySetFieldChange, block);
  }
  if (action.type === "applyStylePreset") {
    const patch = resolveBlockStylePresetPatchFields(
      { groupIds: action.groupIds, format: action.format },
      {},
    );
    return applyBlockPatch(block, patch);
  }
  return applyStyleTextAction(block, action);
}

function applyReplaceTextAction(
  block: TranslationBlock,
  action: ConditionalBatchReplaceTextActionV2,
): TranslationBlock {
  let updated = block;
  if (action.target === "sourceText" || action.target === "both") {
    const sourceText = replacePlainText(block.sourceText, action);
    if (sourceText !== updated.sourceText) updated = { ...updated, sourceText };
  }
  if (action.target === "translatedText" || action.target === "both") {
    const translatedText = replaceRichTextVisible(
      updated.translatedText,
      action,
    );
    if (translatedText !== updated.translatedText) {
      updated = { ...updated, translatedText };
    }
  }
  return updated;
}

function applySetFieldChange(
  block: TranslationBlock,
  change: {
    field: ConditionalBatchWritableField;
    operation: "set" | "clear";
    value?: string | number | boolean | string[] | null;
  },
): TranslationBlock {
  if (TEXT_EFFECT_WRITABLE_FIELDS.has(change.field)) {
    return applyTextEffectFieldChange(block, change);
  }
  if (TEXT_GLOW_WRITABLE_FIELDS.has(change.field)) {
    return applyTextGlowFieldChange(block, change);
  }
  const updated = { ...block } as TranslationBlock & Record<string, unknown>;
  if (change.operation === "clear") {
    delete updated[change.field];
    return updated;
  }
  const normalized = normalizeWritableValue(change.field, change.value);
  if (normalized === INVALID_VALUE) return block;
  (updated as Record<string, unknown>)[change.field] = normalized;
  if (change.field === "renderDirection") {
    delete updated.layoutIntent;
    updated.layoutIntentSuppressed = true;
  }
  if (change.field === "outlineWidthPx") delete updated.outlineWidthScale;
  if (change.field === "outlineWidthScale") delete updated.outlineWidthPx;
  return updated;
}

function applyStyleTextAction(
  block: TranslationBlock,
  action: ConditionalBatchStyleTextActionV2,
): TranslationBlock {
  const parsed = parseRichText(block.translatedText);
  if (parsed.plainText.length === 0) return block;
  const matcher =
    action.scope === "allText"
      ? createConditionalLiteralMatcher(parsed.plainText)
      : action.matcher;
  if (!matcher) return block;
  const ranges = findConditionalTextMatches(
    parsed.plainText,
    matcher,
    null,
    action.scope === "allText" || action.allOccurrences,
  );
  if (ranges.length === 0) return block;
  const styleRanges = action.matchStyle
    ? intersectTextRangesWithMatchingStyles(
        parsed.runs,
        ranges,
        action.matchStyle,
      )
    : ranges;
  if (styleRanges.length === 0) return block;

  let runs = parsed.runs;
  for (const range of [...styleRanges].reverse()) {
    if (action.styleMode === "replace") {
      runs = clearTextStylesFromRuns(runs, range.start, range.end);
      runs = applyTextStyleToRuns(runs, range.start, range.end, action.patch);
    } else if (action.styleMode === "fillMissing") {
      runs = fillMissingStyles(runs, range.start, range.end, action.patch);
    } else {
      runs = applyTextStyleToRuns(runs, range.start, range.end, action.patch);
    }
  }
  const translatedText = serializeRichTextRuns(runs);
  return translatedText === block.translatedText
    ? block
    : { ...block, translatedText };
}

type TextRange = { start: number; end: number };

function intersectTextRangesWithMatchingStyles(
  runs: readonly TextStyleRun[],
  ranges: readonly ConditionalTextMatchRange[],
  matchStyle: ConditionalBatchTextStyleMatch,
): TextRange[] {
  const result: TextRange[] = [];
  let runStart = 0;
  for (const run of runs) {
    const runEnd = runStart + run.text.length;
    if (!matchesExistingTextStyle(run, matchStyle)) {
      runStart = runEnd;
      continue;
    }
    for (const range of ranges) {
      const start = Math.max(runStart, range.start);
      const end = Math.min(runEnd, range.end);
      if (start >= end) continue;
      const previous = result.at(-1);
      if (previous && previous.end === start) previous.end = end;
      else result.push({ start, end });
    }
    runStart = runEnd;
  }
  return result;
}

function matchesExistingTextStyle(
  run: TextStyleRun,
  matchStyle: ConditionalBatchTextStyleMatch,
): boolean {
  const results = matchStyle.conditions.map((condition) =>
    matchesTextStyleCondition(run, condition),
  );
  return matchStyle.logic === "all"
    ? results.every(Boolean)
    : results.some(Boolean);
}

function matchesTextStyleCondition(
  run: TextStyleRun,
  condition: ConditionalBatchTextStyleMatchCondition,
): boolean {
  const actual = readTextStyleValue(run, condition.field);
  if (actual === undefined) return false;
  if (condition.operator === "equals") return actual === condition.value;
  if (condition.operator === "notEquals") return actual !== condition.value;
  if (typeof actual !== "number" || typeof condition.value !== "number") {
    return false;
  }
  if (condition.operator === "greaterThan") {
    return actual > condition.value;
  }
  if (condition.operator === "greaterThanOrEqual") {
    return actual >= condition.value;
  }
  if (condition.operator === "lessThan") return actual < condition.value;
  if (condition.operator === "lessThanOrEqual") {
    return actual <= condition.value;
  }
  if (condition.operator === "between") {
    if (condition.value2 === undefined) return false;
    const minimum = Math.min(condition.value, condition.value2);
    const maximum = Math.max(condition.value, condition.value2);
    return actual >= minimum && actual <= maximum;
  }
  return false;
}

function readTextStyleValue(
  run: TextStyleRun,
  field: ConditionalBatchTextStyleMatchCondition["field"],
): boolean | string | number | undefined {
  if (field === "bold") return run.bold;
  if (field === "italic") return run.italic;
  return run[field];
}

function replacePlainText(
  value: string,
  action: ConditionalBatchReplaceTextActionV2,
): string {
  const ranges = findConditionalTextMatches(
    value,
    action.matcher,
    action.replacement,
    action.allOccurrences,
  );
  if (ranges.length === 0) return value;
  return replaceTextRanges(value, ranges);
}

function replaceRichTextVisible(
  value: string,
  action: ConditionalBatchReplaceTextActionV2,
): string {
  const parsed = parseRichText(value);
  const ranges = findConditionalTextMatches(
    parsed.plainText,
    action.matcher,
    action.replacement,
    action.allOccurrences,
  );
  if (ranges.length === 0) return value;

  const result: TextStyleRun[] = [];
  let cursor = 0;
  for (const range of ranges) {
    result.push(...sliceRuns(parsed.runs, cursor, range.start));
    if (range.replacement) {
      result.push({
        text: range.replacement,
        ...resolveInsertionStyle(parsed.runs, range.start, range.end),
      });
    }
    cursor = range.end;
  }
  result.push(...sliceRuns(parsed.runs, cursor, parsed.plainText.length));
  return serializeRichTextRuns(mergeTextStyleRuns(result));
}

function replaceTextRanges(
  value: string,
  ranges: readonly ConditionalTextMatchRange[],
): string {
  let result = "";
  let cursor = 0;
  for (const range of ranges) {
    result += value.slice(cursor, range.start) + range.replacement;
    cursor = range.end;
  }
  return result + value.slice(cursor);
}

function sliceRuns(
  runs: readonly TextStyleRun[],
  start: number,
  end: number,
): TextStyleRun[] {
  if (start >= end) return [];
  const result: TextStyleRun[] = [];
  let offset = 0;
  for (const run of runs) {
    const runEnd = offset + run.text.length;
    const from = Math.max(start, offset);
    const to = Math.min(end, runEnd);
    if (from < to) {
      result.push({
        ...run,
        text: run.text.slice(from - offset, to - offset),
      });
    }
    offset = runEnd;
    if (offset >= end) break;
  }
  return result;
}

function resolveInsertionStyle(
  runs: readonly TextStyleRun[],
  start: number,
  end: number,
): Omit<TextStyleRun, "text"> {
  let offset = 0;
  let previous: TextStyleRun | undefined;
  for (const run of runs) {
    const runEnd = offset + run.text.length;
    if (
      (end > start && start >= offset && start < runEnd) ||
      (end === start && start >= offset && start < runEnd)
    ) {
      const { text: _text, ...style } = run;
      return style;
    }
    if (runEnd <= start) previous = run;
    offset = runEnd;
  }
  const source = previous ?? runs[0] ?? DEFAULT_TEXT_RUN;
  const { text: _text, ...style } = source;
  return style;
}

function fillMissingStyles(
  runs: readonly TextStyleRun[],
  start: number,
  end: number,
  patch: TextStylePatch,
): TextStyleRun[] {
  let updated = [...runs];
  let offset = 0;
  for (const run of runs) {
    const runEnd = offset + run.text.length;
    const from = Math.max(start, offset);
    const to = Math.min(end, runEnd);
    if (from < to) {
      const fillPatch = buildMissingStylePatch(run, patch);
      if (Object.keys(fillPatch).length > 0) {
        updated = applyTextStyleToRuns(updated, from, to, fillPatch);
      }
    }
    offset = runEnd;
  }
  return updated;
}

function buildMissingStylePatch(
  run: TextStyleRun,
  patch: TextStylePatch,
): TextStylePatch {
  const result: TextStylePatch = {};
  for (const key of TEXT_STYLE_PATCH_FIELDS) {
    const value = patch[key];
    if (value === undefined || value === null) continue;
    const current = run[key];
    const missing = TEXT_STYLE_BOOLEAN_FIELDS.has(key)
      ? !current
      : current === undefined;
    if (missing) Object.assign(result, { [key]: value });
  }
  return result;
}

const TEXT_STYLE_PATCH_FIELDS = [
  "bold",
  "italic",
  "underline",
  "strikethrough",
  "emphasisMark",
  "sizePx",
  "fontFamily",
  "opacity",
  "widthScale",
  "color",
  "backgroundColor",
  "outlineColor",
  "outlineWidthPx",
  "outerOutlineColor",
  "outerOutlineWidthPx",
  "glowColor",
  "glowBlurPx",
  "glowOpacity",
] as const satisfies readonly (keyof TextStylePatch & keyof TextStyleRun)[];

const TEXT_STYLE_BOOLEAN_FIELDS = new Set<keyof TextStylePatch>([
  "bold",
  "italic",
  "underline",
  "strikethrough",
  "emphasisMark",
]);

function evaluateConditionGroup(
  group: ConditionalBatchConditionGroupV2,
  evaluations: readonly ConditionalBatchConditionEvaluation[],
): boolean {
  const active = evaluations.filter((evaluation) => evaluation.enabled);
  return (
    active.length > 0 &&
    (group.logic === "any"
      ? active.some((evaluation) => evaluation.matched)
      : active.every((evaluation) => evaluation.matched))
  );
}

function evaluateConditionalBatchCondition(
  block: TranslationBlock,
  condition: ConditionalBatchConditionV2,
  context: ConditionalBatchFieldReadContext,
): ConditionalBatchConditionEvaluation {
  const rawValue = readConditionalBatchField(block, condition.field, context);
  return {
    conditionId: condition.id,
    field: condition.field,
    actualValue: formatConditionalBatchFieldValue(rawValue),
    rawValue,
    matched: condition.enabled
      ? resolveConditionMatched(rawValue, condition)
      : false,
    enabled: condition.enabled,
  };
}

function resolveConditionMatched(
  actualValue: string | number | boolean | undefined,
  condition: ConditionalBatchConditionV2,
): boolean {
  const operator = condition.operator;
  if (operator === "isTrue" || operator === "isFalse") {
    return operator === "isTrue" ? actualValue === true : actualValue === false;
  }
  if (operator === "empty" || operator === "notEmpty") {
    const empty =
      actualValue === undefined ||
      (typeof actualValue === "string" && actualValue.trim().length === 0);
    return operator === "empty" ? empty : !empty;
  }
  if (operator === "oneOf" || operator === "notOneOf") {
    const included =
      Array.isArray(condition.value) &&
      condition.value.includes(String(actualValue ?? ""));
    return operator === "oneOf" ? included : !included;
  }
  if (typeof actualValue === "number") {
    return compareNumber(actualValue, condition);
  }
  if (operator === "near") {
    return (
      typeof actualValue === "string" &&
      typeof condition.value === "string" &&
      colorDistancePercent(actualValue, condition.value) <=
        (condition.tolerance ?? 0)
    );
  }
  const actual = String(actualValue ?? "");
  const expected = String(condition.value ?? "");
  switch (operator) {
    case "contains":
      return actual.includes(expected);
    case "notContains":
      return !actual.includes(expected);
    case "equals":
      return actual === expected;
    case "notEquals":
      return actual !== expected;
    case "startsWith":
      return actual.startsWith(expected);
    case "endsWith":
      return actual.endsWith(expected);
    case "regex":
      return condition.matcher
        ? testConditionalTextMatcher(actual, condition.matcher)
        : false;
    case "notRegex":
      return condition.matcher
        ? !testConditionalTextMatcher(actual, condition.matcher)
        : false;
    default:
      return false;
  }
}

function compareNumber(
  actual: number,
  condition: ConditionalBatchConditionV2,
): boolean {
  const expected =
    typeof condition.value === "number" ? condition.value : Number.NaN;
  switch (condition.operator) {
    case "equals":
      return actual === expected;
    case "notEquals":
      return actual !== expected;
    case "greaterThan":
      return actual > expected;
    case "greaterThanOrEqual":
      return actual >= expected;
    case "lessThan":
      return actual < expected;
    case "lessThanOrEqual":
      return actual <= expected;
    case "between": {
      const other = condition.value2 ?? expected;
      return (
        actual >= Math.min(expected, other) &&
        actual <= Math.max(expected, other)
      );
    }
    default:
      return false;
  }
}

function colorDistancePercent(left: string, right: string): number {
  const leftRgb = parseHexColor(left);
  const rightRgb = parseHexColor(right);
  if (!leftRgb || !rightRgb) return Number.POSITIVE_INFINITY;
  const distance = Math.hypot(
    leftRgb[0] - rightRgb[0],
    leftRgb[1] - rightRgb[1],
    leftRgb[2] - rightRgb[2],
  );
  return (distance / Math.hypot(255, 255, 255)) * 100;
}

function parseHexColor(value: string): [number, number, number] | null {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/iu.exec(value);
  return match
    ? [
        Number.parseInt(match[1], 16),
        Number.parseInt(match[2], 16),
        Number.parseInt(match[3], 16),
      ]
    : null;
}

function applyPreviewToPage({
  chapter,
  counts,
  dirtyPageIds,
  options,
  page,
  pageIndex,
  resultByKey,
  scheme,
  timestamp,
}: {
  chapter: ChapterSnapshot;
  counts: { applied: number; conflicts: number };
  dirtyPageIds: string[];
  options: ConditionalBatchEngineOptions;
  page: MangaPage;
  pageIndex: number;
  resultByKey: ReadonlyMap<string, ConditionalBatchPreviewResult>;
  scheme: ConditionalBatchSchemeDraftV2;
  timestamp: string;
}): MangaPage {
  let pageChanged = false;
  const orderedBlockIndex = new Map(
    orderPageBlocks(page).map((block, index) => [block.id, index]),
  );
  const blocks = page.blocks.map((block) => {
    const result = resultByKey.get(
      createConditionalBatchResultKey(page.id, block.id),
    );
    if (!result) return block;
    const context: ConditionalBatchFieldReadContext = {
      page,
      pageIndex: resolveChapterPageIndex(chapter, page.id, pageIndex),
      blockIndex: orderedBlockIndex.get(block.id) ?? 0,
      glossary: options.glossary,
    };
    const currentMatch = evaluateConditionalBatchMatch(
      block,
      scheme.match,
      context,
    );
    const currentApplied = applyConditionalBatchActions(block, scheme.actions);
    if (
      !currentMatch.matched ||
      !sameConditionInputs(
        currentMatch.conditionEvaluations,
        result.conditionEvaluations,
      ) ||
      !sameChangedFields(
        resolveChangedFields(block, currentApplied.block),
        result.changedFields,
      ) ||
      result.actionTargetFields.some(
        (field) =>
          !sameValue(
            readConditionalBatchWritableValue(block, field),
            readConditionalBatchWritableValue(result.beforeBlock, field),
          ),
      ) ||
      result.changedFields.some(
        (field) =>
          !sameValue(
            readConditionalBatchWritableValue(block, field),
            readConditionalBatchWritableValue(result.beforeBlock, field),
          ) ||
          !sameValue(
            readConditionalBatchWritableValue(currentApplied.block, field),
            readConditionalBatchWritableValue(result.afterBlock, field),
          ),
      )
    ) {
      counts.conflicts += 1;
      return block;
    }
    counts.applied += 1;
    pageChanged = true;
    return currentApplied.block;
  });
  if (!pageChanged) return page;
  dirtyPageIds.push(page.id);
  return { ...page, blocks, updatedAt: timestamp };
}

function sameConditionInputs(
  current: readonly ConditionalBatchConditionEvaluation[],
  previewed: readonly ConditionalBatchConditionEvaluation[],
): boolean {
  if (current.length !== previewed.length) return false;
  const previewById = new Map(
    previewed.map((evaluation) => [evaluation.conditionId, evaluation]),
  );
  return current.every((evaluation) => {
    const previous = previewById.get(evaluation.conditionId);
    return (
      previous !== undefined &&
      previous.enabled === evaluation.enabled &&
      sameValue(previous.rawValue, evaluation.rawValue)
    );
  });
}

function resolveChangedFields(
  before: TranslationBlock,
  after: TranslationBlock,
): ConditionalBatchWritableField[] {
  return WRITABLE_FIELDS.filter(
    (field) =>
      !sameValue(
        readConditionalBatchWritableValue(before, field),
        readConditionalBatchWritableValue(after, field),
      ),
  );
}

function sameChangedFields(
  left: readonly ConditionalBatchWritableField[],
  right: readonly ConditionalBatchWritableField[],
): boolean {
  return (
    left.length === right.length && left.every((field) => right.includes(field))
  );
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  return JSON.stringify(left) === JSON.stringify(right);
}

function applyBlockPatch(
  block: TranslationBlock,
  patch: Partial<TranslationBlock>,
): TranslationBlock {
  const next = { ...block, ...patch };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete (next as Record<string, unknown>)[key];
  }
  if (patch.renderDirection !== undefined) {
    delete next.layoutIntent;
    next.layoutIntentSuppressed = true;
  }
  return next;
}

function normalizeWritableValue(
  field: ConditionalBatchWritableField,
  value: unknown,
): string | number | boolean | typeof INVALID_VALUE {
  if (STRING_FIELDS.has(field)) {
    return typeof value === "string" ? value : INVALID_VALUE;
  }
  if (NUMBER_FIELDS.has(field)) {
    return typeof value === "number" && Number.isFinite(value)
      ? value
      : INVALID_VALUE;
  }
  if (BOOLEAN_FIELDS.has(field)) {
    return typeof value === "boolean" ? value : INVALID_VALUE;
  }
  return INVALID_VALUE;
}

function actionStage(action: ConditionalBatchActionV2): number {
  if (action.type === "setFields" || action.type === "applyStylePreset") {
    return 0;
  }
  return action.type === "replaceText" ? 1 : 2;
}

function readTextValues(block: TranslationBlock): ConditionalBatchTextValues {
  return {
    sourceText: block.sourceText,
    translatedText: block.translatedText,
  };
}

function cloneBlock(block: TranslationBlock): TranslationBlock {
  return structuredClone(block);
}

function createConditionalBatchResultKey(
  pageId: string,
  blockId: string,
): string {
  return JSON.stringify([pageId, blockId]);
}

function parseConditionalBatchResultKey(key: string): [string, string] {
  const value = JSON.parse(key) as unknown;
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    typeof value[0] !== "string" ||
    typeof value[1] !== "string"
  ) {
    throw new Error("일괄 편집 결과 키가 올바르지 않습니다.");
  }
  return [value[0], value[1]];
}

function cloneScope(scope: ConditionalBatchScope): ConditionalBatchScope {
  return scope.kind === "selection"
    ? { ...scope, blockIds: [...scope.blockIds] }
    : { ...scope };
}

function createConflictFingerprint(
  block: TranslationBlock,
  evaluations: readonly ConditionalBatchConditionEvaluation[],
  actionTargetFields: readonly ConditionalBatchWritableField[],
): string {
  return JSON.stringify({
    conditions: evaluations.map((evaluation) => [
      evaluation.conditionId,
      evaluation.enabled,
      evaluation.rawValue,
    ]),
    actionTargets: actionTargetFields.map((field) => [
      field,
      readConditionalBatchWritableValue(block, field),
    ]),
  });
}

function resolveActionTargetFields(
  actions: readonly ConditionalBatchActionV2[],
): ConditionalBatchWritableField[] {
  const fields: ConditionalBatchWritableField[] = [];
  for (const action of actions) {
    if (!action.enabled) continue;
    if (action.type === "replaceText") {
      if (action.target === "sourceText" || action.target === "both") {
        fields.push("sourceText");
      }
      if (action.target === "translatedText" || action.target === "both") {
        fields.push("translatedText");
      }
      continue;
    }
    if (action.type === "setFields") {
      fields.push(...action.changes.map((change) => change.field));
      continue;
    }
    if (action.type === "styleText") {
      fields.push("translatedText");
      continue;
    }
    const patch = resolveBlockStylePresetPatchFields(
      { groupIds: action.groupIds, format: action.format },
      {},
    );
    fields.push(...WRITABLE_FIELDS.filter((field) => field in patch));
    if (patch.textEffect !== undefined) {
      fields.push(...TEXT_EFFECT_WRITABLE_FIELD_LIST);
    }
    if (patch.textGlow !== undefined) {
      fields.push(...TEXT_GLOW_WRITABLE_FIELD_LIST);
    }
  }
  return uniqueWritableFields(fields);
}

function uniqueWritableFields(
  fields: readonly ConditionalBatchWritableField[],
): ConditionalBatchWritableField[] {
  return [...new Set(fields)];
}

export function readConditionalBatchWritableValue(
  block: TranslationBlock,
  field: ConditionalBatchWritableField,
): unknown {
  switch (field) {
    case "textEffectEnabled":
      return Boolean(block.textEffect?.enabled);
    case "textEffectColor":
      return block.textEffect?.color;
    case "textEffectOffsetX":
      return block.textEffect?.offsetXpx;
    case "textEffectOffsetY":
      return block.textEffect?.offsetYpx;
    case "textEffectBlur":
      return block.textEffect?.blurPx;
    case "textEffectOpacity":
      return block.textEffect?.opacity;
    case "textGlowEnabled":
      return Boolean(block.textGlow?.enabled);
    case "textGlowColor":
      return block.textGlow?.color;
    case "textGlowBlur":
      return block.textGlow?.blurPx;
    case "textGlowOpacity":
      return block.textGlow?.opacity;
    default:
      return block[field];
  }
}

function applyTextEffectFieldChange(
  block: TranslationBlock,
  change: {
    field: ConditionalBatchWritableField;
    operation: "set" | "clear";
    value?: string | number | boolean | string[] | null;
  },
): TranslationBlock {
  if (!TEXT_EFFECT_WRITABLE_FIELDS.has(change.field)) return block;
  if (change.operation === "clear" && change.field === "textEffectEnabled") {
    if (block.textEffect === undefined) return block;
    const next = { ...block };
    delete next.textEffect;
    return next;
  }
  const effect = resolveTextEffect(block.textEffect);
  const property = TEXT_EFFECT_PROPERTY_BY_FIELD[change.field];
  if (!property) return block;
  const value =
    change.operation === "clear"
      ? DEFAULT_TEXT_EFFECT[property]
      : normalizeWritableValue(change.field, change.value);
  if (value === INVALID_VALUE) return block;
  return {
    ...block,
    textEffect: { ...effect, [property]: value },
  };
}

function applyTextGlowFieldChange(
  block: TranslationBlock,
  change: {
    field: ConditionalBatchWritableField;
    operation: "set" | "clear";
    value?: string | number | boolean | string[] | null;
  },
): TranslationBlock {
  if (!TEXT_GLOW_WRITABLE_FIELDS.has(change.field)) return block;
  if (change.operation === "clear" && change.field === "textGlowEnabled") {
    if (block.textGlow === undefined) return block;
    const next = { ...block };
    delete next.textGlow;
    return next;
  }
  const glow = resolveTextGlow(block.textGlow);
  const property = TEXT_GLOW_PROPERTY_BY_FIELD[change.field];
  if (!property) return block;
  const value =
    change.operation === "clear"
      ? DEFAULT_TEXT_GLOW[property]
      : normalizeWritableValue(change.field, change.value);
  if (value === INVALID_VALUE) return block;
  return { ...block, textGlow: { ...glow, [property]: value } };
}

function selectScopePages(
  chapter: ChapterSnapshot,
  scope: ConditionalBatchScope,
): MangaPage[] {
  const orderedPages = orderChapterPages(chapter);
  return scope.kind === "chapter"
    ? orderedPages
    : orderedPages.filter((page) => page.id === scope.pageId);
}

function selectScopeBlocks(
  page: MangaPage,
  scope: ConditionalBatchScope,
): TranslationBlock[] {
  const orderedBlocks = orderPageBlocks(page);
  if (scope.kind !== "selection" || scope.pageId !== page.id) {
    return orderedBlocks;
  }
  const selected = new Set(scope.blockIds);
  return orderedBlocks.filter((block) => selected.has(block.id));
}

function orderChapterPages(chapter: ChapterSnapshot): MangaPage[] {
  const pageById = new Map(chapter.pages.map((page) => [page.id, page]));
  const ordered = chapter.pageOrder
    .map((pageId) => pageById.get(pageId))
    .filter((page): page is MangaPage => Boolean(page));
  for (const page of chapter.pages) {
    if (!chapter.pageOrder.includes(page.id)) ordered.push(page);
  }
  return ordered;
}

function orderPageBlocks(page: MangaPage): TranslationBlock[] {
  if (!page.blockOrder?.length) return page.blocks;
  const blockById = new Map(page.blocks.map((block) => [block.id, block]));
  const ordered = page.blockOrder
    .map((blockId) => blockById.get(blockId))
    .filter((block): block is TranslationBlock => Boolean(block));
  for (const block of page.blocks) {
    if (!page.blockOrder.includes(block.id)) ordered.push(block);
  }
  return ordered;
}

function resolveChapterPageIndex(
  chapter: ChapterSnapshot,
  pageId: string,
  fallback: number,
): number {
  const index = chapter.pageOrder.indexOf(pageId);
  return index >= 0 ? index : fallback;
}

function resolvePageBlockIndex(
  page: MangaPage,
  blockId: string,
  fallback: number,
): number {
  const index = page.blockOrder?.indexOf(blockId) ?? -1;
  return index >= 0 ? index : fallback;
}

const WRITABLE_FIELDS: readonly ConditionalBatchWritableField[] = [
  "sourceText",
  "translatedText",
  "fontFamily",
  "speakerId",
  "reviewNote",
  "textRole",
  "fontRole",
  "renderDirection",
  "textAlign",
  "wordBreak",
  "reviewStatus",
  "fontSizePx",
  "lineHeight",
  "letterSpacing",
  "fontWidthScale",
  "rotationDeg",
  "textOpacity",
  "outlineWidthPx",
  "outlineWidthScale",
  "outerOutlineWidthPx",
  "textColor",
  "outlineColor",
  "outerOutlineColor",
  "textBackgroundColor",
  "bold",
  "italic",
  "underline",
  "strikethrough",
  "emphasisMark",
  "textBackgroundEnabled",
  "autoFitText",
  "inpaintExcluded",
  "textEffectEnabled",
  "textEffectColor",
  "textEffectOffsetX",
  "textEffectOffsetY",
  "textEffectBlur",
  "textEffectOpacity",
  "textGlowEnabled",
  "textGlowColor",
  "textGlowBlur",
  "textGlowOpacity",
];

const STRING_FIELDS = new Set<ConditionalBatchWritableField>([
  "sourceText",
  "translatedText",
  "fontFamily",
  "speakerId",
  "reviewNote",
  "textRole",
  "fontRole",
  "renderDirection",
  "textAlign",
  "wordBreak",
  "reviewStatus",
  "textColor",
  "outlineColor",
  "outerOutlineColor",
  "textBackgroundColor",
  "textEffectColor",
  "textGlowColor",
]);

const NUMBER_FIELDS = new Set<ConditionalBatchWritableField>([
  "fontSizePx",
  "lineHeight",
  "letterSpacing",
  "fontWidthScale",
  "rotationDeg",
  "textOpacity",
  "outlineWidthPx",
  "outlineWidthScale",
  "outerOutlineWidthPx",
  "textEffectOffsetX",
  "textEffectOffsetY",
  "textEffectBlur",
  "textEffectOpacity",
  "textGlowBlur",
  "textGlowOpacity",
]);

const BOOLEAN_FIELDS = new Set<ConditionalBatchWritableField>([
  "bold",
  "italic",
  "underline",
  "strikethrough",
  "emphasisMark",
  "textBackgroundEnabled",
  "autoFitText",
  "inpaintExcluded",
  "textEffectEnabled",
  "textGlowEnabled",
]);

const TEXT_EFFECT_WRITABLE_FIELD_LIST = [
  "textEffectEnabled",
  "textEffectColor",
  "textEffectOffsetX",
  "textEffectOffsetY",
  "textEffectBlur",
  "textEffectOpacity",
] as const satisfies readonly ConditionalBatchWritableField[];

const TEXT_EFFECT_WRITABLE_FIELDS = new Set<ConditionalBatchWritableField>(
  TEXT_EFFECT_WRITABLE_FIELD_LIST,
);

const TEXT_EFFECT_PROPERTY_BY_FIELD: Partial<
  Record<ConditionalBatchWritableField, keyof TextEffect>
> = {
  textEffectEnabled: "enabled",
  textEffectColor: "color",
  textEffectOffsetX: "offsetXpx",
  textEffectOffsetY: "offsetYpx",
  textEffectBlur: "blurPx",
  textEffectOpacity: "opacity",
};

const TEXT_GLOW_WRITABLE_FIELD_LIST = [
  "textGlowEnabled",
  "textGlowColor",
  "textGlowBlur",
  "textGlowOpacity",
] as const satisfies readonly ConditionalBatchWritableField[];

const TEXT_GLOW_WRITABLE_FIELDS = new Set<ConditionalBatchWritableField>(
  TEXT_GLOW_WRITABLE_FIELD_LIST,
);

const TEXT_GLOW_PROPERTY_BY_FIELD: Partial<
  Record<ConditionalBatchWritableField, keyof TextGlow>
> = {
  textGlowEnabled: "enabled",
  textGlowColor: "color",
  textGlowBlur: "blurPx",
  textGlowOpacity: "opacity",
};

const INVALID_VALUE = Symbol("invalid-conditional-batch-value");
const EMPTY_RESULT_KEYS = new Set<string>();
const DEFAULT_TEXT_RUN: TextStyleRun = {
  text: "",
  bold: false,
  italic: false,
};
const FALLBACK_READ_CONTEXT: ConditionalBatchFieldReadContext = {
  page: { width: 1_000, height: 1_000 } as MangaPage,
  pageIndex: 0,
  blockIndex: 0,
};
