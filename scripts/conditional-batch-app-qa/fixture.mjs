/* eslint-disable @typescript-eslint/ban-ts-comment -- compiled schemas validate the fixture boundary at runtime */
// @ts-nocheck -- compiled production schemas validate this deliberately schema-flexible 100-case fixture at runtime.
/* eslint-disable max-lines -- the exhaustive 100-case fixture is kept declarative so every app-tested condition and action remains auditable */
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { extname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const FIXTURE_TIME = "2026-09-01T00:00:00.000Z";
const WORK_ID = "10000000-0000-4000-8000-000000000001";
const CHAPTER_ID = "20000000-0000-4000-8000-000000000001";
const WORK_TITLE = "일관 편집 앱 QA";
const CHAPTER_TITLE = "100개 조합 자동 검증";
const CASE_COUNT = 100;

export async function createConditionalBatchAppFixture({
  sourceRoot,
  runRoot,
}) {
  const runtime = loadRuntime(sourceRoot);
  const source = await findSourcePage(sourceRoot);
  const caseSpecs = createCaseSpecs(runtime);
  if (caseSpecs.length !== CASE_COUNT) {
    throw new Error(`Expected ${CASE_COUNT} cases; got ${caseSpecs.length}.`);
  }

  const chapterDir = join(
    runRoot,
    "library",
    "works",
    WORK_ID,
    "chapters",
    CHAPTER_ID,
  );
  const pagesDir = join(chapterDir, "pages");
  await mkdir(pagesDir, { recursive: true });
  const sourceExtension =
    extname(source.page.imagePath).toLowerCase() || ".png";
  const fixtureImagePath = join(pagesDir, `qa-source${sourceExtension}`);
  await copyFile(source.page.imagePath, fixtureImagePath);

  const pages = [];
  const schemes = [];
  for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
    const pageId = `30000000-0000-4000-8000-${pad(pageIndex + 1, 12)}`;
    const page = createPage({
      fixtureImagePath,
      pageId,
      pageIndex,
      sourcePage: source.page,
    });
    for (let blockIndex = 0; blockIndex < 10; blockIndex += 1) {
      const caseIndex = pageIndex * 10 + blockIndex;
      const spec = caseSpecs[caseIndex];
      if (!spec) throw new Error(`Missing case ${caseIndex + 1}.`);
      const block = createBlock({
        baseBlock: source.block,
        blockIndex,
        caseNumber: caseIndex + 1,
        pageIndex,
      });
      spec.prepare?.(block);
      page.blocks.push(block);
      page.blockOrder.push(block.id);
      const context = { page, pageIndex, blockIndex, glossary: [] };
      const scheme = createScheme({
        caseNumber: caseIndex + 1,
        context,
        runtime,
        spec,
        block,
      });
      schemes.push(scheme);
    }
    pages.push(page);
  }

  const sequences = createSequences(schemes);
  const snapshot = runtime.ConditionalBatchSnapshotV2Schema.parse({
    schemaVersion: 1,
    schemes,
    sequences,
  });
  const chapterSnapshot = runtime.ChapterSnapshotSchema.parse({
    id: CHAPTER_ID,
    workId: WORK_ID,
    title: CHAPTER_TITLE,
    sourceKind: "images",
    status: "completed",
    pageOrder: pages.map((page) => page.id),
    pages,
    createdAt: FIXTURE_TIME,
    updatedAt: FIXTURE_TIME,
  });

  const expectedSequences = sequences.map((sequence) => {
    const preview = runtime.createConditionalBatchSequencePreview(
      chapterSnapshot,
      { kind: "chapter" },
      sequence,
      snapshot,
      { glossary: [] },
    );
    assertSequencePreview(sequence, preview);
    const applied = runtime.applyConditionalBatchSequencePreview(
      chapterSnapshot,
      sequence,
      snapshot,
      preview,
      new Set(),
      "2026-09-01T00:01:00.000Z",
      { glossary: [] },
    );
    if (applied.conflictCount !== 0) {
      throw new Error(`${sequence.name} preflight produced conflicts.`);
    }
    if (applied.appliedCount !== preview.preview.results.length) {
      throw new Error(
        `${sequence.name} preflight applied ${applied.appliedCount}/${preview.preview.results.length}.`,
      );
    }
    return {
      id: sequence.id,
      name: sequence.name,
      resultCount: preview.preview.results.length,
      stepResultCounts: preview.steps.map(
        (step) => step.preview.results.length,
      ),
      chapter: applied.chapter,
    };
  });

  await writeFixtureFiles({
    chapterSnapshot,
    runRoot,
    runtime,
    snapshot,
  });

  return {
    caseCount: caseSpecs.length,
    caseInventory: caseSpecs.map((spec, index) => ({
      caseNumber: index + 1,
      label: spec.label,
      conditionFamily: spec.conditionFamily,
      actionFamily: resolveActionFamily(index + 1, spec),
    })),
    chapterId: CHAPTER_ID,
    chapterTitle: CHAPTER_TITLE,
    expectedSequences,
    snapshot,
    workTitle: WORK_TITLE,
    baselineChapter: chapterSnapshot,
  };
}

function loadRuntime(sourceRoot) {
  const rules = require(
    resolve(sourceRoot, "out/shared/conditionalBatchRules.js"),
  );
  const engine = require(
    resolve(sourceRoot, "out/shared/conditionalBatchEngine.js"),
  );
  const fields = require(
    resolve(sourceRoot, "out/shared/conditionalBatchFieldRegistry.js"),
  );
  const schemas = require(
    resolve(sourceRoot, "out/shared/ipcLibrarySchemas.js"),
  );
  return { ...rules, ...engine, ...fields, ...schemas };
}

