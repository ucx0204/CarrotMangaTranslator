import { describe, expect, it } from "vitest";
import {
  formatConditionalBatchValidationIssue,
  formatConditionalBatchYamlSyntaxError,
} from "../src/shared/conditionalBatchErrorPresentation";
import {
  ConditionalBatchSchemeDraftV2Schema,
  createConditionalBatchRecipeDraft,
} from "../src/shared/conditionalBatchRules";

describe("conditional batch validation presentation", () => {
  it("keeps an empty visual find pattern as a safe no-match draft", () => {
    const draft = createConditionalBatchRecipeDraft("findReplace", {
      find: "",
      replace: "",
    });
    const parsed = ConditionalBatchSchemeDraftV2Schema.safeParse(draft);
    expect(parsed.success).toBe(true);
  });

  it("keeps explicit Korean rule errors and hides generic schema English", () => {
    const custom = formatConditionalBatchValidationIssue({
      code: "custom",
      path: ["match", "conditions"],
      message: "대상 조건을 확인하세요.",
    });
    const generic = formatConditionalBatchValidationIssue({
      code: "invalid_type",
      path: ["actions", 0, "target"],
      message: "Invalid input: expected string",
      expected: "string",
      received: "number",
    });

    expect(custom).toBe("대상 조건을 확인하세요.");
    expect(generic).toBe("입력값의 종류가 올바르지 않습니다.");
  });

  it("presents YAML syntax locations without leaking parser English", () => {
    expect(
      formatConditionalBatchYamlSyntaxError({
        message: "Unexpected flow-seq-end token",
        linePos: [{ line: 7, col: 12 }],
      }),
    ).toBe("YAML 문법을 확인하세요. (7행 12열)");
  });
});
