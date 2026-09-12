/** @vitest-environment jsdom */
import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ConditionalBatchConditionsCard } from "../src/renderer/src/components/ConditionalBatchConditionsCard";
import { ConditionalBatchSetFieldsEditor } from "../src/renderer/src/components/ConditionalBatchSetFieldsEditor";
import { ConditionalBatchIdentityField } from "../src/renderer/src/components/ConditionalBatchIdentityField";
import {
  ConditionalBatchSpeakersContext,
  createConditionalBatchSpeakerCatalog,
} from "../src/renderer/src/components/conditionalBatchSpeakers";
import { createConditionForField } from "../src/renderer/src/components/conditionalBatchUi";
import {
  applyConditionalBatchPreview,
  createConditionalBatchPreview,
} from "../src/shared/conditionalBatchEngine";
import {
  type ConditionalBatchSchemeDraftV2,
  type ConditionalBatchSetFieldsActionV2,
} from "../src/shared/conditionalBatchRules";
import type { CharacterProfile } from "../src/shared/workContextTypes";
import {
  BatchFonts,
  batchChapter,
  sizeDraft,
} from "./fixtures/conditionalBatch";
import {
  chooseCustomSelectOption,
  openCustomSelect,
} from "./testUtils/customSelect";

afterEach(cleanup);

function character(id: string, name: string): CharacterProfile {
  return {
    id,
    displayName: name,
    targetName: name,
    sourceNames: ["アキラ"],
    aliases: ["꼬마 대장"],
    speechStyle: "neutral",
    enabled: true,
    createdAt: "2026-09-12T00:00:00.000Z",
    updatedAt: "2026-09-12T00:00:00.000Z",
  };
}

function chapterWithSpeakers() {
  const chapter = batchChapter();
  chapter.pages[0].blocks[0].speakerId = "character-1";
  chapter.pages[0].blocks[1].speakerId = "character-10";
  chapter.pages[0].blocks.push({
    ...chapter.pages[0].blocks[0],
    id: "b3",
    speakerId: undefined,
  });
  chapter.pages[0].blockOrder = ["b1", "b2", "b3"];
  return chapter;
}

function speakerDraft(): ConditionalBatchSchemeDraftV2 {
  return {
    ...sizeDraft(),
    match: {
      mode: "all",
      groups: [],
      conditions: [createConditionForField("speakerId")],
    },
    actions: [
      {
        id: "font",
        enabled: true,
        type: "setFields",
        changes: [
          { field: "fontFamily", operation: "set", value: "qa-speaker-font" },
        ],
      },
    ],
  };
}

function Conditions({
  initial = speakerDraft(),
  onChange,
}: {
  initial?: ConditionalBatchSchemeDraftV2;
  onChange: (draft: ConditionalBatchSchemeDraftV2) => void;
}) {
  const [draft, setDraft] = React.useState(initial);
  const catalog = createConditionalBatchSpeakerCatalog(
    chapterWithSpeakers(),
    [
      character("character-1", "아키라"),
      {
        ...character("character-10", "유키"),
        sourceNames: ["ユキ"],
        aliases: [],
      },
    ],
    true,
    null,
  );
  return (
    <BatchFonts>
      <ConditionalBatchSpeakersContext.Provider value={catalog}>
        <ConditionalBatchConditionsCard
          currentResult={null}
          draft={draft}
          expanded
          ruleId="test"
          onChangeDraft={(next) => {
            setDraft(next);
            onChange(next);
          }}
          onToggle={() => {}}
        />
      </ConditionalBatchSpeakersContext.Provider>
    </BatchFonts>
  );
}

it("searches a character alias and applies the chosen font only to that exact speaker ID", () => {
  let draft = speakerDraft();
  render(
    <Conditions
      onChange={(next) => {
        draft = next;
      }}
    />,
  );
  expect(
    screen.getByRole("combobox", { name: "비교 방법" }).textContent,
  ).toContain("같음");
  const list = openCustomSelect("화자 조건 값");
  fireEvent.change(
    screen.getByRole("searchbox", { name: "화자 이름·별칭 검색" }),
    {
      target: { value: "꼬마 대장" },
    },
  );
  expect(within(list).getAllByRole("option")).toHaveLength(1);
  fireEvent.click(within(list).getByRole("option", { name: /아키라/ }));
  expect(draft.match.conditions[0]).toMatchObject({
    operator: "equals",
    value: "character-1",
  });
  expect(
    screen.getByRole("combobox", { name: "화자 조건 값" }).textContent,
  ).toBe("아키라");
  expect(screen.getByText(/화자가 연결되지 않은 대사: 1개/)).toBeTruthy();
  const chapter = chapterWithSpeakers();
  const preview = createConditionalBatchPreview(
    chapter,
    { kind: "chapter" },
    draft,
  );
  expect(preview.results.map((result) => result.blockId)).toEqual(["b1"]);
  const result = applyConditionalBatchPreview(
    chapter,
    draft,
    preview,
    new Set(),
  );
  expect(result.appliedCount).toBe(1);
  expect(
    result.chapter.pages[0].blocks.map((block) => block.fontFamily),
  ).toEqual(["qa-speaker-font", undefined, undefined]);
});