async function findSourcePage(sourceRoot) {
  const index = await readJson(join(sourceRoot, "library", "index.json"));
  for (const workId of index.workOrder ?? []) {
    const workDir = join(sourceRoot, "library", "works", workId);
    const work = await readJson(join(workDir, "work.json"));
    for (const chapterId of work.chapterOrder ?? []) {
      const chapter = await readJson(
        join(workDir, "chapters", chapterId, "chapter.json"),
      );
      for (const page of chapter.pages ?? []) {
        if (page.blocks?.length && page.imagePath) {
          return { block: page.blocks[0], page };
        }
      }
    }
  }
  throw new Error("Could not find a translated library page for app QA.");
}

function createPage({ fixtureImagePath, pageId, pageIndex, sourcePage }) {
  return {
    id: pageId,
    name: `qa-${pad(pageIndex + 1, 2)}.png`,
    imagePath: fixtureImagePath,
    dataUrl: "",
    width: sourcePage.width,
    height: sourcePage.height,
    blocks: [],
    blockOrder: [],
    analysisStatus: "completed",
    createdAt: FIXTURE_TIME,
    updatedAt: FIXTURE_TIME,
  };
}

function createBlock({ baseBlock, blockIndex, caseNumber, pageIndex }) {
  const column = blockIndex % 2;
  const row = Math.floor(blockIndex / 2);
  const caseId = `CASE_${pad(caseNumber, 3)}`;
  const visible =
    `${caseId} COMMON${caseNumber} target target 제12화 12 Alpha ` +
    `"quote" ...  공백\n둘째줄 `;
  const translatedText = `${visible}[size=30]**styled**[/size]`;
  const sourceText =
    `SRC ${caseId} COMMON${caseNumber} target 제12화 12 Alpha ` +
    `"quote" ... END`;
  const block = structuredClone(baseBlock);
  delete block.bubbleLayout;
  delete block.perspectiveTransform;
  delete block.curveLayout;
  delete block.warpTransform;
  delete block.visualClusterId;
  Object.assign(block, {
    id: `qa-block-${pad(caseNumber, 3)}`,
    type: "nonsolid",
    bbox: {
      x: 60 + column * 470,
      y: 35 + row * 190,
      w: 180,
      h: 125,
    },
    renderBbox: {
      x: 60 + column * 470,
      y: 35 + row * 190,
      w: 180,
      h: 125,
    },
    bboxSpace: "normalized_1000",
    renderBboxSpace: "normalized_1000",
    sourceText,
    translatedText,
    textRole: caseNumber % 4 === 0 ? "sound" : "ordinary",
    fontRole: caseNumber % 3 === 0 ? "narration" : "dialogue",
    fontRoleConfidence: 0.82,
    confidence: 0.91,
    sourceDirection: caseNumber % 2 === 0 ? "vertical" : "horizontal",
    renderDirection: caseNumber % 2 === 0 ? "vertical" : "horizontal",
    rotationDeg: 4,
    fontFamily: caseNumber % 2 === 0 ? "nanum-myeongjo" : "nanum-gothic",
    fontSizePx: 24,
    lineHeight: 1.35,
    letterSpacing: 0.2,
    fontWidthScale: 1.1,
    wordBreak: "keep-all-overflow",
    textAlign: caseNumber % 2 === 0 ? "center" : "left",
    textColor: "#112233",
    textOpacity: 0.8,
    outlineColor: "#fefefe",
    outlineWidthPx: 2,
    outlineWidthScale: 1.2,
    outerOutlineColor: "#221100",
    outerOutlineWidthPx: 3,
    textEffect: {
      enabled: true,
      color: "#223344",
      offsetXpx: 1,
      offsetYpx: 2,
      blurPx: 3,
      opacity: 0.6,
    },
    textGlow: {
      enabled: true,
      color: "#445566",
      blurPx: 4,
      opacity: 0.5,
    },
    bold: false,
    italic: false,
    underline: false,
    strikethrough: false,
    emphasisMark: false,
    textBackgroundEnabled: true,
    textBackgroundColor: "#f0e0d0",
    backgroundColor: "#ffffff",
    opacity: 0.7,
    autoFitText: true,
    inpaintExcluded: false,
    reviewStatus: "draft",
    reviewNote: `NOTE ${caseId} PREFIX middle SUFFIX`,
    speakerId: `speaker-${(caseNumber % 3) + 1}`,
    glossaryEntryIds: [`glossary-${(caseNumber % 2) + 1}`],
  });
  // Keep otherwise identical pages distinguishable during page-index checks.
  block.rotationDeg += pageIndex * 0.01;
  return block;
}

