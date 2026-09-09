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
import { appI18n } from "../src/renderer/src/appI18n";
import { ConditionalBatchSetFieldsEditor } from "../src/renderer/src/components/ConditionalBatchSetFieldsEditor";
import { TextWrappingSelect } from "../src/renderer/src/components/TextWrappingSelect";
import { summarizeAction } from "../src/renderer/src/components/conditionalBatchUi";
import {
  ConditionalBatchSchemeDraftV2Schema,
  createBlankBatchSchemeDraft,
  type ConditionalBatchActionV2,
  type ConditionalBatchSetFieldsActionV2,
} from "../src/shared/conditionalBatchRules";
import {
  applyConditionalBatchPreview,
  createConditionalBatchPreview,
} from "../src/shared/conditionalBatchEngine";
import { TranslationBlockSchema } from "../src/shared/ipcSchemaPrimitives";
import { measureStyledWrappedText } from "../src/renderer/src/lib/overlayTextWrapping";
import {
  resolveBlockTextWordBreak,
  type TextWordBreak,
} from "../src/shared/textWrapping";
import { BatchFonts, batchChapter } from "./fixtures/conditionalBatch";
import {
  chooseCustomSelectOption,
  openCustomSelect,
} from "./testUtils/customSelect";

afterEach(cleanup);

describe("conditional batch property editor", () => {
  it.each([
    ["표준", "normal"],
    ["표준+넘침 방지", "break-word"],
    ["글자 단위", "break-all"],
    ["단어 단위", "keep-all"],
    ["단어 단위+넘침 방지", "keep-all-overflow"],
  ] as const)(
    "applies %s through the batch editor with the same value as direct formatting",
    (label, wordBreak) => {
      const initialValue = wordBreak === "normal" ? "break-all" : "normal";
      let selected = createAction("wordBreak", initialValue);
      const onDirectChange = vi.fn();
      render(
        <>
          <StatefulSetFieldsEditor
            initial={selected}
            onChange={(next) => {
              if (next.type === "setFields") selected = next;
            }}
          />
          <TextWrappingSelect
            ariaLabel="줄바꿈 방식"
            value={initialValue}
            onChange={onDirectChange}
          />
        </>,
      );
      chooseCustomSelectOption("줄바꿈 적용할 값", label);
      chooseCustomSelectOption("줄바꿈 방식", label);
      expect(onDirectChange).toHaveBeenLastCalledWith(wordBreak);
      expect(selected.changes).toEqual([
        { field: "wordBreak", operation: "set", value: wordBreak },
      ]);
      expect(summarizeAction(selected)).toBe(`줄바꿈 ${label}`);
      verifyAppliedWrapping(selected, wordBreak);
    },
  );

  it.each(["ko", "en", "ja"] as const)(
    "shows the same wrapping choices and order in both editors in %s",
    async (locale) => {
      await appI18n.changeLanguage(locale);
      render(
        <>
          <StatefulSetFieldsEditor
            initial={createAction("wordBreak", "keep-all-overflow")}
            onChange={() => {}}
          />
          <TextWrappingSelect
            ariaLabel="direct wrapping"
            value="keep-all-overflow"
            onChange={() => {}}
          />
        </>,
      );
      const choices = (name: string) =>
        within(openCustomSelect(name))
          .getAllByRole("option")
          .map((option) => [
            option.getAttribute("data-value"),
            option.textContent,
          ]);
      const batch = choices("줄바꿈 적용할 값");
      fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
      expect(choices("direct wrapping")).toEqual(batch);
      expect(batch).toHaveLength(5);
    },
  );

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
      name: "글자 투명도 적용할 값",
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
      "글자 투명도 65%",
    );
    expect(
      summarizeAction({
        ...createAction("bold", true),
        changes: [{ field: "bold", operation: "clear" }],
      }),
    ).toBe("굵게 지정 해제");
  });

  it.each([
    ["기울임", "italic", true],
    ["장평", "fontWidthScale", 1],
    ["줄바꿈", "wordBreak", "normal"],
    ["글꼴", "fontFamily", "default"],
    ["원문", "sourceText", ""],
    ["광선색", "textGlowColor", "#ffffff"],
  ] as const)(
    "creates a valid %s change with the matching default and dependencies",
    (label, field, value) => {
      let selected = createAction("bold", true);
      render(
        <StatefulSetFieldsEditor
          initial={selected}
          onChange={(next) => {
            if (next.type === "setFields") selected = next;
          }}
        />,
      );
      chooseCustomSelectOption("바꿀 속성", label);
      expect(selected.changes[0]).toEqual({ field, operation: "set", value });
      if (field === "textGlowColor") {
        expect(selected.changes[1]).toEqual({
          field: "textGlowEnabled",
          operation: "set",
          value: true,
        });
      } else expect(selected.changes).toHaveLength(1);
      const draft = ConditionalBatchSchemeDraftV2Schema.parse({
        ...createBlankBatchSchemeDraft(),
        actions: [selected],
      });
      const chapter = batchChapter();
      const preview = createConditionalBatchPreview(
        chapter,
        { kind: "chapter" },
        draft,
      );
      const applied = applyConditionalBatchPreview(
        chapter,
        draft,
        preview,
        new Set(),
      );
      expect(applied.appliedCount).toBe(2);
      const block = applied.chapter.pages[0].blocks[0];
      if (field === "textGlowColor")
        expect(block.textGlow).toMatchObject({ color: value, enabled: true });
      else expect(block[field]).toBe(value);
    },
  );

  it("keeps an explicit disabled effect when its color is added", () => {
    let selected: ConditionalBatchSetFieldsActionV2 = {
      ...createAction("bold", true),
      changes: [
        { field: "bold", operation: "set", value: true },
        { field: "textGlowEnabled", operation: "set", value: false },
      ],
    };
    render(
      <StatefulSetFieldsEditor
        initial={selected}
        onChange={(next) => {
          if (next.type === "setFields") selected = next;
        }}
      />,
    );
    fireEvent.click(screen.getAllByRole("combobox", { name: "바꿀 속성" })[0]);
    fireEvent.click(
      within(screen.getByRole("listbox", { name: "바꿀 속성" })).getByRole(
        "option",
        { name: "광선색" },
      ),
    );
    expect(selected.changes).toEqual([
      { field: "textGlowColor", operation: "set", value: "#ffffff" },
      { field: "textGlowEnabled", operation: "set", value: false },
    ]);
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
    <BatchFonts>
      <ConditionalBatchSetFieldsEditor
        action={action}
        onChange={(next) => {
          if (next.type === "setFields") setAction(next);
          onChange(next);
        }}
      />
    </BatchFonts>
  );
}

