/** @vitest-environment jsdom */
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_BLOCK_FONT_ID } from "../src/shared/blockFontCatalog";
import {
  normalizeFontWeightPatch,
  resolveFontWeight,
} from "../src/shared/blockFontWeight";
import {
  createBlockStylePreset,
  type BlockStylePreset,
} from "../src/shared/blockStylePresets";
import {
  applyConditionalBatchPreview,
  createConditionalBatchPreview,
  createConditionalBatchSequencePreview,
  applyConditionalBatchSequencePreview,
} from "../src/shared/conditionalBatchEngine";
import {
  ConditionalBatchSchemeDraftV2Schema,
  createBlankBatchSchemeDraft,
  type ConditionalBatchActionV2,
  type ConditionalBatchSchemeDraftV2,
} from "../src/shared/conditionalBatchRules";
import {
  applyTextStyleToRuns,
  parseRichText,
  serializeRichTextRuns,
} from "../src/shared/richTextMarkup";
import { TranslationBlockSchema } from "../src/shared/ipcSchemaPrimitives";
import { ConditionalBatchActionCard } from "../src/renderer/src/components/ConditionalBatchActionCard";
import { ConditionalBatchConditionsCard } from "../src/renderer/src/components/ConditionalBatchConditionsCard";
import {
  createConditionForField,
  formatConditionalBatchDisplayValue,
  resolveConditionalBatchNumberPresentation,
  summarizeCondition,
} from "../src/renderer/src/components/conditionalBatchUi";
import {
  DEFAULT_BLOCK_FONT_CATALOG,
  getBaseBlockFontOptions,
} from "../src/renderer/src/lib/fonts";
import { BatchFonts, batchChapter } from "./fixtures/conditionalBatch";
import { chooseCustomSelectOption } from "./testUtils/customSelect";

afterEach(cleanup);

function draftFor(
  action: ConditionalBatchActionV2,
): ConditionalBatchSchemeDraftV2 {
  return { ...createBlankBatchSchemeDraft(), actions: [action] };
}

function weightedChapter() {
  const chapter = batchChapter();
  chapter.pages[0].blocks = chapter.pages[0].blocks.map((block) => ({
    ...block,
    fontFamily: "old-font",
    bold: false,
    italic: false,
    fontWeight: 300,
  }));
  return chapter;
}