function createCaseSpecs(runtime) {
  const specs = runtime.CONDITIONAL_BATCH_FIELD_IDS.map((field) => ({
    label: `필드 ${field}`,
    conditionFamily: `field:${field}`,
    buildMatch: ({ block, context, caseNumber }) => ({
      mode: "all",
      conditions: [
        discriminator(caseNumber),
        canonicalCondition(runtime, block, field, context, caseNumber),
      ],
      groups: [],
    }),
  }));

  specs.push(
    textOperatorCase("contains", "reviewNote", "middle"),
    textOperatorCase("notContains", "reviewNote", "never-present"),
    textOperatorCase("startsWith", "reviewNote", "PREFIX", (block) => {
      block.reviewNote = `PREFIX ${block.reviewNote}`;
    }),
    textOperatorCase("endsWith", "reviewNote", "SUFFIX"),
    textOperatorCase("notEquals", "reviewNote", "different"),
    regexConditionCase("regex", visualCharacterMatcher("number", 1, null)),
    regexConditionCase("notRegex", rawMatcher("^Z+$")),
    textOperatorCase("empty", "speakerId", undefined, (block) => {
      delete block.speakerId;
    }),
    textOperatorCase("notEmpty", "speakerId"),
    enumOperatorCase("notEquals", "textRole", "unknown"),
    enumOperatorCase("oneOf", "fontRole", ["dialogue", "narration"]),
    enumOperatorCase("notOneOf", "textAlign", ["right"]),
    enumOperatorCase("empty", "reviewStatus", undefined, (block) => {
      delete block.reviewStatus;
    }),
    enumOperatorCase("notEmpty", "fontRole"),
    numberOperatorCase("notEquals", "confidence", 0.1),
    numberOperatorCase("greaterThan", "fontSizePx", 10),
    numberOperatorCase("greaterThanOrEqual", "lineHeight", 1.35),
    numberOperatorCase("lessThan", "letterSpacing", 1),
    numberOperatorCase("lessThanOrEqual", "rotationDeg", 10),
    numberOperatorCase("between", "textOpacity", 0.5, 0.9),
    colorOperatorCase("notEquals", "textColor", "#ffffff"),
    colorOperatorCase("near", "outlineColor", "#fdfdfd", undefined, 5),
    colorOperatorCase("empty", "outerOutlineColor", undefined, (block) => {
      delete block.outerOutlineColor;
    }),
    colorOperatorCase("notEmpty", "textBackgroundColor"),
    booleanOperatorCase("bold", false),
    booleanOperatorCase("italic", false),
    booleanOperatorCase("autoFitText", false, (block) => {
      block.autoFitText = false;
    }),
    booleanOperatorCase("inpaintExcluded", false),
    booleanOperatorCase("textEffectEnabled", false, (block) => {
      block.textEffect.enabled = false;
    }),
    ...groupAndSpecialCases(),
  );
  return specs;
}

function canonicalCondition(runtime, block, field, context, caseNumber) {
  const definition = runtime.getConditionalBatchFieldDefinition(field);
  const actual = runtime.readConditionalBatchField(block, field, context);
  const base = {
    id: itemId(caseNumber, `condition-${field}`),
    enabled: true,
    field,
  };
  if (definition.kind === "boolean") {
    return { ...base, operator: actual ? "isTrue" : "isFalse" };
  }
  if (definition.kind === "number") {
    if (typeof actual !== "number") {
      throw new Error(`Expected numeric ${field} for case ${caseNumber}.`);
    }
    return { ...base, operator: "equals", value: actual };
  }
  if (definition.kind === "color" || definition.kind === "enum") {
    if (typeof actual !== "string") {
      throw new Error(`Expected string ${field} for case ${caseNumber}.`);
    }
    return { ...base, operator: "equals", value: actual };
  }
  if (typeof actual !== "string") {
    throw new Error(`Expected text ${field} for case ${caseNumber}.`);
  }
  return { ...base, operator: "equals", value: actual };
}

function textOperatorCase(operator, field, value, prepare) {
  return {
    label: `텍스트 ${field} ${operator}`,
    conditionFamily: `text:${operator}`,
    prepare,
    buildMatch: ({ caseNumber }) => ({
      mode: "all",
      conditions: [
        discriminator(caseNumber),
        condition(caseNumber, field, operator, value),
      ],
      groups: [],
    }),
  };
}

function regexConditionCase(operator, matcher) {
  return {
    label: `텍스트 reviewNote ${operator}`,
    conditionFamily: `text:${operator}`,
    prepare: (block) => {
      block.reviewNote = `${block.reviewNote} 12345`;
    },
    buildMatch: ({ caseNumber }) => ({
      mode: "all",
      conditions: [
        discriminator(caseNumber),
        {
          id: itemId(caseNumber, `condition-${operator}`),
          enabled: true,
          field: "reviewNote",
          operator,
          matcher: reIdMatcher(matcher, caseNumber, "condition-pattern"),
        },
      ],
      groups: [],
    }),
  };
}

function enumOperatorCase(operator, field, value, prepare) {
  return {
    label: `선택값 ${field} ${operator}`,
    conditionFamily: `enum:${operator}`,
    prepare,
    buildMatch: ({ caseNumber }) => ({
      mode: "all",
      conditions: [
        discriminator(caseNumber),
        condition(caseNumber, field, operator, value),
      ],
      groups: [],
    }),
  };
}

function numberOperatorCase(operator, field, value, value2) {
  return {
    label: `숫자 ${field} ${operator}`,
    conditionFamily: `number:${operator}`,
    buildMatch: ({ caseNumber }) => ({
      mode: "all",
      conditions: [
        discriminator(caseNumber),
        condition(caseNumber, field, operator, value, value2),
      ],
      groups: [],
    }),
  };
}

