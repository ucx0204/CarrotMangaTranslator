/** @vitest-environment jsdom */

import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConditionalBatchSetFieldsEditor } from "../src/renderer/src/components/ConditionalBatchSetFieldsEditor";
import { summarizeAction } from "../src/renderer/src/components/conditionalBatchUi";
import type {
  ConditionalBatchActionV2,
  ConditionalBatchSetFieldsActionV2,
} from "../src/shared/conditionalBatchRules";

afterEach(cleanup);

describe("conditional batch property editor", () => {
  it("presents boolean results as explicit on, off, and unset choices", () => {
    const onChange = vi.fn();
    render(
      <StatefulSetFieldsEditor
        initial={createAction("bold", true)}
        onChange={onChange}
      />,
    );

    expect(screen.queryByText("방법")).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "켜기" })).toBeNull();
    const result = screen.getByRole("radiogroup", {
      name: "굵게 적용 결과",
    });
    expect(
      within(result)
        .getByRole("radio", { name: "켜기" })
        .getAttribute("aria-checked"),
    ).toBe("true");

    fireEvent.click(within(result).getByRole("radio", { name: "끄기" }));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        changes: [{ field: "bold", operation: "set", value: false }],
      }),
    );
    fireEvent.click(within(result).getByRole("radio", { name: "해제" }));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        changes: [{ field: "bold", operation: "clear" }],
      }),
    );
  });

  it("shows normalized numeric properties in human-readable units", () => {
    const onChange = vi.fn();
    render(
      <StatefulSetFieldsEditor
        initial={createAction("textOpacity", 0.5)}
        onChange={onChange}
      />,
    );

    const input = screen.getByRole("spinbutton", {
      name: "불투명도 적용할 값",
    }) as HTMLInputElement;
    expect(input.value).toBe("50");
    expect(screen.getByText("입력 범위 0%–100%")).toBeTruthy();
    fireEvent.change(input, { target: { value: "75" } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        changes: [{ field: "textOpacity", operation: "set", value: 0.75 }],
      }),
    );
  });

  it("summarizes property results with labels instead of raw values", () => {
    expect(summarizeAction(createAction("italic", false))).toBe("기울임 끄기");
    expect(summarizeAction(createAction("textOpacity", 0.65))).toBe(
      "불투명도 65%",
    );
    expect(
      summarizeAction({
        ...createAction("bold", true),
        changes: [{ field: "bold", operation: "clear" }],
      }),
    ).toBe("굵게 지정 해제");
  });
});

function StatefulSetFieldsEditor({
  initial,
  onChange,
}: {
  initial: ConditionalBatchSetFieldsActionV2;
  onChange: (action: ConditionalBatchActionV2) => void;
}): React.JSX.Element {
  const [action, setAction] = React.useState(initial);
  return (
    <ConditionalBatchSetFieldsEditor
      action={action}
      onChange={(next) => {
        if (next.type === "setFields") setAction(next);
        onChange(next);
      }}
    />
  );
}

function createAction(
  field: "bold" | "italic" | "textOpacity",
  value: boolean | number,
): ConditionalBatchSetFieldsActionV2 {
  return {
    id: "set-fields",
    enabled: true,
    type: "setFields",
    changes: [{ field, operation: "set", value }],
  };
}