it("disambiguates duplicate names and retains unnamed IDs already attached to dialogue", () => {
  const catalog = createConditionalBatchSpeakerCatalog(
    chapterWithSpeakers(),
    [
      character("character-1", "하루"),
      { ...character("other", "하루"), enabled: false },
      { ...character("source", ""), sourceNames: ["原名"], aliases: undefined },
      { ...character("id-only", ""), sourceNames: [] },
    ],
    true,
    null,
  );
  expect(catalog.options.map((option) => option.label)).toEqual([
    "하루 · character-1",
    "하루 · other",
    "原名",
    "id-only",
    "이름 미등록 · character-10",
  ]);
  expect(catalog.options[0].description).toBe("이 화의 대사 1개");
  expect(catalog.options[1].description).toContain("인물 정보 비활성");
  expect(catalog.options[4]).toMatchObject({
    value: "character-10",
    description: "이 화의 대사 1개",
  });
});

it("keeps a saved unknown ID through loading, failure, and empty catalogs without changing it", () => {
  const onChange = vi.fn();
  const catalog = {
    options: [],
    unassignedCount: 0,
    ready: false,
    error: null as string | null,
  };
  const field = (value: typeof catalog) => (
    <ConditionalBatchSpeakersContext.Provider value={value}>
      <ConditionalBatchIdentityField
        field="speakerId"
        label="화자"
        value="saved-id"
        onChange={onChange}
      />
    </ConditionalBatchSpeakersContext.Provider>
  );
  const view = render(field(catalog));
  expect(screen.getByText("화자 이름을 불러오는 중입니다.")).toBeTruthy();
  expect(screen.getByRole("combobox", { name: "화자" }).textContent).toContain(
    "saved-id",
  );
  view.rerender(field({ ...catalog, error: "offline" }));
  expect(screen.getByText(/화자 이름을 불러오지 못했습니다/)).toBeTruthy();
  openCustomSelect("화자");
  fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Escape" });
  expect(screen.queryByRole("listbox")).toBeNull();
  view.rerender(field({ ...catalog, ready: true }));
  expect(
    screen.getByText(/등록된 인물과 대사에 연결된 화자가 없습니다/),
  ).toBeTruthy();
  expect(onChange).not.toHaveBeenCalled();
});

it("uses the same name search when assigning a speaker and still supports clearing it", () => {
  let selected: ConditionalBatchSetFieldsActionV2 = {
    id: "speaker",
    type: "setFields",
    enabled: true,
    changes: [{ field: "speakerId", operation: "set", value: "character-1" }],
  };
  const catalog = createConditionalBatchSpeakerCatalog(
    chapterWithSpeakers(),
    [character("character-1", "아키라")],
    true,
    null,
  );
  function Assignment() {
    const [action, setAction] = React.useState(selected);
    return (
      <ConditionalBatchSpeakersContext.Provider value={catalog}>
        <ConditionalBatchSetFieldsEditor
          action={action}
          onChange={(next) => {
            if (next.type === "setFields") {
              setAction(next);
              selected = next;
            }
          }}
        />
      </ConditionalBatchSpeakersContext.Provider>
    );
  }
  render(<Assignment />);
  chooseCustomSelectOption("적용할 화자", /이름 미등록 · character-10/);
  expect(selected.changes[0]).toMatchObject({ value: "character-10" });
  fireEvent.click(screen.getByRole("radio", { name: "해제" }));
  expect(selected.changes).toEqual([
    { field: "speakerId", operation: "clear" },
  ]);
});

it("preserves legacy substring comparisons and offers name selection after switching to equality", () => {
  const initial = speakerDraft();
  initial.match.conditions[0] = {
    ...initial.match.conditions[0],
    operator: "contains",
    value: "character-",
  };
  const onChange = vi.fn();
  render(<Conditions initial={initial} onChange={onChange} />);
  expect(screen.getByDisplayValue("character-")).toBeTruthy();
  expect(screen.getByText(/저장된 규칙의 ID 문자열 비교/)).toBeTruthy();
  expect(onChange).not.toHaveBeenCalled();
  chooseCustomSelectOption("비교 방법", "같음");
  chooseCustomSelectOption("화자 조건 값", /아키라/);
  expect(onChange.mock.lastCall?.[0].match.conditions[0]).toMatchObject({
    operator: "equals",
    value: "character-1",
  });
});

it("selects speakers inside condition groups and shows the name in collapsed summaries", () => {
  const initial = speakerDraft();
  initial.match.groups = [
    {
      id: "group",
      enabled: true,
      logic: "all",
      conditions: initial.match.conditions,
    },
  ];
  initial.match.conditions = [
    { ...createConditionForField("fontSizePx"), id: "size" },
  ];
  render(<Conditions initial={initial} onChange={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: /화자이\(가\) 같음/ }));
  chooseCustomSelectOption("화자 조건 값", /유키/);
  fireEvent.click(screen.getByRole("button", { name: /글자 크기이\(가\)/ }));
  expect(
    screen.getByRole("button", { name: /화자이\(가\) 같음 “유키”/ }),
  ).toBeTruthy();
});