function colorOperatorCase(operator, field, value, prepare, tolerance) {
  return {
    label: `색 ${field} ${operator}`,
    conditionFamily: `color:${operator}`,
    prepare,
    buildMatch: ({ caseNumber }) => ({
      mode: "all",
      conditions: [
        discriminator(caseNumber),
        {
          ...condition(caseNumber, field, operator, value),
          ...(tolerance === undefined ? {} : { tolerance }),
        },
      ],
      groups: [],
    }),
  };
}

function booleanOperatorCase(field, expected, prepare) {
  return {
    label: `참거짓 ${field} ${expected ? "isTrue" : "isFalse"}`,
    conditionFamily: `boolean:${expected ? "isTrue" : "isFalse"}`,
    prepare,
    buildMatch: ({ caseNumber }) => ({
      mode: "all",
      conditions: [
        discriminator(caseNumber),
        condition(caseNumber, field, expected ? "isTrue" : "isFalse"),
      ],
      groups: [],
    }),
  };
}

function groupAndSpecialCases() {
  return [
    {
      label: "하나라도 맞을 때 직접 조건",
      conditionFamily: "match:any-direct",
      buildMatch: ({ caseNumber }) => ({
        mode: "any",
        conditions: [
          discriminator(caseNumber),
          condition(caseNumber, "reviewNote", "equals", "never"),
        ],
        groups: [],
      }),
      actionFactory: visualCaptureAction,
    },
    {
      label: "모두 맞을 때 직접 조건",
      conditionFamily: "match:all-direct",
      buildMatch: ({ caseNumber }) => ({
        mode: "all",
        conditions: [
          discriminator(caseNumber),
          condition(caseNumber, "reviewNote", "notEmpty"),
        ],
        groups: [],
      }),
      actionFactory: whitespaceAction,
    },
    {
      label: "모두 맞는 조건 그룹",
      conditionFamily: "group:all",
      buildMatch: ({ caseNumber, block }) => ({
        mode: "all",
        conditions: [],
        groups: [
          group(caseNumber, "all", [
            discriminator(caseNumber),
            condition(caseNumber, "fontFamily", "equals", block.fontFamily),
          ]),
        ],
      }),
      actionFactory: choiceAction,
    },
    {
      label: "하나라도 맞는 조건 그룹",
      conditionFamily: "group:any",
      buildMatch: ({ caseNumber }) => ({
        mode: "all",
        conditions: [],
        groups: [
          group(caseNumber, "any", [
            discriminator(caseNumber),
            condition(caseNumber, "reviewNote", "equals", "never"),
          ]),
        ],
      }),
      actionFactory: startBoundaryAction,
    },
    {
      label: "바깥 하나라도와 내부 모두 그룹",
      conditionFamily: "match:any+group:all",
      buildMatch: ({ caseNumber }) => ({
        mode: "any",
        conditions: [condition(caseNumber, "reviewNote", "equals", "never")],
        groups: [
          group(caseNumber, "all", [
            discriminator(caseNumber),
            condition(caseNumber, "speakerId", "notEmpty"),
          ]),
        ],
      }),
      actionFactory: groupCaptureAction,
    },
    {
      label: "비활성 직접 조건 무시",
      conditionFamily: "condition:disabled",
      buildMatch: ({ caseNumber }) => ({
        mode: "all",
        conditions: [
          discriminator(caseNumber),
          {
            ...condition(caseNumber, "reviewNote", "equals", "never"),
            enabled: false,
          },
        ],
        groups: [],
      }),
      actionFactory: letterAction,
    },
    {
      label: "비활성 조건 그룹 무시",
      conditionFamily: "group:disabled",
      buildMatch: ({ caseNumber }) => ({
        mode: "all",
        conditions: [discriminator(caseNumber)],
        groups: [
          {
            ...group(caseNumber, "all", [
              condition(caseNumber, "reviewNote", "equals", "never"),
            ]),
            enabled: false,
          },
        ],
      }),
      actionFactory: shortestAnyAction,
    },
    {
      label: "그룹 안 비활성 조건 무시",
      conditionFamily: "group:disabled-child",
      buildMatch: ({ caseNumber }) => ({
        mode: "all",
        conditions: [],
        groups: [
          group(caseNumber, "all", [
            discriminator(caseNumber),
            {
              ...condition(caseNumber, "reviewNote", "equals", "never"),
              enabled: false,
            },
          ]),
        ],
      }),
      actionFactory: clearFieldsAction,
    },
    {
      label: "직접 조건과 하나라도 그룹 조합",
      conditionFamily: "match:all+group:any",
      buildMatch: ({ caseNumber }) => ({
        mode: "all",
        conditions: [condition(caseNumber, "fontSizePx", "greaterThan", 10)],
        groups: [
          group(caseNumber, "any", [
            discriminator(caseNumber),
            condition(caseNumber, "reviewNote", "equals", "never"),
          ]),
        ],
      }),
      actionFactory: fullInlineStyleAction,
    },
    {
      label: "모든 말풍선 다단계 작업",
      conditionFamily: "match:allBlocks",
      buildMatch: () => ({ mode: "allBlocks", conditions: [], groups: [] }),
      actionFactory: allBlocksPipelineAction,
    },
  ];
}

function createScheme({ caseNumber, context, runtime, spec, block }) {
  const match = spec.buildMatch({ block, caseNumber, context, runtime });
  const actions = spec.actionFactory
    ? spec.actionFactory(caseNumber)
    : cycleActions(caseNumber);
  return {
    id: schemeId(caseNumber),
    name: `${pad(caseNumber, 3)} ${spec.label}`.slice(0, 80),
    description: `앱 QA 조합 ${caseNumber}`,
    match,
    actions,
  };
}

