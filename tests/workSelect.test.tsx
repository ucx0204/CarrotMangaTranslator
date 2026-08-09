/** @vitest-environment jsdom */

import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { LibraryIndex } from "../src/shared/libraryTypes";
import { WorkSelect } from "../src/renderer/src/components/WorkSelect";

afterEach(cleanup);

describe("WorkSelect", () => {
  it("searches works and exposes library, title, and recent ordering", () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole("combobox", { name: "작품 선택" }));
    expect(optionNames()).toEqual(["Charlie", "Alpha", "Bravo"]);

    fireEvent.click(screen.getByRole("button", { name: "이름순" }));
    expect(optionNames()).toEqual(["Alpha", "Bravo", "Charlie"]);

    fireEvent.click(screen.getByRole("button", { name: "최근 수정" }));
    expect(optionNames()).toEqual(["Bravo", "Charlie", "Alpha"]);

    fireEvent.change(screen.getByRole("searchbox", { name: "작품 검색" }), {
      target: { value: "Charlie" },
    });
    expect(optionNames()).toEqual(["Charlie"]);
    fireEvent.click(screen.getByRole("option", { name: "Charlie" }));

    expect(
      (screen.getByRole("combobox", { name: "작품 선택" }) as HTMLButtonElement)
        .value,
    ).toBe("charlie");
  });
});

function Harness(): React.JSX.Element {
  const [value, setValue] = React.useState("alpha");
  return (
    <WorkSelect
      ariaLabel="작품 선택"
      library={LIBRARY}
      value={value}
      onValueChange={setValue}
    />
  );
}

function optionNames(): string[] {
  return within(screen.getByRole("listbox", { name: "작품 선택" }))
    .getAllByRole("option")
    .map((option) => option.getAttribute("aria-label") ?? "");
}

const LIBRARY: LibraryIndex = {
  workOrder: ["charlie", "alpha", "bravo"],
  works: [
    makeWork("alpha", "Alpha", "2026-01-01T00:00:00.000Z"),
    makeWork("bravo", "Bravo", "2026-03-01T00:00:00.000Z"),
    makeWork("charlie", "Charlie", "2026-02-01T00:00:00.000Z"),
  ],
};

function makeWork(id: string, title: string, updatedAt: string) {
  return {
    id,
    title,
    chapterOrder: [],
    chapters: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt,
  };
}