function createAction(
  field: "bold" | "italic" | "textOpacity" | "wordBreak",
  value: boolean | number | TextWordBreak,
): ConditionalBatchSetFieldsActionV2 {
  return {
    id: "set-fields",
    enabled: true,
    type: "setFields",
    changes: [{ field, operation: "set", value }],
  };
}

function verifyAppliedWrapping(
  action: ConditionalBatchSetFieldsActionV2,
  wordBreak: TextWordBreak,
): void {
  const chapter = batchChapter();
  chapter.pages[0].blocks[1].renderDirection = "vertical";
  const original = structuredClone(chapter);
  const rule = ConditionalBatchSchemeDraftV2Schema.parse(
    JSON.parse(
      JSON.stringify({ ...createBlankBatchSchemeDraft(), actions: [action] }),
    ),
  );
  const preview = createConditionalBatchPreview(
    chapter,
    { kind: "chapter" },
    rule,
  );
  expect(preview.results).toHaveLength(2);
  expect(chapter).toEqual(original);
  for (const result of preview.results) {
    expect(result.changedFields).toEqual(["wordBreak"]);
    expect(result.resolvedFieldValues?.wordBreak?.after).toBe(wordBreak);
  }
  const applied = applyConditionalBatchPreview(
    chapter,
    rule,
    preview,
    new Set(),
  );
  expect(applied.appliedCount).toBe(2);
  expect(applied.conflictCount).toBe(0);
  for (const block of applied.chapter.pages[0].blocks) {
    const saved = TranslationBlockSchema.parse(
      JSON.parse(JSON.stringify(block)),
    );
    expect(saved.wordBreak).toBe(wordBreak);
  }
  if (wordBreak !== "keep-all-overflow") return;
  const appliedBlock = applied.chapter.pages[0].blocks[0];
  const measured = measureStyledWrappedText(
    {
      font: "",
      measureText: (text: string) =>
        ({ width: Array.from(text).length * 10 }) as TextMetrics,
    },
    [{ text: "가나다 라마바사아", bold: false, italic: false }],
    40,
    12,
    10,
    "sans-serif",
    0,
    resolveBlockTextWordBreak(
      appliedBlock.wordBreak,
      appliedBlock.renderDirection,
    ),
  );
  expect(
    measured.lines.map((line) => line.runs.map((run) => run.text).join("")),
  ).toEqual(["가나다 ", "라마바사", "아"]);
  expect(measured.lines.every((line) => line.width <= 40)).toBe(true);
}