function cycleActions(caseNumber) {
  switch ((caseNumber - 1) % 10) {
    case 0:
      return [setReviewNoteAction(caseNumber)];
    case 1:
      return [literalReplaceAction(caseNumber)];
    case 2:
      return [sourceReplaceAction(caseNumber)];
    case 3:
      return [regexBothAction(caseNumber)];
    case 4:
      return [stylePresetAction(caseNumber)];
    case 5:
      return [patternStyleAction(caseNumber)];
    case 6:
      return [fillStyleAction(caseNumber)];
    case 7:
      return [effectsAction(caseNumber)];
    case 8:
      return pipelineActions(caseNumber);
    default:
      return [existingStyleAction(caseNumber)];
  }
}

function setReviewNoteAction(caseNumber) {
  return {
    id: itemId(caseNumber, "action-set-review"),
    enabled: true,
    type: "setFields",
    changes: [
      {
        field: "reviewNote",
        operation: "set",
        value: `APPLIED_${pad(caseNumber, 3)}`,
      },
    ],
  };
}

function literalReplaceAction(caseNumber) {
  return {
    id: itemId(caseNumber, "action-literal-replace"),
    enabled: true,
    type: "replaceText",
    target: "translatedText",
    matcher: literalMatcher("target", caseNumber, "literal-find", false),
    replacement: literalReplacement(
      `done${caseNumber}`,
      caseNumber,
      "literal-replacement",
    ),
    allOccurrences: caseNumber % 4 !== 2,
  };
}

function sourceReplaceAction(caseNumber) {
  return {
    id: itemId(caseNumber, "action-source-replace"),
    enabled: true,
    type: "replaceText",
    target: "sourceText",
    matcher: literalMatcher("SRC", caseNumber, "source-find"),
    replacement: literalReplacement(
      `SOURCE${caseNumber}`,
      caseNumber,
      "source-replacement",
    ),
    allOccurrences: false,
  };
}

function regexBothAction(caseNumber) {
  return {
    id: itemId(caseNumber, "action-regex-both"),
    enabled: true,
    type: "replaceText",
    target: "both",
    matcher: {
      mode: "regex",
      source: "COMMON(\\d+)",
      caseSensitive: true,
    },
    replacement: { mode: "raw", source: "DUAL$1" },
    allOccurrences: true,
  };
}

function stylePresetAction(caseNumber) {
  return {
    id: itemId(caseNumber, "action-preset"),
    enabled: true,
    type: "applyStylePreset",
    presetId: `qa-preset-${caseNumber}`,
    presetName: `QA 프리셋 ${caseNumber}`,
    groupIds: [
      "direction",
      "size",
      "emphasis",
      "color",
      "outline",
      "effect",
      "transform",
    ],
    format: {
      renderDirection: caseNumber % 2 === 0 ? "horizontal" : "vertical",
      fontSizePx: 40 + (caseNumber % 5),
      bold: true,
      italic: true,
      underline: true,
      textColor: "#884422",
      textOpacity: 0.9,
      outlineColor: "#ffffff",
      outlineWidthPx: 3,
      outerOutlineColor: "#000000",
      outerOutlineWidthPx: 4,
      textBackgroundEnabled: true,
      textBackgroundColor: "#fff0dd",
      textEffect: {
        enabled: true,
        color: "#331100",
        offsetXpx: 4,
        offsetYpx: 5,
        blurPx: 6,
        opacity: 0.7,
      },
      textGlow: {
        enabled: true,
        color: "#ff9900",
        blurPx: 7,
        opacity: 0.6,
      },
      rotationDeg: -7,
    },
  };
}

function patternStyleAction(caseNumber) {
  return {
    id: itemId(caseNumber, "action-pattern-style"),
    enabled: true,
    type: "styleText",
    target: "translatedText",
    scope: "pattern",
    matcher: literalMatcher("target", caseNumber, "style-find"),
    allOccurrences: true,
    styleMode: "overwrite",
    patch: {
      bold: true,
      underline: true,
      color: "#990000",
      backgroundColor: "#fff2aa",
    },
  };
}

function fillStyleAction(caseNumber) {
  return {
    id: itemId(caseNumber, "action-fill-style"),
    enabled: true,
    type: "styleText",
    target: "translatedText",
    scope: "allText",
    allOccurrences: true,
    styleMode: "fillMissing",
    patch: { italic: true, opacity: 0.75, widthScale: 1.2 },
  };
}

function effectsAction(caseNumber) {
  return {
    id: itemId(caseNumber, "action-effects"),
    enabled: true,
    type: "setFields",
    changes: [
      { field: "textBackgroundEnabled", operation: "set", value: true },
      { field: "textBackgroundColor", operation: "set", value: "#ddeeff" },
      { field: "outerOutlineColor", operation: "set", value: "#110022" },
      { field: "outerOutlineWidthPx", operation: "set", value: 5 },
      { field: "textEffectEnabled", operation: "set", value: true },
      { field: "textEffectColor", operation: "set", value: "#123456" },
      { field: "textEffectOffsetX", operation: "set", value: 6 },
      { field: "textEffectOffsetY", operation: "set", value: 7 },
      { field: "textEffectBlur", operation: "set", value: 8 },
      { field: "textEffectOpacity", operation: "set", value: 0.55 },
      { field: "textGlowEnabled", operation: "set", value: true },
      { field: "textGlowColor", operation: "set", value: "#ff7700" },
      { field: "textGlowBlur", operation: "set", value: 9 },
      { field: "textGlowOpacity", operation: "set", value: 0.65 },
    ],
  };
}

