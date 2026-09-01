/* eslint-disable max-lines -- labels, summaries, and typed editor defaults form one UI registry */
import {
  CONDITIONAL_BATCH_FIELD_DEFINITIONS,
  getConditionalBatchFieldDefinition,
  type ConditionalBatchField,
  type ConditionalBatchOperator,
} from "../../../shared/conditionalBatchFieldRegistry";
import {
  createConditionalBatchClientId,
  type ConditionalBatchActionV2,
  type ConditionalBatchConditionV2,
} from "../../../shared/conditionalBatchRules";
import {
  createConditionalLiteralMatcher,
  createConditionalLiteralReplacement,
  type ConditionalReplacementV3,
  type ConditionalTextMatcherV3,
} from "../../../shared/conditionalTextPattern";

export const CONDITIONAL_BATCH_FIELD_LABELS: Record<
  ConditionalBatchField,
  string
> = {
  sourceText: "원문",
  translatedText: "번역문",
  fontFamily: "글꼴",
  speakerId: "화자",
  reviewNote: "검수 메모",
  textRole: "텍스트 역할",
  fontRole: "글꼴 역할",
  sourceDirection: "원문 방향",
  renderDirection: "출력 방향",
  textAlign: "정렬",
  wordBreak: "줄바꿈",
  reviewStatus: "검수 상태",
  confidence: "OCR 신뢰도",
  fontRoleConfidence: "글꼴 신뢰도",
  fontSizePx: "글자 크기",
  lineHeight: "행간",
  letterSpacing: "자간",
  fontWidthScale: "글자 너비",
  rotationDeg: "회전",
  textOpacity: "불투명도",
  outlineWidthPx: "외곽선 두께",
  outlineWidthScale: "외곽선 배율",
  outerOutlineWidthPx: "바깥 외곽선 두께",
  pageIndex: "페이지 순번",
  blockIndex: "말풍선 순번",
  lineCount: "줄 수",
  sourceLength: "원문 글자 수",
  translatedLength: "번역문 글자 수",
  bboxWidth: "말풍선 너비",
  bboxHeight: "말풍선 높이",
  bboxAspectRatio: "말풍선 비율",
  textColor: "글자색",
  outlineColor: "외곽선색",
  outerOutlineColor: "바깥 외곽선색",
  textBackgroundColor: "글자 영역 배경색",
  bold: "굵게",
  italic: "기울임",
  underline: "밑줄",
  strikethrough: "취소선",
  emphasisMark: "강조점",
  textBackgroundEnabled: "글자 영역 배경",
  autoFitText: "자동 맞춤",
  inpaintExcluded: "인페인팅 제외",
  hasInlineStyle: "부분 서식 있음",
  hasSpeaker: "화자 있음",
  hasGlossary: "용어 연결 있음",
  textEffectEnabled: "그림자 있음",
  textEffectColor: "그림자색",
  textEffectOffsetX: "그림자 가로 위치",
  textEffectOffsetY: "그림자 세로 위치",
  textEffectBlur: "그림자 흐림",
  textEffectOpacity: "그림자 불투명도",
  textGlowEnabled: "광선 있음",
  textGlowColor: "광선색",
  textGlowBlur: "광선 퍼짐",
  textGlowOpacity: "광선 불투명도",
  sameAsSource: "원문과 동일",
  numberMismatch: "숫자 불일치",
  unbalancedPunctuation: "괄호·따옴표 불균형",
  suspiciousWhitespace: "의심스러운 공백",
  glossaryMismatch: "용어집 불일치",
};

export const CONDITIONAL_BATCH_OPERATOR_LABELS: Record<
  ConditionalBatchOperator,
  string
> = {
  contains: "포함",
  notContains: "포함하지 않음",
  equals: "같음",
  notEquals: "다름",
  startsWith: "다음으로 시작",
  endsWith: "다음으로 끝남",
  regex: "패턴과 맞음",
  notRegex: "패턴과 맞지 않음",
  empty: "비어 있음",
  notEmpty: "비어 있지 않음",
  oneOf: "다음 중 하나",
  notOneOf: "어느 것도 아님",
  greaterThan: ">",
  greaterThanOrEqual: "≥",
  lessThan: "<",
  lessThanOrEqual: "≤",
  between: "범위",
  near: "비슷한 색",
  isTrue: "예",
  isFalse: "아니오",
};

