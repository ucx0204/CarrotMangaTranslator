import type { ZodIssue } from "zod";

const HANGUL_PATTERN = /[가-힣]/u;
type ValidationIssueFormatter = (path: readonly string[]) => string;

const VALIDATION_ISSUE_FORMATTERS: Readonly<
  Record<string, ValidationIssueFormatter>
> = {
  too_small: formatTooSmallIssue,
  too_big: () => "입력값이 허용된 길이나 개수를 넘었습니다.",
  invalid_format: formatInvalidInputIssue,
  invalid_string: formatInvalidInputIssue,
  invalid_type: () => "입력값의 종류가 올바르지 않습니다.",
  invalid_value: () => "지원하는 값 중 하나를 선택하세요.",
  invalid_enum_value: () => "지원하는 값 중 하나를 선택하세요.",
  unrecognized_keys: () => "지원하지 않는 항목이 포함되어 있습니다.",
  invalid_union: () => "입력값을 확인하세요.",
};

/** Keep validation implementation details out of the user-facing rule UI. */
export function formatConditionalBatchValidationIssue(
  issue: ZodIssue | undefined,
): string | null {
  if (!issue) return null;
  const code = String(issue.code);
  if (code === "custom" && HANGUL_PATTERN.test(issue.message)) {
    return issue.message;
  }
  const path = issue.path.map(String);
  const formatter = VALIDATION_ISSUE_FORMATTERS[code];
  if (formatter) return formatter(path);
  return HANGUL_PATTERN.test(issue.message)
    ? issue.message
    : "규칙 값을 확인하세요.";
}

function formatTooSmallIssue(path: readonly string[]): string {
  if (path.includes("name")) return "규칙 이름을 입력하세요.";
  if (path.includes("presetName")) return "프리셋 이름을 입력하세요.";
  if (path.includes("groupIds")) {
    return "적용할 서식 항목을 하나 이상 선택하세요.";
  }
  if (isMatcherPath(path)) return "찾을 글자를 입력하세요.";
  if (path.includes("conditions")) return "조건을 하나 이상 추가하세요.";
  return "필수 값을 입력하세요.";
}

function formatInvalidInputIssue(path: readonly string[]): string {
  return isColorPath(path)
    ? "색상은 #RRGGBB 형식으로 입력하세요."
    : "입력 형식을 확인하세요.";
}

export function formatConditionalBatchYamlSyntaxError(issue: unknown): string {
  const position = readYamlPosition(issue);
  return position
    ? `YAML 문법을 확인하세요. (${position.line}행 ${position.col}열)`
    : "YAML 문법을 확인하세요.";
}

function isMatcherPath(path: readonly string[]): boolean {
  return (
    path.includes("matcher") ||
    path.includes("nodes") ||
    path.includes("source")
  );
}

function isColorPath(path: readonly string[]): boolean {
  return path.some((part) => part.toLowerCase().includes("color"));
}

function readYamlPosition(
  issue: unknown,
): { line: number; col: number } | null {
  if (!issue || typeof issue !== "object") return null;
  const linePos = (issue as { linePos?: unknown }).linePos;
  if (!Array.isArray(linePos)) return null;
  const first = linePos[0];
  if (!first || typeof first !== "object") return null;
  const line = (first as { line?: unknown }).line;
  const col = (first as { col?: unknown }).col;
  return typeof line === "number" && typeof col === "number"
    ? { line, col }
    : null;
}