function pipelineActions(caseNumber) {
  return [
    {
      id: itemId(caseNumber, "action-pipeline-style"),
      enabled: true,
      type: "styleText",
      target: "translatedText",
      scope: "pattern",
      matcher: literalMatcher("DONE", caseNumber, "pipeline-style-find"),
      allOccurrences: true,
      styleMode: "overwrite",
      patch: { bold: true },
    },
    {
      id: itemId(caseNumber, "action-pipeline-replace"),
      enabled: true,
      type: "replaceText",
      target: "translatedText",
      matcher: literalMatcher("READY", caseNumber, "pipeline-replace-find"),
      replacement: literalReplacement(
        "DONE",
        caseNumber,
        "pipeline-replace-value",
      ),
      allOccurrences: true,
    },
    {
      id: itemId(caseNumber, "action-pipeline-set"),
      enabled: true,
      type: "setFields",
      changes: [
        {
          field: "translatedText",
          operation: "set",
          value: `CASE_${pad(caseNumber, 3)} PIPE_READY target`,
        },
        { field: "reviewStatus", operation: "set", value: "reviewed" },
      ],
    },
  ];
}

function existingStyleAction(caseNumber) {
  return {
    id: itemId(caseNumber, "action-existing-style"),
    enabled: true,
    type: "styleText",
    target: "translatedText",
    scope: "allText",
    allOccurrences: true,
    styleMode: "replace",
    matchStyle: {
      logic: "all",
      conditions: [
        {
          id: itemId(caseNumber, "style-bold"),
          field: "bold",
          operator: "equals",
          value: true,
        },
        {
          id: itemId(caseNumber, "style-size"),
          field: "sizePx",
          operator: "greaterThanOrEqual",
          value: 30,
        },
      ],
    },
    patch: { italic: true, backgroundColor: "#ddffee" },
  };
}

function visualCaptureAction(caseNumber) {
  const captureId = `episode-${caseNumber}`;
  return [
    {
      id: itemId(caseNumber, "action-visual-capture"),
      enabled: true,
      type: "replaceText",
      target: "translatedText",
      matcher: {
        mode: "visual",
        caseSensitive: true,
        nodes: [
          literalNode("제", caseNumber, "episode-prefix"),
          characterNode("number", caseNumber, "episode-number", {
            min: 1,
            max: null,
            greedy: true,
            captureId,
          }),
          literalNode("화", caseNumber, "episode-suffix"),
        ],
      },
      replacement: {
        mode: "visual",
        parts: [
          {
            id: itemId(caseNumber, "episode-memory"),
            kind: "capture",
            captureId,
          },
          {
            id: itemId(caseNumber, "episode-unit"),
            kind: "literal",
            text: "회",
          },
        ],
      },
      allOccurrences: true,
    },
  ];
}

function whitespaceAction(caseNumber) {
  return [
    {
      id: itemId(caseNumber, "action-whitespace"),
      enabled: true,
      type: "replaceText",
      target: "translatedText",
      matcher: {
        mode: "visual",
        caseSensitive: true,
        nodes: [
          characterNode("whitespace", caseNumber, "spaces", {
            min: 2,
            max: null,
            greedy: true,
          }),
        ],
      },
      replacement: literalReplacement(" ", caseNumber, "one-space"),
      allOccurrences: true,
    },
  ];
}

function choiceAction(caseNumber) {
  return [
    {
      id: itemId(caseNumber, "action-choice"),
      enabled: true,
      type: "replaceText",
      target: "translatedText",
      matcher: {
        mode: "visual",
        caseSensitive: true,
        nodes: [
          {
            id: itemId(caseNumber, "choice-node"),
            kind: "choice",
            options: ["target", "unused"],
            repeat: repeat(),
          },
        ],
      },
      replacement: literalReplacement("choiceDone", caseNumber, "choice-value"),
      allOccurrences: true,
    },
  ];
}

function startBoundaryAction(caseNumber) {
  return [
    {
      id: itemId(caseNumber, "action-start-boundary"),
      enabled: true,
      type: "replaceText",
      target: "translatedText",
      matcher: {
        mode: "visual",
        caseSensitive: true,
        nodes: [
          {
            id: itemId(caseNumber, "start-boundary"),
            kind: "boundary",
            boundary: "start",
          },
          literalNode(
            `CASE_${pad(caseNumber, 3)}`,
            caseNumber,
            "start-literal",
          ),
        ],
      },
      replacement: literalReplacement(
        `START_${pad(caseNumber, 3)}`,
        caseNumber,
        "start-value",
      ),
      allOccurrences: false,
    },
  ];
}

function groupCaptureAction(caseNumber) {
  const captureId = `whole-${caseNumber}`;
  return [
    {
      id: itemId(caseNumber, "action-group-capture"),
      enabled: true,
      type: "replaceText",
      target: "translatedText",
      matcher: {
        mode: "visual",
        caseSensitive: true,
        nodes: [
          {
            id: itemId(caseNumber, "capture-group"),
            kind: "group",
            repeat: repeat(),
            captureId,
            nodes: [
              literalNode("COMMON", caseNumber, "group-common"),
              characterNode("number", caseNumber, "group-number", {
                min: 1,
                max: null,
                greedy: true,
              }),
            ],
          },
        ],
      },
      replacement: {
        mode: "visual",
        parts: [
          {
            id: itemId(caseNumber, "group-prefix"),
            kind: "literal",
            text: "GROUP-",
          },
          {
            id: itemId(caseNumber, "group-memory"),
            kind: "capture",
            captureId,
          },
        ],
      },
      allOccurrences: true,
    },
  ];
}

