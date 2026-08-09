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
import { Select } from "../src/renderer/src/components/ui/Select";
import type { SelectOption } from "../src/renderer/src/components/ui/selectTypes";

afterEach(cleanup);

describe("Select", () => {
  it("opens an app-owned listbox and commits a pointer selection", () => {
    const onValueChange = vi.fn();
    render(
      <Select
        ariaLabel="품질"
        value="minimum"
        options={[
          { value: "minimum", label: "최소" },
          { value: "economy", label: "절약" },
          { value: "full", label: "풀로드" },
        ]}
        onValueChange={onValueChange}
      />,
    );

    const trigger = screen.getByRole("combobox", { name: "품질" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);

    const listbox = screen.getByRole("listbox", { name: "품질" });
    expect(listbox.closest("[data-ui-select-menu]")?.parentElement).toBe(
      document.body,
    );
    fireEvent.click(within(listbox).getByRole("option", { name: "풀로드" }));

    expect(onValueChange).toHaveBeenCalledWith("full");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("supports keyboard navigation and skips disabled options", () => {
    function Harness(): React.JSX.Element {
      const [value, setValue] = React.useState("first");
      return (
        <Select
          ariaLabel="정렬"
          value={value}
          options={[
            { value: "first", label: "첫째" },
            { value: "disabled", label: "선택 불가", disabled: true },
            { value: "last", label: "마지막" },
          ]}
          onValueChange={setValue}
        />
      );
    }
    render(<Harness />);

    const trigger = screen.getByRole("combobox", { name: "정렬" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(trigger.getAttribute("aria-activedescendant")).toContain("last");
    fireEvent.keyDown(trigger, { key: "Enter" });

    expect((trigger as HTMLButtonElement).value).toBe("last");
    expect(trigger.textContent).toContain("마지막");
  });

  it("filters long option lists through the built-in search field", () => {
    const options: SelectOption[] = Array.from({ length: 12 }, (_, index) => ({
      value: String(index + 1),
      label: `작품 ${index + 1}`,
    }));
    render(
      <Select
        ariaLabel="작품"
        value="1"
        options={options}
        searchPlaceholder="작품 검색"
        onValueChange={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("combobox", { name: "작품" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "작품 검색" }), {
      target: { value: "작품 12" },
    });

    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("option", { name: "작품 12" })).toBeTruthy();
  });
});
