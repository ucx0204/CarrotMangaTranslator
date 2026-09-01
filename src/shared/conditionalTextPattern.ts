/* eslint-disable complexity, max-lines -- the recursive v3 AST, validation, compiler, and replacement runtime form one compatibility boundary */
import { z } from "zod";

const MAX_CONDITIONAL_PATTERN_NODES = 32;
const MAX_CONDITIONAL_PATTERN_DEPTH = 2;

export type ConditionalPatternRepeatV3 = {
  min: number;
  max: number | null;
  greedy: boolean;
};

type ConditionalPatternNodeBaseV3 = {
  id: string;
  repeat: ConditionalPatternRepeatV3;
  captureId?: string;
};

export type ConditionalPatternNodeV3 =
  | (ConditionalPatternNodeBaseV3 & {
      kind: "literal";
      text: string;
    })
  | (ConditionalPatternNodeBaseV3 & {
      kind: "character";
      character: "number" | "letter" | "whitespace" | "newline" | "any";
    })
  | (ConditionalPatternNodeBaseV3 & {
      kind: "choice";
      options: string[];
    })
  | (ConditionalPatternNodeBaseV3 & {
      kind: "group";
      nodes: ConditionalPatternNodeV3[];
    })
  | {
      id: string;
      kind: "boundary";
      boundary: "start" | "end";
    };

export type ConditionalTextMatcherV3 =
  | {
      mode: "visual";
      caseSensitive: boolean;
      nodes: ConditionalPatternNodeV3[];
    }
  | {
      mode: "regex";
      source: string;
      caseSensitive: boolean;
      multiline?: boolean;
      dotAll?: boolean;
    };

export type ConditionalReplacementPartV3 =
  | { id: string; kind: "literal"; text: string }
  | { id: string; kind: "capture"; captureId: string };

export type ConditionalReplacementV3 =
  | { mode: "visual"; parts: ConditionalReplacementPartV3[] }
  | { mode: "raw"; source: string };

const PatternIdSchema = z.string().trim().min(1).max(200);
const CaptureIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{0,63}$/u, "기억 ID가 올바르지 않습니다.");

const ConditionalPatternRepeatV3Schema = z
  .object({
    min: z.number().int().min(0).max(999),
    max: z.number().int().min(0).max(999).nullable(),
    greedy: z.boolean(),
  })
  .strict()
  .superRefine((repeat, context) => {
    if (repeat.max !== null && repeat.max < repeat.min) {
      context.addIssue({
        code: "custom",
        message: "반복 끝값은 시작값보다 작을 수 없습니다.",
        path: ["max"],
      });
    }
  });

const MatchableNodeBase = {
  id: PatternIdSchema,
  repeat: ConditionalPatternRepeatV3Schema,
  captureId: CaptureIdSchema.optional(),
};

const ConditionalPatternNodeV3Schema: z.ZodType<ConditionalPatternNodeV3> =
  z.lazy(() =>
    z.discriminatedUnion("kind", [
      z
        .object({
          ...MatchableNodeBase,
          kind: z.literal("literal"),
          text: z.string().min(1).max(2_000),
        })
        .strict(),
      z
        .object({
          ...MatchableNodeBase,
          kind: z.literal("character"),
          character: z.enum([
            "number",
            "letter",
            "whitespace",
            "newline",
            "any",
          ]),
        })
        .strict(),
      z
        .object({
          ...MatchableNodeBase,
          kind: z.literal("choice"),
          options: z.array(z.string().min(1).max(200)).min(2).max(16),
        })
        .strict(),
      z
        .object({
          ...MatchableNodeBase,
          kind: z.literal("group"),
          nodes: z.array(ConditionalPatternNodeV3Schema).min(1).max(32),
        })
        .strict(),
      z
        .object({
          id: PatternIdSchema,
          kind: z.literal("boundary"),
          boundary: z.enum(["start", "end"]),
        })
        .strict(),
    ]),
  );

export const ConditionalTextMatcherV3Schema: z.ZodType<ConditionalTextMatcherV3> =
  z
    .discriminatedUnion("mode", [
      z
        .object({
          mode: z.literal("visual"),
          caseSensitive: z.boolean(),
          nodes: z.array(ConditionalPatternNodeV3Schema).min(1).max(32),
        })
        .strict(),
      z
        .object({
          mode: z.literal("regex"),
          source: z.string().min(1).max(2_000),
          caseSensitive: z.boolean(),
          multiline: z.boolean().optional(),
          dotAll: z.boolean().optional(),
        })
        .strict(),
    ])
    .superRefine(validateMatcher);