function letterAction(caseNumber) {
  return [
    {
      id: itemId(caseNumber, "action-letter"),
      enabled: true,
      type: "replaceText",
      target: "translatedText",
      matcher: {
        mode: "visual",
        caseSensitive: true,
        nodes: [
          characterNode("letter", caseNumber, "letters", {
            min: 5,
            max: null,
            greedy: true,
          }),
        ],
      },
      replacement: literalReplacement("LETTERS", caseNumber, "letters-value"),
      allOccurrences: false,
    },
  ];
}

function shortestAnyAction(caseNumber) {
  const captureId = `inside-${caseNumber}`;
  return [
    {
      id: itemId(caseNumber, "action-shortest-any"),
      enabled: true,
      type: "replaceText",
      target: "translatedText",
      matcher: {
        mode: "visual",
        caseSensitive: true,
        nodes: [
          literalNode('"', caseNumber, "quote-open"),
          characterNode("any", caseNumber, "quote-content", {
            min: 1,
            max: null,
            greedy: false,
            captureId,
          }),
          literalNode('"', caseNumber, "quote-close"),
        ],
      },
      replacement: {
        mode: "visual",
        parts: [
          {
            id: itemId(caseNumber, "bracket-open"),
            kind: "literal",
            text: "[",
          },
          {
            id: itemId(caseNumber, "quote-memory"),
            kind: "capture",
            captureId,
          },
          {
            id: itemId(caseNumber, "bracket-close"),
            kind: "literal",
            text: "]",
          },
        ],
      },
      allOccurrences: true,
    },
  ];
}

function clearFieldsAction(caseNumber) {
  return [
    {
      id: itemId(caseNumber, "action-clear-fields"),
      enabled: true,
      type: "setFields",
      changes: [
        { field: "speakerId", operation: "clear" },
        { field: "reviewNote", operation: "clear" },
        { field: "outerOutlineColor", operation: "clear" },
        { field: "textGlowEnabled", operation: "clear" },
      ],
    },
  ];
}

function fullInlineStyleAction(caseNumber) {
  return [
    {
      id: itemId(caseNumber, "action-full-inline-style"),
      enabled: true,
      type: "styleText",
      target: "translatedText",
      scope: "allText",
      allOccurrences: true,
      styleMode: "overwrite",
      matchStyle: {
        logic: "any",
        conditions: [
          {
            id: itemId(caseNumber, "inline-bold"),
            field: "bold",
            operator: "equals",
            value: true,
          },
          {
            id: itemId(caseNumber, "inline-size"),
            field: "sizePx",
            operator: "greaterThanOrEqual",
            value: 30,
          },
        ],
      },
      patch: {
        italic: true,
        underline: true,
        strikethrough: true,
        emphasisMark: true,
        fontFamily: "nanum-gothic",
        sizePx: 36,
        opacity: 0.8,
        widthScale: 1.25,
        color: "#112233",
        backgroundColor: "#fefefe",
        outlineColor: "#ffffff",
        outlineWidthPx: 2,
        outerOutlineColor: "#000000",
        outerOutlineWidthPx: 3,
        glowColor: "#ff8800",
        glowBlurPx: 6,
        glowOpacity: 0.65,
        verticalCombine: true,
      },
    },
  ];
}

function allBlocksPipelineAction(caseNumber) {
  return [
    {
      id: itemId(caseNumber, "action-allblocks-style"),
      enabled: true,
      type: "styleText",
      target: "translatedText",
      scope: "pattern",
      matcher: literalMatcher("target", caseNumber, "allblocks-style-find"),
      allOccurrences: true,
      styleMode: "overwrite",
      patch: { underline: true },
    },
    {
      id: itemId(caseNumber, "action-allblocks-replace"),
      enabled: true,
      type: "replaceText",
      target: "sourceText",
      matcher: literalMatcher("SRC", caseNumber, "allblocks-source-find"),
      replacement: literalReplacement(
        "ALL",
        caseNumber,
        "allblocks-source-value",
      ),
      allOccurrences: false,
    },
    {
      id: itemId(caseNumber, "action-allblocks-set"),
      enabled: true,
      type: "setFields",
      changes: [
        { field: "reviewStatus", operation: "set", value: "reviewed" },
        { field: "textBackgroundEnabled", operation: "set", value: true },
        {
          field: "textBackgroundColor",
          operation: "set",
          value: "#ffeecc",
        },
      ],
    },
  ];
}

function createSequences(schemes) {
  const sizes = [32, 32, 32, 4];
  let cursor = 0;
  return sizes.map((size, index) => {
    const selected = schemes.slice(cursor, cursor + size);
    cursor += size;
    return {
      id: `qa-sequence-${index + 1}`,
      name: `QA 연속 실행 ${index + 1} (${selected[0].name.slice(0, 3)}–${selected.at(-1).name.slice(0, 3)})`,
      description: `${size}개 실제 앱 규칙 조합`,
      steps: selected.map((scheme, stepIndex) => ({
        id: `qa-sequence-${index + 1}-step-${pad(stepIndex + 1, 2)}`,
        schemeId: scheme.id,
        enabled: true,
      })),
    };
  });
}