const CONDITIONAL_BATCH_FIELD_GROUPS: ReadonlyArray<{
  label: string;
  fields: readonly ConditionalBatchField[];
}> = [
  {
    label: "텍스트·대사",
    fields: [
      "translatedText",
      "sourceText",
      "textRole",
      "speakerId",
      "hasSpeaker",
      "hasGlossary",
    ],
  },
  {
    label: "글꼴·글자 모양",
    fields: [
      "fontFamily",
      "fontRole",
      "fontSizePx",
      "bold",
      "italic",
      "underline",
      "strikethrough",
      "emphasisMark",
      "textColor",
      "textBackgroundEnabled",
      "textBackgroundColor",
      "textOpacity",
      "lineHeight",
      "letterSpacing",
      "fontWidthScale",
      "outlineColor",
      "outlineWidthPx",
      "outlineWidthScale",
      "outerOutlineColor",
      "outerOutlineWidthPx",
      "autoFitText",
      "hasInlineStyle",
    ],
  },
  {
    label: "방향·배치",
    fields: [
      "renderDirection",
      "sourceDirection",
      "textAlign",
      "wordBreak",
      "rotationDeg",
    ],
  },
  {
    label: "검수·인식",
    fields: [
      "reviewStatus",
      "reviewNote",
      "confidence",
      "fontRoleConfidence",
      "inpaintExcluded",
    ],
  },
  {
    label: "자동 검사",
    fields: [
      "sameAsSource",
      "numberMismatch",
      "unbalancedPunctuation",
      "suspiciousWhitespace",
      "glossaryMismatch",
    ],
  },
  {
    label: "위치·분량",
    fields: [
      "pageIndex",
      "blockIndex",
      "lineCount",
      "translatedLength",
      "sourceLength",
      "bboxWidth",
      "bboxHeight",
      "bboxAspectRatio",
    ],
  },
  {
    label: "고급 텍스트 효과",
    fields: [
      "textEffectEnabled",
      "textEffectColor",
      "textEffectOpacity",
      "textEffectOffsetX",
      "textEffectOffsetY",
      "textEffectBlur",
      "textGlowEnabled",
      "textGlowColor",
      "textGlowOpacity",
      "textGlowBlur",
    ],
  },
];

const CONDITIONAL_BATCH_FIELD_GROUP_BY_ID = new Map(
  CONDITIONAL_BATCH_FIELD_GROUPS.flatMap((group) =>
    group.fields.map((field) => [field, group.label] as const),
  ),
);

const CONDITIONAL_BATCH_FIELD_ORDER = new Map(
  CONDITIONAL_BATCH_FIELD_GROUPS.flatMap((group) => group.fields).map(
    (field, index) => [field, index] as const,
  ),
);

