import { describe, expect, it } from "vitest";
import {
  applyInlineMarkup,
  applyInlineStyleTag,
} from "../src/renderer/src/lib/textareaMarkup";

describe("textarea inline markup", () => {
  it("wraps a selection and keeps the selected text selected", () => {
    expect(applyInlineMarkup("가나다", 1, 2, "**")).toEqual({
      value: "가**나**다",
      selectionStart: 3,
      selectionEnd: 4,
    });
  });

  it("inserts an empty marker pair at a collapsed caret", () => {
    expect(applyInlineMarkup("가다", 1, 1, "*")).toEqual({
      value: "가**다",
      selectionStart: 2,
      selectionEnd: 2,
    });
  });

  it("normalizes reversed and out-of-range selections", () => {
    expect(applyInlineMarkup("abcd", 99, 1, "_")).toEqual({
      value: "a_bcd_",
      selectionStart: 2,
      selectionEnd: 5,
    });
    expect(applyInlineMarkup("abcd", Number.NaN, -10, "_")).toEqual({
      value: "_abcd_",
      selectionStart: 1,
      selectionEnd: 5,
    });
  });

  it.each([
    ["size", 48.5, "[size=48.5]나[/size]"],
    ["font", "nanum-gothic", "[font=nanum-gothic]나[/font]"],
    ["opacity", 75, "[opacity=75]나[/opacity]"],
  ] as const)("wraps a selection with a %s tag", (name, tagValue, expected) => {
    expect(applyInlineStyleTag("가나다", 1, 2, name, tagValue)).toEqual({
      value: `가${expected}다`,
      selectionStart: expected.indexOf("나") + 1,
      selectionEnd: expected.indexOf("나") + 2,
    });
  });
});