function assertSequencePreview(sequence, preview) {
  if (preview.steps.length !== sequence.steps.length) {
    throw new Error(`${sequence.name} omitted a sequence step.`);
  }
  for (const [index, step] of preview.steps.entries()) {
    if (step.preview.results.length === 0) {
      throw new Error(`${sequence.name} step ${index + 1} produced no result.`);
    }
  }
  if (preview.preview.results.length === 0) {
    throw new Error(`${sequence.name} produced no combined result.`);
  }
}

async function writeFixtureFiles({
  chapterSnapshot,
  runRoot,
  runtime,
  snapshot,
}) {
  const libraryRoot = join(runRoot, "library");
  const workDir = join(libraryRoot, "works", WORK_ID);
  const chapterDir = join(workDir, "chapters", CHAPTER_ID);
  await mkdir(chapterDir, { recursive: true });
  const storedPages = chapterSnapshot.pages.map((page) => {
    const stored = structuredClone(page);
    delete stored.dataUrl;
    return stored;
  });
  const chapterFile = runtime.LibraryChapterFileSchema.parse({
    ...chapterSnapshot,
    pages: storedPages,
  });
  const workFile = runtime.LibraryWorkFileSchema.parse({
    id: WORK_ID,
    title: WORK_TITLE,
    chapterOrder: [CHAPTER_ID],
    readingDirection: "auto",
    createdAt: FIXTURE_TIME,
    updatedAt: FIXTURE_TIME,
  });
  const indexFile = runtime.StoredLibraryIndexFileSchema.parse({
    workOrder: [WORK_ID],
  });
  const YAML = require("yaml");
  await Promise.all([
    writeJson(join(libraryRoot, "index.json"), indexFile),
    writeJson(join(workDir, "work.json"), workFile),
    writeJson(join(chapterDir, "chapter.json"), chapterFile),
    writeFile(
      join(runRoot, "batch-edit-schemes.yaml"),
      YAML.stringify(snapshot),
      "utf8",
    ),
  ]);
}

function discriminator(caseNumber) {
  return condition(
    caseNumber,
    "translatedText",
    "contains",
    `CASE_${pad(caseNumber, 3)}`,
    undefined,
    "discriminator",
  );
}

function condition(
  caseNumber,
  field,
  operator,
  value,
  value2,
  suffix = `${field}-${operator}`,
) {
  return {
    id: itemId(caseNumber, `condition-${suffix}`),
    enabled: true,
    field,
    operator,
    ...(["empty", "notEmpty", "isTrue", "isFalse"].includes(operator)
      ? {}
      : { value }),
    ...(value2 === undefined ? {} : { value2 }),
  };
}

function group(caseNumber, logic, conditions) {
  return {
    id: itemId(caseNumber, `group-${logic}`),
    enabled: true,
    logic,
    conditions,
  };
}

function literalMatcher(text, caseNumber, suffix, caseSensitive = true) {
  return {
    mode: "visual",
    caseSensitive,
    nodes: [literalNode(text, caseNumber, suffix)],
  };
}

function literalReplacement(text, caseNumber, suffix) {
  return {
    mode: "visual",
    parts: [{ id: itemId(caseNumber, suffix), kind: "literal", text }],
  };
}

function literalNode(text, caseNumber, suffix) {
  return {
    id: itemId(caseNumber, suffix),
    kind: "literal",
    text,
    repeat: repeat(),
  };
}

function characterNode(character, caseNumber, suffix, options = {}) {
  const { captureId, ...repeatOptions } = options;
  return {
    id: itemId(caseNumber, suffix),
    kind: "character",
    character,
    repeat: repeat(repeatOptions),
    ...(captureId ? { captureId } : {}),
  };
}

function visualCharacterMatcher(character, min, max) {
  return {
    mode: "visual",
    caseSensitive: true,
    nodes: [
      {
        id: "placeholder-character",
        kind: "character",
        character,
        repeat: { min, max, greedy: true },
      },
    ],
  };
}

function rawMatcher(source) {
  return { mode: "regex", source, caseSensitive: true };
}

function reIdMatcher(matcher, caseNumber, suffix) {
  if (matcher.mode === "regex") return matcher;
  return {
    ...matcher,
    nodes: matcher.nodes.map((node, index) => ({
      ...node,
      id: itemId(caseNumber, `${suffix}-${index}`),
    })),
  };
}

function repeat(overrides = {}) {
  return { min: 1, max: 1, greedy: true, ...overrides };
}

function resolveActionFamily(caseNumber, spec) {
  if (spec.actionFactory) return spec.actionFactory.name;
  return [
    "setFields",
    "replaceText:literal",
    "replaceText:source",
    "replaceText:regex-both",
    "applyStylePreset",
    "styleText:pattern",
    "styleText:fillMissing",
    "setFields:effects",
    "pipeline:set-replace-style",
    "styleText:matchStyle",
  ][(caseNumber - 1) % 10];
}

function schemeId(caseNumber) {
  return `qa-scheme-${pad(caseNumber, 3)}`;
}

function itemId(caseNumber, suffix) {
  return `qa-${pad(caseNumber, 3)}-${suffix}`;
}

function pad(value, length) {
  return String(value).padStart(length, "0");
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
