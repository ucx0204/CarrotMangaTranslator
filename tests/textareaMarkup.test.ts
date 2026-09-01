import { describe, expect, it } from "vitest";
import {
  applyInlineBooleanStyleTag,
  applyInlineMarkup,
  applyInlineStyleTag,
  removeInlineBooleanStyleTag,
  removeInlineStyleTag,
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

  it.each([
    ["underline", "[underline]나[/underline]"],
    ["strike", "[strike]나[/strike]"],
    ["emphasis", "[emphasis]나[/emphasis]"],
  ] as const)("wraps a selection with a %s boolean tag", (name, expected) => {
    expect(applyInlineBooleanStyleTag("가나다", 2, 1, name)).toEqual({
      value: `가${expected}다`,
      selectionStart: expected.indexOf("나") + 1,
      selectionEnd: expected.indexOf("나") + 2,
    });
  });

  it("removes an enclosing style tag while preserving nested styles", () => {
    const value =
      "가[background=#ffeeaa][outer-outline-width=3]나다[/outer-outline-width][/background]라";
    const start = value.indexOf("나다");
    const expected = "가[outer-outline-width=3]나다[/outer-outline-width]라";
    expect(removeInlineStyleTag(value, start, start + 2, "background")).toEqual(
      {
        value: expected,
        selectionStart: expected.indexOf("나다"),
        selectionEnd: expected.indexOf("나다") + 2,
      },
    );
  });

  it("removes the nearest matching boolean tag around the selection", () => {
    const value = "가[underline][emphasis]나[/emphasis][/underline]다";
    const start = value.indexOf("나");
    const expected = "가[emphasis]나[/emphasis]다";
    expect(
      removeInlineBooleanStyleTag(value, start, start + 1, "underline"),
    ).toEqual({
      value: expected,
      selectionStart: expected.indexOf("나"),
      selectionEnd: expected.indexOf("나") + 1,
    });
  });

  it("leaves a selection unchanged when the requested tag does not enclose it", () => {
    expect(removeInlineStyleTag("가나다", 2, 1, "color")).toEqual({
      value: "가나다",
      selectionStart: 1,
      selectionEnd: 2,
    });
  });

  it("removes only the innermost same-name tag and ignores unmatched closers", () => {
    const nested = "[color=#111111][color=#222222]나[/color][/color]";
    const nestedStart = nested.indexOf("나");
    const expectedNested = "[color=#111111]나[/color]";
    expect(
      removeInlineStyleTag(nested, nestedStart, nestedStart + 1, "color"),
    ).toEqual({
      value: expectedNested,
      selectionStart: expectedNested.indexOf("나"),
      selectionEnd: expectedNested.indexOf("나") + 1,
    });

    const malformed = "[/underline][underline]나[/underline]";
    const malformedStart = malformed.indexOf("나");
    expect(
      removeInlineBooleanStyleTag(
        malformed,
        malformedStart,
        malformedStart + 1,
        "underline",
      ),
    ).toEqual({
      value: "[/underline]나",
      selectionStart: "[/underline]".length,
      selectionEnd: "[/underline]".length + 1,
    });
  });
});
