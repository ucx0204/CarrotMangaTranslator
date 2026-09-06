/** @vitest-environment jsdom */
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ConditionalPatternBuilder } from "../src/renderer/src/components/ConditionalPatternBuilder";
import {
  createConditionalLiteralMatcher,
  createConditionalLiteralReplacement,
  findConditionalTextMatches,
} from "../src/shared/conditionalTextPattern";

afterEach(cleanup);

it.each(["정확히 N개", "N~M개"])(
  "keeps %s editable even when counts overlap a preset",
  (label) => {
    function Fixture() {
      const [matcher, setMatcher] = React.useState(
        createConditionalLiteralMatcher("a"),
      );
      return (
        <ConditionalPatternBuilder
          matcher={matcher}
          onChangeMatcher={setMatcher}
        />
      );
    }
    render(<Fixture />);
    fireEvent.click(screen.getByLabelText("패턴 조각 추가"));
    fireEvent.click(screen.getByRole("button", { name: "반복·기억 설정" }));
    fireEvent.click(screen.getByRole("combobox", { name: "반복 횟수" }));
    fireEvent.click(screen.getByRole("option", { name: label }));
    expect(
      screen.getByRole("combobox", { name: "반복 횟수" }).textContent,
    ).toContain(label);
    fireEvent.change(screen.getByLabelText("최소 반복"), {
      target: { value: "0" },
    });
    expect(screen.getByLabelText("최소 반복")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("최소 반복"), {
      target: { value: "1" },
    });
    expect(screen.getByLabelText("최소 반복")).toBeTruthy();
    if (label === "N~M개") {
      expect(screen.getByLabelText("최대 반복")).toBeTruthy();
    }
  },
);

it.each(["$&", "$$", "$1", "$<name>", "$` $'"])(
  "preserves literal replacement %s when switching to raw code",
  (text) => {
    const matcher = createConditionalLiteralMatcher("abc");
    const replacement = createConditionalLiteralReplacement(text);
    const onSwitchToRaw = vi.fn();
    render(
      <ConditionalPatternBuilder
        matcher={matcher}
        replacement={replacement}
        onChangeMatcher={() => {}}
        onChangeReplacement={() => {}}
        onSwitchToRaw={onSwitchToRaw}
      />,
    );
    fireEvent.click(screen.getByText("정규식 코드 보기"));
    fireEvent.click(screen.getByRole("button", { name: "직접 수정" }));
    const [rawMatcher, rawReplacement] = onSwitchToRaw.mock.calls[0];
    expect(
      findConditionalTextMatches("abc", rawMatcher, rawReplacement, true)[0]
        .replacement,
    ).toBe(text);
  },
);

it("preserves a captured part beside literal dollar references", () => {
  const matcher = createConditionalLiteralMatcher("abc");
  if (matcher.mode !== "visual") throw new Error("Expected visual matcher");
  matcher.nodes[0] = {
    ...matcher.nodes[0],
    captureId: "word",
  } as (typeof matcher.nodes)[number];
  const replacement = createConditionalLiteralReplacement("$1/");
  if (replacement.mode !== "visual")
    throw new Error("Expected visual replacement");
  replacement.parts.push({ id: "capture", kind: "capture", captureId: "word" });
  const onSwitchToRaw = vi.fn();
  render(
    <ConditionalPatternBuilder
      matcher={matcher}
      replacement={replacement}
      onChangeMatcher={() => {}}
      onChangeReplacement={() => {}}
      onSwitchToRaw={onSwitchToRaw}
    />,
  );
  fireEvent.click(screen.getByText("정규식 코드 보기"));
  fireEvent.click(screen.getByRole("button", { name: "직접 수정" }));
  const [rawMatcher, rawReplacement] = onSwitchToRaw.mock.calls[0];
  expect(
    findConditionalTextMatches("abc", rawMatcher, rawReplacement, true)[0]
      .replacement,
  ).toBe("$1/abc");
});