describe("batch formatting parity", () => {
  it("accepts a normal exact-weight preset and applies weight-only changes through preview, persistence and sequences", () => {
    const chapter = weightedChapter();
    const original = structuredClone(chapter);
    const preset = createBlockStylePreset({
      name: "정확한 굵기",
      groupIds: ["emphasis"],
      block: { ...chapter.pages[0].blocks[0], fontWeight: 500 },
    });
    const draft = ConditionalBatchSchemeDraftV2Schema.parse(
      draftFor({
        id: "preset",
        enabled: true,
        type: "applyStylePreset",
        presetName: preset.name,
        groupIds: preset.groupIds,
        format: preset.format,
      }),
    );
    const preview = createConditionalBatchPreview(
      chapter,
      { kind: "chapter" },
      draft,
    );
    expect(preview.results).toHaveLength(2);
    expect(preview.results[0].changedFields).toEqual(["bold"]);
    const applied = applyConditionalBatchPreview(
      chapter,
      draft,
      preview,
      new Set(),
    );
    expect(applied.appliedCount).toBe(2);
    expect(
      TranslationBlockSchema.parse(
        JSON.parse(JSON.stringify(applied.chapter.pages[0].blocks[0])),
      ).fontWeight,
    ).toBe(500);
    expect(chapter).toEqual(original);
    const sequence = {
      id: "seq",
      name: "굵기",
      description: "",
      steps: [{ id: "s", schemeId: "rule", enabled: true }],
    };
    const snapshot = {
      schemaVersion: 1 as const,
      schemes: [{ ...draft, id: "rule" }],
      sequences: [sequence],
    };
    const seqPreview = createConditionalBatchSequencePreview(
      chapter,
      { kind: "chapter" },
      sequence,
      snapshot,
    );
    expect(
      applyConditionalBatchSequencePreview(
        chapter,
        sequence,
        snapshot,
        seqPreview,
        new Set(),
      ).appliedCount,
    ).toBe(2);
    chapter.pages[0].blocks[0].fontWeight = 200;
    expect(
      applyConditionalBatchPreview(chapter, draft, preview, new Set())
        .conflictCount,
    ).toBe(1);
    expect(
      applyConditionalBatchSequencePreview(
        chapter,
        sequence,
        snapshot,
        seqPreview,
        new Set(),
      ).conflictCount,
    ).toBe(1);
  });

  it.each([
    { field: "fontFamily", operation: "set", value: "new-font" },
    { field: "fontFamily", operation: "set", value: "old-font" },
    { field: "fontFamily", operation: "clear" },
    { field: "bold", operation: "set", value: false },
    { field: "bold", operation: "set", value: true },
    { field: "bold", operation: "clear" },
  ] as const)(
    "matches direct manual font normalization for $field / $operation / $value",
    (change) => {
      const chapter = weightedChapter();
      const source = chapter.pages[0].blocks[0];
      const draft = ConditionalBatchSchemeDraftV2Schema.parse(
        draftFor({
          id: "set",
          enabled: true,
          type: "setFields",
          changes: [change],
        }),
      );
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
      const manual = {
        ...source,
        ...normalizeFontWeightPatch({
          [change.field]: "value" in change ? change.value : undefined,
        }),
      };
      expect(applied.appliedCount).toBe(2);
      expect(applied.chapter.pages[0].blocks[0].fontWeight).toBeUndefined();
      expect(resolveFontWeight(applied.chapter.pages[0].blocks[0])).toBe(
        resolveFontWeight(manual),
      );
    },
  );

  it.each(["underline", "strikethrough", "emphasisMark"] as const)(
    "matches off and on %s styles within mixed text",
    (field) => {
      const chapter = batchChapter();
      chapter.pages[0].blocks[0].translatedText = serializeRichTextRuns(
        applyTextStyleToRuns(parseRichText("abc").runs, 1, 2, {
          [field]: true,
        }),
      );
      const base = {
        id: "inline",
        enabled: true,
        type: "styleText" as const,
        target: "translatedText" as const,
        scope: "allText" as const,
        allOccurrences: true,
        styleMode: "overwrite" as const,
        patch: { color: "#ff0000" },
      };
      for (const value of [false, true]) {
        const rule = ConditionalBatchSchemeDraftV2Schema.parse(
          draftFor({
            ...base,
            matchStyle: {
              logic: "all",
              conditions: [{ id: "filter", field, operator: "equals", value }],
            },
          }),
        );
        const preview = createConditionalBatchPreview(
          chapter,
          { kind: "selection", pageId: "page", blockIds: ["b1"] },
          rule,
        );
        const applied = applyConditionalBatchPreview(
          chapter,
          rule,
          preview,
          new Set(),
        );
        const runs = parseRichText(
          applied.chapter.pages[0].blocks[0].translatedText,
        ).runs;
        expect(
          runs
            .filter((run) => run.color === "#ff0000")
            .map((run) => run.text)
            .join(""),
        ).toBe(value ? "b" : "ac");
      }
    },
  );

  it.each(["equals", "notEquals"] as const)(
    "matches default block font with %s, including older empty-value rules",
    (operator) => {
      const chapter = batchChapter();
      chapter.pages[0].blocks.push({
        ...chapter.pages[0].blocks[0],
        id: "custom",
        fontFamily: "custom",
      });
      chapter.pages[0].blockOrder?.push("custom");
      chapter.pages[0].blocks[1].fontFamily = "";
      for (const value of [DEFAULT_BLOCK_FONT_ID, ""]) {
        const draft = {
          ...createBlankBatchSchemeDraft(),
          actions: [],
          match: {
            mode: "all" as const,
            groups: [],
            conditions: [
              { ...createConditionForField("fontFamily"), operator, value },
            ],
          },
        };
        const preview = createConditionalBatchPreview(
          chapter,
          { kind: "chapter" },
          draft,
        );
        expect(preview.results.map((result) => result.blockId)).toEqual(
          operator === "equals" ? ["b1", "b2"] : ["custom"],
        );
      }
    },
  );
});