const CONDITIONAL_BATCH_FIELDS_FOR_UI = [...CONDITIONAL_BATCH_FIELD_DEFINITIONS]
  .sort(
    (left, right) =>
      (CONDITIONAL_BATCH_FIELD_ORDER.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
      (CONDITIONAL_BATCH_FIELD_ORDER.get(right.id) ?? Number.MAX_SAFE_INTEGER),
  )
  .map((definition) => ({
    ...definition,
    label: CONDITIONAL_BATCH_FIELD_LABELS[definition.id],
    categoryLabel:
      CONDITIONAL_BATCH_FIELD_GROUP_BY_ID.get(definition.id) ?? "기타",
  }));

export const QUICK_CONDITIONAL_BATCH_FIELDS: readonly ConditionalBatchField[] =
  [
    "translatedText",
    "sourceText",
    "textRole",
    "fontFamily",
    "renderDirection",
    "reviewStatus",
  ];

export function listConditionalBatchFields() {
  return CONDITIONAL_BATCH_FIELDS_FOR_UI;
}

const HIDDEN_NEW_CONDITION_FIELDS = new Set<ConditionalBatchField>([
  "outlineWidthScale",
  "pageIndex",
  "blockIndex",
  "bboxWidth",
  "bboxHeight",
  "bboxAspectRatio",
  "textEffectColor",
  "textEffectOffsetX",
  "textEffectOffsetY",
  "textEffectBlur",
  "textEffectOpacity",
  "textGlowColor",
  "textGlowBlur",
  "textGlowOpacity",
]);

/**
 * Keep low-level fields readable for imported rules, but do not offer them
 * when creating a new condition. Exact shadow/glow components are useful as
 * values to set, not as everyday matching criteria; their on/off fields remain
 * available. Raw page/block indices and bounding-box geometry are brittle
 * implementation coordinates rather than useful everyday manga-editing
 * choices. outlineWidthScale is an internal multiplier duplicated by the
 * user-facing pixel thickness.
 */
export function isNewConditionalBatchConditionField(
  field: ConditionalBatchField,
): boolean {
  return !HIDDEN_NEW_CONDITION_FIELDS.has(field);
}

export function isNewConditionalBatchWritableField(
  field: ConditionalBatchField,
): boolean {
  return field !== "outlineWidthScale";
}

export function createConditionForField(
  field: ConditionalBatchField,
): ConditionalBatchConditionV2 {
  const definition = getConditionalBatchFieldDefinition(field);
  const base = {
    id: createConditionalBatchClientId("condition"),
    enabled: true,
    field,
  };
  if (definition.kind === "boolean") {
    return { ...base, operator: "isTrue" };
  }
  if (definition.kind === "number") {
    return { ...base, operator: "equals", value: 0 };
  }
  if (definition.kind === "color") {
    return { ...base, operator: "equals", value: "#000000" };
  }
  if (definition.kind === "enum") {
    return {
      ...base,
      operator: "equals",
      value: conditionalBatchEnumOptions(field)[0]?.value ?? "",
    };
  }
  if (field === "fontFamily") {
    return { ...base, operator: "equals", value: "" };
  }
  return { ...base, operator: "contains", value: "" };
}

// eslint-disable-next-line complexity -- each bounded operator kind maps to the one value shape required by the shared field registry
export function conditionValueForOperator(
  condition: ConditionalBatchConditionV2,
  operator: ConditionalBatchOperator,
): ConditionalBatchConditionV2 {
  const definition = getConditionalBatchFieldDefinition(condition.field);
  const base = { ...condition, operator };
  if (
    operator === "empty" ||
    operator === "notEmpty" ||
    operator === "isTrue" ||
    operator === "isFalse"
  ) {
    const {
      value: _value,
      value2: _value2,
      tolerance: _tolerance,
      matcher: _matcher,
      ...rest
    } = base;
    return rest;
  }
  if (operator === "regex" || operator === "notRegex") {
    const {
      value: _value,
      value2: _value2,
      tolerance: _tolerance,
      ...rest
    } = base;
    return {
      ...rest,
      matcher:
        condition.matcher ??
        createConditionalLiteralMatcher(
          typeof condition.value === "string" ? condition.value : "",
        ),
    };
  }
  if (operator === "oneOf" || operator === "notOneOf") {
    return {
      ...base,
      value: Array.isArray(condition.value)
        ? condition.value
        : [
            String(
              condition.value ??
                conditionalBatchEnumOptions(condition.field)[0]?.value ??
                "",
            ),
          ],
    };
  }
  if (definition.kind === "number") {
    return {
      ...base,
      value: typeof condition.value === "number" ? condition.value : 0,
      ...(operator === "between"
        ? {
            value2: typeof condition.value2 === "number" ? condition.value2 : 1,
          }
        : {}),
    };
  }
  if (definition.kind === "color") {
    return {
      ...base,
      value: typeof condition.value === "string" ? condition.value : "#000000",
      ...(operator === "near" ? { tolerance: condition.tolerance ?? 10 } : {}),
    };
  }
  return {
    ...base,
    matcher: undefined,
    value: typeof condition.value === "string" ? condition.value : "",
  };
}

export function conditionalBatchEnumOptions(
  field: ConditionalBatchField,
): Array<{ value: string; label: string }> {
  switch (field) {
    case "textRole":
      return [
        { value: "ordinary", label: "일반 대사" },
        { value: "sound", label: "효과음" },
      ];
    case "fontRole":
      return [
        ["dialogue", "대사"],
        ["narration", "내레이션"],
        ["thought", "생각"],
        ["whisper", "속삭임"],
        ["aside_balloon_edge", "말풍선 가장자리"],
        ["emphasis_dialogue", "강조 대사"],
        ["shout", "외침"],
        ["sfx_impact", "충격 효과음"],
        ["sfx_motion", "동작 효과음"],
        ["sfx_ambient", "환경 효과음"],
        ["sfx_emotion", "감정 효과음"],
        ["sfx_comic", "코믹 효과음"],
        ["sign_ui_title", "간판·UI·제목"],
        ["other", "기타"],
        ["unknown_needs_review", "미분류·검수 필요"],
      ].map(([value, label]) => ({ value, label }));
    case "sourceDirection":
    case "renderDirection":
      return [
        { value: "horizontal", label: "가로쓰기" },
        { value: "vertical", label: "세로쓰기" },
      ];
    case "textAlign":
      return [
        { value: "left", label: "왼쪽" },
        { value: "center", label: "가운데" },
        { value: "right", label: "오른쪽" },
      ];
    case "wordBreak":
      return [
        { value: "normal", label: "기본" },
        { value: "break-word", label: "단어 단위" },
        { value: "break-all", label: "글자 단위" },
        { value: "keep-all", label: "한글 단어 유지" },
        { value: "keep-all-overflow", label: "단어 유지·넘침 허용" },
      ];
    case "reviewStatus":
      return [
        { value: "draft", label: "초안" },
        { value: "needs_review", label: "검수 필요" },
        { value: "reviewed", label: "검수 완료" },
      ];
    default:
      return [];
  }
}

export function summarizeCondition(
  condition: ConditionalBatchConditionV2,
  displayValue?: string,
): string {
  const field = CONDITIONAL_BATCH_FIELD_LABELS[condition.field];
  const operator = CONDITIONAL_BATCH_OPERATOR_LABELS[condition.operator];
  const value =
    condition.operator === "regex" || condition.operator === "notRegex"
      ? summarizeTextMatcher(condition.matcher)
      : (displayValue ??
        (condition.value === undefined
          ? ""
          : Array.isArray(condition.value)
            ? condition.value.join(", ")
            : String(condition.value)));
  const end =
    condition.operator === "between"
      ? ` ${value}–${condition.value2 ?? ""}`
      : value
        ? ` “${value}”`
        : "";
  return `${field}이(가) ${operator}${end}`;
}

export function summarizeAction(action: ConditionalBatchActionV2): string {
  if (action.type === "replaceText") {
    return `${summarizeTextMatcher(action.matcher)}을(를) ${summarizeReplacement(action.replacement)}(으)로 ${
      action.allOccurrences ? "모두" : "첫 번째만"
    } 바꾸기`;
  }
  if (action.type === "applyStylePreset") {
    return `${action.presetName} 프리셋 적용`;
  }
  if (action.type === "setFields") {
    return action.changes
      .map(
        (change) =>
          `${CONDITIONAL_BATCH_FIELD_LABELS[change.field]} ${
            change.operation === "clear" ? "초기화" : String(change.value ?? "")
          }`,
      )
      .join(" · ");
  }
  const target =
    action.scope === "allText"
      ? "전체 글자"
      : summarizeTextMatcher(action.matcher);
  return `${target}에 부분 서식 적용`;
}

export function actionStage(action: ConditionalBatchActionV2): 1 | 2 | 3 {
  if (action.type === "replaceText") return 2;
  if (action.type === "styleText") return 3;
  return 1;
}

export function createDefaultAction(
  type: ConditionalBatchActionV2["type"],
): ConditionalBatchActionV2 {
  if (type === "replaceText") {
    return {
      id: createConditionalBatchClientId("action"),
      enabled: true,
      type,
      target: "translatedText",
      matcher: createConditionalLiteralMatcher(""),
      replacement: createConditionalLiteralReplacement(""),
      allOccurrences: true,
    };
  }
  if (type === "setFields") {
    return {
      id: createConditionalBatchClientId("action"),
      enabled: true,
      type,
      changes: [
        { field: "reviewStatus", operation: "set", value: "needs_review" },
      ],
    };
  }
  if (type === "styleText") {
    return {
      id: createConditionalBatchClientId("action"),
      enabled: true,
      type,
      target: "translatedText",
      scope: "allText",
      allOccurrences: true,
      styleMode: "overwrite",
      patch: { bold: true },
    };
  }
  throw new Error("적용할 스타일 프리셋을 먼저 선택하세요.");
}

function summarizeTextMatcher(
  matcher: ConditionalTextMatcherV3 | undefined,
): string {
  if (!matcher) return "패턴";
  if (matcher.mode === "regex") return "고급 패턴";
  if (matcher.nodes.length === 1 && matcher.nodes[0]?.kind === "literal") {
    return `“${matcher.nodes[0].text}”`;
  }
  return matcher.nodes
    .map((node) => {
      if (node.kind === "literal") return `“${node.text}”`;
      if (node.kind === "character") {
        return {
          number: "숫자",
          letter: "글자",
          whitespace: "공백",
          newline: "줄바꿈",
          any: "아무 글자",
        }[node.character];
      }
      if (node.kind === "choice") return node.options.join(" 또는 ");
      if (node.kind === "group") return "묶음";
      return node.boundary === "start" ? "말풍선 처음" : "말풍선 끝";
    })
    .join(" + ");
}

function summarizeReplacement(replacement: ConditionalReplacementV3): string {
  if (replacement.mode === "raw") return "고급 치환";
  if (replacement.parts.length === 0) return "빈 글자";
  return replacement.parts
    .map((part) => (part.kind === "literal" ? `“${part.text}”` : "기억한 부분"))
    .join(" + ");
}
