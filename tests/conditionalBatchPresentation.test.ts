import { beforeAll, expect, it } from "vitest";
import {
  formatConditionalBatchDisplayValue,
  resolveConditionalBatchNumberPresentation,
  summarizeAction,
} from "../src/renderer/src/components/conditionalBatchPresentation";
import type { ConditionalBatchReplaceTextActionV2 } from "../src/shared/conditionalBatchRules";

import { initializeAppI18n } from "../src/renderer/src/appI18n";
beforeAll(() => initializeAppI18n("ko"));

const repeat = { min: 1, max: 1, greedy: true };
const action: ConditionalBatchReplaceTextActionV2 = {
  id: "replacement",
  enabled: true,
  type: "replaceText",
  target: "translatedText",
  allOccurrences: true,
  matcher: {
    mode: "visual",
    caseSensitive: true,
    nodes: [
      { id: "start", kind: "boundary", boundary: "start" },
      { id: "literal", kind: "literal", text: "안녕", repeat },
      { id: "choice", kind: "choice", options: ["나", "너"], repeat },
      {
        id: "group",
        kind: "group",
        nodes: [
          { id: "number", kind: "character", character: "number", repeat },
        ],
        repeat,
      },
      { id: "end", kind: "boundary", boundary: "end" },
    ],
  },
  replacement: { mode: "visual", parts: [] },
};

it("describes compound visual matchers and deletion without exposing AST identifiers", () => {
  expect(summarizeAction(action)).toBe(
    "말풍선 처음 + “안녕” + 나 또는 너 + 묶음 + 말풍선 끝을(를) 빈 글자(으)로 모두 바꾸기",
  );
});

it("distinguishes advanced regex replacement and first-match-only behavior", () => {
  expect(
    summarizeAction({
      ...action,
      matcher: { mode: "regex", source: "a+", caseSensitive: true },
      replacement: { mode: "raw", source: "$&!" },
      allOccurrences: false,
    }),
  ).toBe("고급 패턴을(를) 고급 치환(으)로 첫 번째만 바꾸기");
});

it("shows line height as a percentage like every other format surface", () => {
  const presentation = resolveConditionalBatchNumberPresentation(
    "lineHeight",
    1.18,
  );
  expect(presentation).toMatchObject({ value: 118, step: 1, unit: "%" });
  expect(presentation.toStoredValue(135)).toBe(1.35);
  expect(formatConditionalBatchDisplayValue("lineHeight", 1.2)).toBe("120%");
});