const ConditionalReplacementPartV3Schema: z.ZodType<ConditionalReplacementPartV3> =
  z.discriminatedUnion("kind", [
    z
      .object({
        id: PatternIdSchema,
        kind: z.literal("literal"),
        text: z.string().max(20_000),
      })
      .strict(),
    z
      .object({
        id: PatternIdSchema,
        kind: z.literal("capture"),
        captureId: CaptureIdSchema,
      })
      .strict(),
  ]);

export const ConditionalReplacementV3Schema: z.ZodType<ConditionalReplacementV3> =
  z.discriminatedUnion("mode", [
    z
      .object({
        mode: z.literal("visual"),
        parts: z.array(ConditionalReplacementPartV3Schema).max(64),
      })
      .strict(),
    z
      .object({
        mode: z.literal("raw"),
        source: z.string().max(20_000),
      })
      .strict(),
  ]);

export type CompiledConditionalTextMatcher = {
  source: string;
  flags: string;
  captureNames: ReadonlyMap<string, string>;
};

export type ConditionalTextMatchRange = {
  start: number;
  end: number;
  text: string;
  replacement: string;
  captures: Readonly<Record<string, string>>;
};

export function createConditionalPatternId(prefix = "part"): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createConditionalCaptureId(): string {
  return `memory-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createConditionalLiteralMatcher(
  text: string,
  caseSensitive = true,
): ConditionalTextMatcherV3 {
  return {
    mode: "visual",
    caseSensitive,
    nodes: [
      {
        id: createConditionalPatternId("literal"),
        kind: "literal",
        text,
        repeat: createConditionalPatternRepeat(),
      },
    ],
  };
}

export function createConditionalLiteralReplacement(
  text: string,
): ConditionalReplacementV3 {
  return {
    mode: "visual",
    parts: [
      {
        id: createConditionalPatternId("replacement"),
        kind: "literal",
        text,
      },
    ],
  };
}

export function createConditionalPatternRepeat(
  overrides: Partial<ConditionalPatternRepeatV3> = {},
): ConditionalPatternRepeatV3 {
  return { min: 1, max: 1, greedy: true, ...overrides };
}

export function tryConvertConditionalRegexToVisual(
  matcher: ConditionalTextMatcherV3,
  replacement?: ConditionalReplacementV3,
): {
  matcher: ConditionalTextMatcherV3;
  replacement?: ConditionalReplacementV3;
} | null {
  if (matcher.mode !== "regex" || matcher.multiline || matcher.dotAll) {
    return null;
  }
  if (replacement?.mode === "raw" && replacement.source.includes("$")) {
    return null;
  }
  const nodes = parseSupportedRegexNodes(matcher.source);
  if (!nodes?.length) return null;
  return {
    matcher: { mode: "visual", caseSensitive: matcher.caseSensitive, nodes },
    ...(replacement
      ? {
          replacement:
            replacement.mode === "raw"
              ? createConditionalLiteralReplacement(replacement.source)
              : replacement,
        }
      : {}),
  };
}

export function compileConditionalTextMatcher(
  matcher: ConditionalTextMatcherV3,
  options: { global?: boolean } = {},
): CompiledConditionalTextMatcher {
  const parsed = ConditionalTextMatcherV3Schema.parse(matcher);
  if (parsed.mode === "regex") {
    return {
      source: parsed.source,
      flags: matcherFlags(parsed, options.global),
      captureNames: new Map(),
    };
  }
  const captureNames = new Map<string, string>();
  return {
    source: parsed.nodes
      .map((node) => compilePatternNode(node, captureNames))
      .join(""),
    flags: matcherFlags(parsed, options.global),
    captureNames,
  };
}

function createConditionalTextRegExp(
  matcher: ConditionalTextMatcherV3,
  options: { global?: boolean } = {},
): RegExp {
  const compiled = compileConditionalTextMatcher(matcher, options);
  return new RegExp(compiled.source, compiled.flags);
}

export function testConditionalTextMatcher(
  value: string,
  matcher: ConditionalTextMatcherV3,
): boolean {
  return createConditionalTextRegExp(matcher).test(value);
}

export function findConditionalTextMatches(
  value: string,
  matcher: ConditionalTextMatcherV3,
  replacement: ConditionalReplacementV3 | null,
  allOccurrences: boolean,
): ConditionalTextMatchRange[] {
  const compiled = compileConditionalTextMatcher(matcher, { global: true });
  const pattern = new RegExp(compiled.source, compiled.flags);
  const ranges: ConditionalTextMatchRange[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value))) {
    const captures = readVisualCaptures(match, compiled.captureNames);
    ranges.push({
      start: match.index,
      end: match.index + match[0].length,
      text: match[0],
      replacement: replacement
        ? resolveConditionalReplacement(
            replacement,
            match,
            compiled.captureNames,
          )
        : "",
      captures,
    });
    if (!allOccurrences) break;
    if (match[0].length === 0) {
      pattern.lastIndex = advanceStringIndex(value, pattern.lastIndex);
    }
  }
  return ranges;
}

export function validateConditionalReplacementReferences(
  matcher: ConditionalTextMatcherV3,
  replacement: ConditionalReplacementV3,
): string | null {
  if (replacement.mode === "raw") return null;
  const captures = collectCaptureIds(matcher);
  const missing = replacement.parts.find(
    (part) => part.kind === "capture" && !captures.has(part.captureId),
  );
  return missing?.kind === "capture"
    ? `찾기 패턴에 없는 기억을 사용했습니다: ${missing.captureId}`
    : null;
}

export function collectCaptureIds(
  matcher: ConditionalTextMatcherV3,
): ReadonlySet<string> {
  if (matcher.mode === "regex") return new Set();
  const captures = new Set<string>();
  walkPatternNodes(matcher.nodes, (node) => {
    if ("captureId" in node && node.captureId) captures.add(node.captureId);
  });
  return captures;
}

function validateMatcher(
  matcher: ConditionalTextMatcherV3,
  context: z.RefinementCtx,
): void {
  if (matcher.mode === "regex") {
    try {
      new RegExp(matcher.source, matcherFlags(matcher, false));
    } catch (error) {
      context.addIssue({
        code: "custom",
        message:
          "정규식이 올바르지 않습니다: " +
          (error instanceof Error ? error.message : String(error)),
        path: ["source"],
      });
    }
    return;
  }
  let count = 0;
  let depthExceeded = false;
  const captures = new Set<string>();
  const duplicateCaptures = new Set<string>();
  walkPatternNodes(matcher.nodes, (node, depth) => {
    count += 1;
    if (depth > MAX_CONDITIONAL_PATTERN_DEPTH) depthExceeded = true;
    if ("captureId" in node && node.captureId) {
      if (captures.has(node.captureId)) duplicateCaptures.add(node.captureId);
      captures.add(node.captureId);
    }
  });
  if (count > MAX_CONDITIONAL_PATTERN_NODES) {
    context.addIssue({
      code: "custom",
      message: `패턴 조각은 최대 ${MAX_CONDITIONAL_PATTERN_NODES}개까지 사용할 수 있습니다.`,
      path: ["nodes"],
    });
  }
  if (depthExceeded) {
    context.addIssue({
      code: "custom",
      message: `패턴 묶음은 ${MAX_CONDITIONAL_PATTERN_DEPTH}단계까지만 넣을 수 있습니다.`,
      path: ["nodes"],
    });
  }
  if (duplicateCaptures.size > 0) {
    context.addIssue({
      code: "custom",
      message: `같은 기억 ID를 두 번 사용할 수 없습니다: ${[...duplicateCaptures][0]}`,
      path: ["nodes"],
    });
  }
}

function parseSupportedRegexNodes(
  source: string,
): ConditionalPatternNodeV3[] | null {
  const nodes: ConditionalPatternNodeV3[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    if (cursor === 0 && source[cursor] === "^") {
      nodes.push({
        id: createConditionalPatternId("start"),
        kind: "boundary",
        boundary: "start",
      });
      cursor += 1;
      continue;
    }
    if (source.slice(cursor) === "(?![\\s\\S])") {
      nodes.push({
        id: createConditionalPatternId("end"),
        kind: "boundary",
        boundary: "end",
      });
      cursor = source.length;
      continue;
    }
    const token = readSupportedRegexToken(source, cursor);
    if (!token) return null;
    const quantified = readSupportedRegexRepeat(source, token.end);
    nodes.push({ ...token.node, repeat: quantified.repeat });
    cursor = quantified.end;
  }
  return mergeAdjacentLiteralNodes(nodes);
}

function readSupportedRegexToken(
  source: string,
  cursor: number,
): {
  node: Extract<ConditionalPatternNodeV3, { kind: "literal" | "character" }>;
  end: number;
} | null {
  const patterns = [
    ["\\p{N}", "number"],
    ["\\p{L}", "letter"],
    ["[^\\S\\r\\n]", "whitespace"],
    ["(?:\\r\\n|[\\r\\n])", "newline"],
    ["[^\\r\\n]", "any"],
  ] as const;
  for (const [pattern, character] of patterns) {
    if (source.startsWith(pattern, cursor)) {
      return {
        node: {
          id: createConditionalPatternId(character),
          kind: "character",
          character,
          repeat: createConditionalPatternRepeat(),
        },
        end: cursor + pattern.length,
      };
    }
  }
  if (source[cursor] === "\\") {
    const escaped = source[cursor + 1];
    if (!escaped || !/[.*+?^${}()|[\]\\]/u.test(escaped)) return null;
    return {
      node: {
        id: createConditionalPatternId("literal"),
        kind: "literal",
        text: escaped,
        repeat: createConditionalPatternRepeat(),
      },
      end: cursor + 2,
    };
  }
  const codePoint = source.codePointAt(cursor);
  if (codePoint === undefined) return null;
  const text = String.fromCodePoint(codePoint);
  if (/[.*+?^${}()|[\]\\]/u.test(text)) return null;
  return {
    node: {
      id: createConditionalPatternId("literal"),
      kind: "literal",
      text,
      repeat: createConditionalPatternRepeat(),
    },
    end: cursor + text.length,
  };
}

function readSupportedRegexRepeat(
  source: string,
  cursor: number,
): { repeat: ConditionalPatternRepeatV3; end: number } {
  const rest = source.slice(cursor);
  let min = 1;
  let max: number | null = 1;
  let length = 0;
  if (rest.startsWith("?")) [min, max, length] = [0, 1, 1];
  else if (rest.startsWith("*")) [min, max, length] = [0, null, 1];
  else if (rest.startsWith("+")) [min, max, length] = [1, null, 1];
  else {
    const counted = /^\{(\d+)(?:,(\d*)?)?\}/u.exec(rest);
    if (counted) {
      min = Number(counted[1]);
      max =
        counted[2] === undefined ? min : counted[2] ? Number(counted[2]) : null;
      length = counted[0].length;
    }
  }
  const lazy = length > 0 && rest[length] === "?";
  return {
    repeat: createConditionalPatternRepeat({ min, max, greedy: !lazy }),
    end: cursor + length + (lazy ? 1 : 0),
  };
}

function mergeAdjacentLiteralNodes(
  nodes: ConditionalPatternNodeV3[],
): ConditionalPatternNodeV3[] {
  const merged: ConditionalPatternNodeV3[] = [];
  for (const node of nodes) {
    const previous = merged.at(-1);
    if (
      previous?.kind === "literal" &&
      node.kind === "literal" &&
      isDefaultRepeat(previous.repeat) &&
      isDefaultRepeat(node.repeat)
    ) {
      previous.text += node.text;
    } else {
      merged.push(node);
    }
  }
  return merged;
}

function isDefaultRepeat(repeat: ConditionalPatternRepeatV3): boolean {
  return repeat.min === 1 && repeat.max === 1 && repeat.greedy;
}

function compilePatternNode(
  node: ConditionalPatternNodeV3,
  captureNames: Map<string, string>,
): string {
  if (node.kind === "boundary") {
    return node.boundary === "start" ? "^" : "(?![\\s\\S])";
  }
  let source: string;
  if (node.kind === "literal") {
    source = escapeRegExp(node.text);
  } else if (node.kind === "character") {
    source = CHARACTER_SOURCES[node.character];
  } else if (node.kind === "choice") {
    source = `(?:${node.options.map(escapeRegExp).join("|")})`;
  } else {
    source = `(?:${node.nodes
      .map((child) => compilePatternNode(child, captureNames))
      .join("")})`;
  }
  if (node.kind === "literal" && [...node.text].length > 1) {
    source = `(?:${source})`;
  }
  source = applyRepeat(source, node.repeat);
  if (node.captureId) {
    const name = captureNameForId(node.captureId);
    captureNames.set(node.captureId, name);
    source = `(?<${name}>${source})`;
  }
  return source;
}

function applyRepeat(
  source: string,
  repeat: ConditionalPatternRepeatV3,
): string {
  if (repeat.min === 1 && repeat.max === 1) return source;
  const atom = needsRepeatGroup(source) ? `(?:${source})` : source;
  let suffix: string;
  if (repeat.min === 0 && repeat.max === 1) suffix = "?";
  else if (repeat.min === 0 && repeat.max === null) suffix = "*";
  else if (repeat.min === 1 && repeat.max === null) suffix = "+";
  else if (repeat.max === repeat.min) suffix = `{${repeat.min}}`;
  else if (repeat.max === null) suffix = `{${repeat.min},}`;
  else suffix = `{${repeat.min},${repeat.max}}`;
  const canBeLazy = repeat.max === null || repeat.max !== repeat.min;
  return atom + suffix + (!repeat.greedy && canBeLazy ? "?" : "");
}

function resolveConditionalReplacement(
  replacement: ConditionalReplacementV3,
  match: RegExpExecArray,
  captureNames: ReadonlyMap<string, string>,
): string {
  if (replacement.mode === "raw") {
    return expandRegexReplacement(replacement.source, match);
  }
  return replacement.parts
    .map((part) => {
      if (part.kind === "literal") return part.text;
      const name = captureNames.get(part.captureId);
      return name ? (match.groups?.[name] ?? "") : "";
    })
    .join("");
}

function readVisualCaptures(
  match: RegExpExecArray,
  captureNames: ReadonlyMap<string, string>,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    [...captureNames].map(([id, name]) => [id, match.groups?.[name] ?? ""]),
  );
}

function expandRegexReplacement(
  replacement: string,
  match: RegExpExecArray,
): string {
  return replacement.replace(
    /\$(\$|&|[1-9][0-9]?|<[^>]+>)/gu,
    (token, reference: string) => {
      if (reference === "$") return "$";
      if (reference === "&") return match[0];
      if (reference.startsWith("<")) {
        return match.groups?.[reference.slice(1, -1)] ?? token;
      }
      return match[Number(reference)] ?? token;
    },
  );
}

function matcherFlags(
  matcher: ConditionalTextMatcherV3,
  global = false,
): string {
  return `${global ? "g" : ""}${matcher.caseSensitive ? "" : "i"}${matcher.mode === "regex" && matcher.multiline ? "m" : ""}${matcher.mode === "regex" && matcher.dotAll ? "s" : ""}u`;
}

function captureNameForId(id: string): string {
  return `cb_${id.replaceAll("_", "_u").replaceAll("-", "_h")}`;
}

function walkPatternNodes(
  nodes: readonly ConditionalPatternNodeV3[],
  visit: (node: ConditionalPatternNodeV3, depth: number) => void,
  depth = 1,
): void {
  for (const node of nodes) {
    visit(node, depth);
    if (node.kind === "group") {
      walkPatternNodes(node.nodes, visit, depth + 1);
    }
  }
}

function advanceStringIndex(value: string, index: number): number {
  if (index >= value.length) return index + 1;
  const codePoint = value.codePointAt(index);
  return index + (codePoint !== undefined && codePoint > 0xffff ? 2 : 1);
}

function needsRepeatGroup(source: string): boolean {
  return !(
    source.startsWith("(?:") ||
    source.startsWith("[") ||
    source.startsWith("\\p{") ||
    source.startsWith("\\P{")
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

const CHARACTER_SOURCES: Record<
  Extract<ConditionalPatternNodeV3, { kind: "character" }>["character"],
  string
> = {
  number: "\\p{N}",
  letter: "\\p{L}",
  whitespace: "[^\\S\\r\\n]",
  newline: "(?:\\r\\n|[\\r\\n])",
  any: "[^\\r\\n]",
};