function EditingHarness({
  initial,
  onChange,
  presets = [],
  conditions = false,
}: {
  initial: ConditionalBatchSchemeDraftV2;
  onChange: (draft: ConditionalBatchSchemeDraftV2) => void;
  presets?: readonly BlockStylePreset[];
  conditions?: boolean;
}) {
  const [draft, setDraft] = React.useState(initial);
  const change = (next: ConditionalBatchSchemeDraftV2) => {
    setDraft(next);
    onChange(next);
  };
  return (
    <BatchFonts>
      {conditions ? (
        <ConditionalBatchConditionsCard
          ruleId="test"
          currentResult={null}
          draft={draft}
          expanded
          onChangeDraft={change}
          onToggle={() => {}}
        />
      ) : (
        <ConditionalBatchActionCard
          blockStylePresets={presets}
          currentResult={null}
          draft={draft}
          expanded
          onChangeDraft={change}
          onToggle={() => {}}
        />
      )}
    </BatchFonts>
  );
}

describe("batch controls match their stored and applied values", () => {
  it("keeps an action disabled and preserves its memo when the preset changes", () => {
    const chapter = batchChapter();
    const presets = ["one", "two"].map((id, index) =>
      createBlockStylePreset({
        id,
        name: id,
        groupIds: ["size"],
        block: { ...chapter.pages[0].blocks[0], fontSizePx: 30 + index },
      }),
    );
    let draft = draftFor({
      id: "preset",
      type: "applyStylePreset",
      enabled: false,
      note: "남길 메모",
      presetId: "one",
      presetName: "one",
      groupIds: presets[0].groupIds,
      format: presets[0].format,
    });
    render(
      <EditingHarness
        initial={draft}
        presets={presets}
        onChange={(next) => {
          draft = next;
        }}
      />,
    );
    chooseCustomSelectOption("스타일 프리셋", "two");
    expect(draft.actions[0]).toMatchObject({
      id: "preset",
      enabled: false,
      note: "남길 메모",
      presetId: "two",
    });
    expect(
      createConditionalBatchPreview(chapter, { kind: "chapter" }, draft)
        .inspectionOnly,
    ).toBe(true);
    expect(chapter.pages[0].blocks[0].fontSizePx).toBe(20);
  });

  it.each([false, true])(
    "selects the default font without losing its ID (inline=%s)",
    (inline) => {
      let draft = inline
        ? draftFor({
            id: "inline",
            enabled: true,
            type: "styleText",
            target: "translatedText",
            scope: "allText",
            allOccurrences: true,
            styleMode: "overwrite",
            patch: { color: "#ff0000" },
            matchStyle: {
              logic: "all",
              conditions: [
                {
                  id: "font",
                  field: "fontFamily",
                  operator: "equals",
                  value: "custom",
                },
              ],
            },
          })
        : {
            ...createBlankBatchSchemeDraft(),
            actions: [],
            match: {
              mode: "all" as const,
              groups: [],
              conditions: [
                { ...createConditionForField("fontFamily"), value: "custom" },
              ],
            },
          };
      render(
        <EditingHarness
          initial={draft}
          conditions={!inline}
          onChange={(next) => {
            draft = next;
          }}
        />,
      );
      const label = getBaseBlockFontOptions(DEFAULT_BLOCK_FONT_CATALOG).find(
        (font) => font.id === DEFAULT_BLOCK_FONT_ID,
      )?.label;
      if (!label) throw Error("Default font missing");
      chooseCustomSelectOption(
        inline ? "비교할 부분 서식 글꼴" : "글꼴 조건 값",
        new RegExp(label),
      );
      expect(ConditionalBatchSchemeDraftV2Schema.safeParse(draft).success).toBe(
        true,
      );
      const action = draft.actions[0];
      expect(
        inline && action?.type === "styleText"
          ? action.matchStyle?.conditions[0].value
          : draft.match.conditions[0].value,
      ).toBe(DEFAULT_BLOCK_FONT_ID);
    },
  );

  it("edits percentage ranges and evaluates the stored fractional thresholds", () => {
    let draft = {
      ...createBlankBatchSchemeDraft(),
      actions: [],
      match: {
        mode: "all" as const,
        groups: [],
        conditions: [
          {
            ...createConditionForField("textOpacity"),
            operator: "between" as const,
            value: 0.5,
            value2: 0.9,
          },
        ],
      },
    };
    render(
      <EditingHarness
        initial={draft}
        conditions
        onChange={(next) => {
          draft = next as typeof draft;
        }}
      />,
    );
    const start = screen.getByRole("spinbutton", {
      name: "조건 비교 값",
    }) as HTMLInputElement;
    const end = screen.getByRole("spinbutton", {
      name: "조건 범위 끝 값",
    }) as HTMLInputElement;
    expect([start.value, end.value]).toEqual(["50", "90"]);
    fireEvent.change(start, { target: { value: "65.5" } });
    fireEvent.blur(start);
    fireEvent.change(end, { target: { value: "80" } });
    fireEvent.blur(end);
    expect(draft.match.conditions[0]).toMatchObject({
      value: 0.655,
      value2: 0.8,
    });
    expect(summarizeCondition(draft.match.conditions[0])).toContain(
      "65.5%–80%",
    );
    const chapter = batchChapter();
    chapter.pages[0].blocks[0].textOpacity = 0.7;
    chapter.pages[0].blocks[1].textOpacity = 0.9;
    expect(
      createConditionalBatchPreview(
        chapter,
        { kind: "chapter" },
        draft,
      ).results.map((result) => result.blockId),
    ).toEqual(["b1"]);
  });

  it.each([
    ["opacity", "글자 투명도", 0.65, 65, 0.7],
    ["widthScale", "장평", 1.2, 120, 0.7],
    ["glowOpacity", "광선 불투명도", 0.35, 35, 0.7],
  ] as const)(
    "edits %s in percentages for both inline filters and mutations",
    (field, label, stored, shown, expected) => {
      let draft = draftFor({
        id: "inline",
        type: "styleText",
        enabled: true,
        target: "translatedText",
        scope: "allText",
        allOccurrences: true,
        styleMode: "overwrite",
        patch: { [field]: stored },
        matchStyle: {
          logic: "all",
          conditions: [
            { id: "filter", field, operator: "equals", value: stored },
          ],
        },
      });
      render(
        <EditingHarness
          initial={draft}
          onChange={(next) => {
            draft = next;
          }}
        />,
      );
      if (field === "glowOpacity")
        fireEvent.click(screen.getByText("색상 · 외곽선 · 광선"));
      const filter = screen.getByRole("spinbutton", {
        name: "부분 서식 비교 값",
      }) as HTMLInputElement;
      const value = screen.getByRole("spinbutton", {
        name: `${label} 부분 서식 값`,
      }) as HTMLInputElement;
      expect([filter.value, value.value]).toEqual([
        String(shown),
        String(shown),
      ]);
      fireEvent.change(filter, { target: { value: "70" } });
      fireEvent.blur(filter);
      fireEvent.change(value, { target: { value: "70" } });
      fireEvent.blur(value);
      const action = draft.actions[0];
      if (action.type !== "styleText") throw Error("Wrong action");
      expect(action.matchStyle?.conditions[0].value).toBe(expected);
      expect(action.patch[field]).toBe(expected);
    },
  );

  it.each([
    "textOpacity",
    "textEffectOpacity",
    "textGlowOpacity",
    "fontWidthScale",
    "confidence",
    "fontRoleConfidence",
  ] as const)(
    "round-trips %s display without changing persisted units",
    (field) => {
      for (const value of [0, 0.125, 0.655, 1]) {
        const presentation = resolveConditionalBatchNumberPresentation(
          field,
          value,
        );
        expect(presentation.toStoredValue(presentation.value)).toBe(value);
        expect(formatConditionalBatchDisplayValue(field, value)).toBe(
          `${value * 100}%`,
        );
      }
    },
  );

  it("uses the same wrapping label in condition summaries and result values", () => {
    expect(
      summarizeCondition({
        ...createConditionForField("wordBreak"),
        value: "keep-all-overflow",
      }),
    ).toContain("단어 단위+넘침 방지");
    expect(
      formatConditionalBatchDisplayValue("wordBreak", [
        "normal",
        "keep-all-overflow",
      ]),
    ).toBe("표준, 단어 단위+넘침 방지");
    expect(formatConditionalBatchDisplayValue("fontSizePx", 30)).toBe("30px");
  });
});
