// @vitest-environment jsdom

import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chooseCustomSelectOption,
  openCustomSelect,
} from "./testUtils/customSelect";
import { CharactersTab } from "../src/renderer/src/components/styleGuide/CharactersTab";
import { GlossaryTab } from "../src/renderer/src/components/styleGuide/GlossaryTab";
import { StyleGuideTabContent } from "../src/renderer/src/components/styleGuide/StyleGuideChrome";
import {
  createContextEntryActions,
  createContextEntryDraftActions,
} from "../src/renderer/src/components/styleGuide/contextEntryActions";
import type { WorkStyleGuide } from "../src/shared/workContextTypes";
import type { WorkContextUsageMetric } from "../src/shared/workContextUsageTypes";

const TS = "2026-01-01T00:00:00.000Z";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("style guide usage management", () => {
  it("sorts, filters, edits, and bulk-deletes glossary entries by stable ID", async () => {
    const guide = makeGuide();
    const onGuideChange = vi.fn();
    render(
      <GlossaryTab
        guide={guide}
        onGuideChange={onGuideChange}
        usage={makeUsage()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "행 추가" }));
    expect(onGuideChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        glossary: expect.arrayContaining([
          expect.objectContaining({ source: "", target: "" }),
        ]),
      }),
    );

    expect(glossarySourceOrder()).toEqual(["Beta", "Alpha"]);

    chooseCustomSelectOption("정렬", "이름");
    expect(glossarySourceOrder()).toEqual(["Alpha", "Beta"]);

    chooseCustomSelectOption("필터", "AI 생성");
    expect(glossarySourceOrder()).toEqual(["Beta"]);

    fireEvent.change(screen.getByPlaceholderText("원문"), {
      target: { value: "Beta edited" },
    });
    expect(onGuideChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        glossary: [
          expect.objectContaining({ id: "alpha", source: "Alpha" }),
          expect.objectContaining({
            id: "beta",
            source: "Beta edited",
            origin: "manual",
          }),
        ],
      }),
    );

    chooseCustomSelectOption("필터", "전체");
    fireEvent.click(screen.getByLabelText("Alpha 선택"));
    fireEvent.click(screen.getByLabelText("Beta 선택"));
    fireEvent.click(screen.getByRole("button", { name: "2개 삭제" }));
    const dialog = screen.getByRole("dialog", { name: "2개 삭제" });
    fireEvent.click(within(dialog).getByRole("button", { name: "삭제" }));
    await waitFor(() =>
      expect(onGuideChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ glossary: [] }),
      ),
    );
    expect(screen.getByLabelText("Alpha 선택")).toHaveProperty(
      "checked",
      false,
    );
    expect(screen.getByLabelText("Beta 선택")).toHaveProperty("checked", false);
    expect(screen.getByRole("button", { name: "0개 삭제" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("supports usage sorting and ID-based character edits", () => {
    const guide = makeGuide();
    const onGuideChange = vi.fn();
    render(
      <CharactersTab
        guide={guide}
        onGuideChange={onGuideChange}
        usage={makeCharacterUsage()}
      />,
    );

    const names = screen
      .getAllByPlaceholderText("표시 이름")
      .map((input) => (input as HTMLInputElement).value);
    expect(names).toEqual(["유나", "민호"]);

    fireEvent.change(screen.getAllByPlaceholderText("표시 이름")[0], {
      target: { value: "유나 수정" },
    });
    expect(onGuideChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        characters: [
          expect.objectContaining({ id: "minho", displayName: "민호" }),
          expect.objectContaining({
            id: "yuna",
            displayName: "유나 수정",
            origin: "manual",
          }),
        ],
      }),
    );
  });

  it("pins a new glossary row above search results, focuses it, and completes it into sorting", () => {
    render(<StatefulGlossaryTab />);
    fireEvent.change(screen.getByLabelText("이름·번역·별칭 검색"), {
      target: { value: "일치하지 않음" },
    });

    fireEvent.click(screen.getByRole("button", { name: "행 추가" }));
    const draftSource = screen.getByPlaceholderText("원문");
    expect(draftSource.closest(".style-guide-row")?.classList).toContain(
      "is-draft",
    );
    expect(document.activeElement).toBe(draftSource);
    expect(screen.queryByText("조건에 맞는 항목이 없습니다.")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "행 추가" }));
    expect(screen.getAllByPlaceholderText("원문")).toHaveLength(1);
    expect(document.activeElement).toBe(draftSource);

    fireEvent.change(draftSource, { target: { value: "Zeta" } });
    fireEvent.change(screen.getByPlaceholderText("번역"), {
      target: { value: "제타" },
    });
    fireEvent.click(screen.getByRole("button", { name: "새 행 입력 완료" }));
    expect(screen.getByText("조건에 맞는 항목이 없습니다.")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("이름·번역·별칭 검색"), {
      target: { value: "" },
    });
    chooseCustomSelectOption("정렬", "이름");
    expect(glossarySourceOrder()).toEqual(["Alpha", "Beta", "Zeta"]);
    expect(
      screen
        .getByDisplayValue("Zeta")
        .closest(".style-guide-row")
        ?.classList.contains("is-draft"),
    ).toBe(false);
  });

  it("keeps focus in the draft field being edited as its value changes", () => {
    render(<StatefulGlossaryTab />);
    fireEvent.click(screen.getByRole("button", { name: "행 추가" }));

    const draftRow = document.querySelector(".style-guide-row.is-draft");
    expect(draftRow).not.toBeNull();
    const draftTranslation = within(
      draftRow as HTMLElement,
    ).getByPlaceholderText("번역");
    draftTranslation.focus();
    fireEvent.change(draftTranslation, { target: { value: "번" } });
    expect(document.activeElement).toBe(draftTranslation);

    fireEvent.change(draftTranslation, { target: { value: "번역 단어" } });
    expect(document.activeElement).toBe(draftTranslation);
  });

  it("accepts keyboard input after cancelling and reopening a glossary draft", () => {
    render(<StatefulGlossaryTab />);
    const addRow = screen.getByRole("button", { name: "행 추가" });

    fireEvent.click(addRow);
    fireEvent.click(screen.getByRole("button", { name: "새 행 입력 취소" }));
    fireEvent.click(addRow);

    const draftRow = document.querySelector(".style-guide-row.is-draft");
    expect(draftRow).not.toBeNull();
    const draftSource = within(draftRow as HTMLElement).getByPlaceholderText(
      "원문",
    );
    expect(document.activeElement).toBe(draftSource);

    fireEvent.compositionStart(draftSource);
    fireEvent.change(draftSource, { target: { value: "재" } });
    fireEvent.change(draftSource, { target: { value: "재등" } });
    fireEvent.change(draftSource, { target: { value: "재등록" } });
    fireEvent.compositionEnd(draftSource, { data: "재등록" });

    expect(draftSource).toHaveProperty("value", "재등록");
    expect(document.activeElement).toBe(draftSource);
  });

  it("does not lose a replacement draft when cancel and add are batched", () => {
    render(<StatefulGlossaryTab />);
    const addRow = screen.getByRole("button", { name: "행 추가" });
    fireEvent.click(addRow);
    const cancel = screen.getByRole("button", { name: "새 행 입력 취소" });

    act(() => {
      cancel.click();
      addRow.click();
    });

    const draftRows = document.querySelectorAll(".style-guide-row.is-draft");
    expect(draftRows).toHaveLength(1);
    const draftSource = within(
      draftRows[0] as HTMLElement,
    ).getByPlaceholderText("원문");
    fireEvent.change(draftSource, { target: { value: "교체 초안" } });
    expect(draftSource).toHaveProperty("value", "교체 초안");
  });

  it("completes a draft from the latest value during a batched input and click", () => {
    render(<StatefulGlossaryTab />);
    fireEvent.click(screen.getByRole("button", { name: "행 추가" }));
    const draftRow = document.querySelector(".style-guide-row.is-draft");
    expect(draftRow).not.toBeNull();
    const source = within(draftRow as HTMLElement).getByPlaceholderText("원문");
    const complete = screen.getByRole("button", { name: "새 행 입력 완료" });

    act(() => {
      fireEvent.change(source, { target: { value: "즉시 완료" } });
      complete.click();
    });

    expect(document.querySelector(".style-guide-row.is-draft")).toBeNull();
    expect(screen.getByDisplayValue("즉시 완료")).toBeTruthy();
  });

  it("keeps an incomplete glossary draft open and focused", () => {
    render(<StatefulGlossaryTab />);
    fireEvent.click(screen.getByRole("button", { name: "행 추가" }));

    const draftRow = document.querySelector(".style-guide-row.is-draft");
    expect(draftRow).not.toBeNull();
    const source = within(draftRow as HTMLElement).getByPlaceholderText("원문");
    fireEvent.click(screen.getByRole("button", { name: "새 행 입력 완료" }));

    expect(source.closest(".style-guide-row")?.classList).toContain("is-draft");
    expect(document.activeElement).toBe(source);
  });

  it("accepts keyboard input after deleting a saved glossary row and adding a draft", () => {
    render(<StatefulGlossaryTab />);

    fireEvent.click(screen.getByRole("button", { name: "Alpha 삭제" }));
    fireEvent.click(screen.getByRole("button", { name: "행 추가" }));

    const draftRow = document.querySelector(".style-guide-row.is-draft");
    expect(draftRow).not.toBeNull();
    const draftTranslation = within(
      draftRow as HTMLElement,
    ).getByPlaceholderText("번역");
    draftTranslation.focus();
    fireEvent.change(draftTranslation, { target: { value: "다시 추가" } });

    expect(draftTranslation).toHaveProperty("value", "다시 추가");
    expect(document.activeElement).toBe(draftTranslation);
  });

  it("keeps glossary separators editable until the aliases field is left", () => {
    render(<StatefulGlossaryTab />);
    const alphaRow = screen
      .getAllByPlaceholderText("원문")
      .find((input) => (input as HTMLInputElement).value === "Alpha")
      ?.closest(".style-guide-row");
    expect(alphaRow).not.toBeNull();
    const aliases = within(alphaRow as HTMLElement).getByPlaceholderText(
      "별칭",
    );

    fireEvent.focus(aliases);
    fireEvent.change(aliases, { target: { value: "첫 별칭, " } });
    expect(aliases).toHaveProperty("value", "첫 별칭, ");
    fireEvent.change(aliases, {
      target: { value: "첫 별칭, 두 번째 별칭" },
    });
    expect(aliases).toHaveProperty("value", "첫 별칭, 두 번째 별칭");

    fireEvent.blur(aliases);
    expect(aliases).toHaveProperty("value", "첫 별칭, 두 번째 별칭");
  });

  it("keeps character name separators editable and supports cancel then re-add", () => {
    render(<StatefulCharactersTab />);
    fireEvent.click(screen.getByRole("button", { name: "행 추가" }));
    fireEvent.click(screen.getByRole("button", { name: "새 행 입력 취소" }));
    fireEvent.click(screen.getByRole("button", { name: "행 추가" }));

    const draftRow = document.querySelector(".style-guide-row.is-draft");
    expect(draftRow).not.toBeNull();
    const sourceNames = within(draftRow as HTMLElement).getByPlaceholderText(
      "원문 이름",
    );
    expect(document.activeElement).toBe(sourceNames);

    fireEvent.change(sourceNames, { target: { value: "名前, " } });
    expect(sourceNames).toHaveProperty("value", "名前, ");
    fireEvent.change(sourceNames, { target: { value: "名前, 別名" } });
    expect(sourceNames).toHaveProperty("value", "名前, 別名");
    expect(document.activeElement).toBe(sourceNames);
  });

  it("composes consecutive list actions from their latest in-memory result", () => {
    const updates: Array<Array<{ id: string; updatedAt: string }>> = [];
    const actions = createContextEntryActions({
      entries: [
        { id: "keep", updatedAt: TS },
        { id: "remove", updatedAt: TS },
      ],
      selectedIds: new Set<string>(),
      clearSelection: vi.fn(),
      confirmDelete: () => true,
      createEntry: () => ({ id: "new", updatedAt: TS }),
      onEntriesChange: (entries) => updates.push(entries),
    });

    actions.remove("remove");
    actions.add();

    expect(updates.at(-1)?.map((entry) => entry.id)).toEqual(["keep", "new"]);
  });

  it("handles draft commands both with and without a current entry", () => {
    type DraftEntry = { id: string; updatedAt: string };
    const addedEntry: DraftEntry = { id: "draft", updatedAt: TS };
    let currentEntry: DraftEntry | undefined;
    const actions = {
      add: vi.fn(() => addedEntry),
      get: vi.fn(() => addedEntry),
      remove: vi.fn(),
    };
    const draft = {
      begin: vi.fn((entry: DraftEntry) => {
        currentEntry = entry;
      }),
      cancel: vi.fn(() => {
        currentEntry = undefined;
      }),
      complete: vi.fn(),
      focus: vi.fn(),
      getCurrentEntry: () => currentEntry,
    };
    const commands = createContextEntryDraftActions({ actions, draft });

    commands.add();
    expect(draft.begin).toHaveBeenCalledWith(addedEntry);
    commands.add();
    expect(draft.focus).toHaveBeenCalledOnce();

    commands.complete();
    expect(actions.get).toHaveBeenCalledWith("draft");
    expect(draft.complete).toHaveBeenLastCalledWith(addedEntry);
    currentEntry = undefined;
    commands.complete();
    expect(draft.complete).toHaveBeenLastCalledWith(undefined);

    currentEntry = addedEntry;
    commands.cancel();
    commands.cancel();
    expect(actions.remove).toHaveBeenCalledOnce();
    expect(actions.remove).toHaveBeenCalledWith("draft");
  });

  it("cancels empty glossary and character drafts without leaving rows behind", () => {
    const { unmount } = render(<StatefulGlossaryTab />);
    fireEvent.click(screen.getByRole("button", { name: "행 추가" }));
    fireEvent.click(screen.getByRole("button", { name: "새 행 입력 취소" }));
    expect(glossarySourceOrder()).toEqual(["Beta", "Alpha"]);
    unmount();

    render(<StatefulCharactersTab />);
    fireEvent.click(screen.getByRole("button", { name: "행 추가" }));
    const sourceNameInputs = screen.getAllByPlaceholderText("원문 이름");
    expect((sourceNameInputs[0] as HTMLInputElement).value).toBe("");
    expect(document.activeElement).toBe(sourceNameInputs[0]);
    fireEvent.click(screen.getByRole("button", { name: "새 행 입력 취소" }));
    expect(screen.getAllByPlaceholderText("원문 이름")).toHaveLength(2);
  });

  it("keeps an unfinished glossary row pinned after visiting another tab", () => {
    const { rerender } = render(<StatefulTabContent tab="glossary" />);
    fireEvent.click(screen.getByRole("button", { name: "행 추가" }));
    const draftInput = screen
      .getAllByPlaceholderText("원문")
      .find((input) => (input as HTMLInputElement).required);
    expect(draftInput).toBeTruthy();
    fireEvent.change(draftInput as HTMLInputElement, {
      target: { value: "작성 중" },
    });

    rerender(<StatefulTabContent tab="characters" />);
    rerender(<StatefulTabContent tab="glossary" />);

    const restored = screen.getByDisplayValue("작성 중");
    expect(restored.closest(".style-guide-row")?.classList).toContain(
      "is-draft",
    );
    expect(document.activeElement).toBe(restored);
  });

  it("shows only the mention count and keeps detailed usage in a tooltip", () => {
    const onGuideChange = vi.fn();
    render(
      <GlossaryTab
        guide={makeGuide()}
        onGuideChange={onGuideChange}
        usage={makeUsage()}
      />,
    );

    const betaSource = screen.getAllByPlaceholderText("원문")[0];
    const betaRow = betaSource.closest(".style-guide-row");
    expect(betaRow).not.toBeNull();
    const row = within(betaRow as HTMLElement);
    expect(screen.getByText("횟수")).toBeTruthy();
    expect(
      row.getByText("7").classList.contains("style-guide-usage-number"),
    ).toBe(true);
    expect(row.getByRole("tooltip").textContent).toBe(
      "5쪽 · 7회 · 최근 1화 5쪽",
    );
    expect(row.getAllByRole("checkbox")).toHaveLength(1);

    const enabled = row.getByRole("switch", { name: "Beta 활성화" });
    expect(enabled.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(enabled);
    expect(onGuideChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        glossary: expect.arrayContaining([
          expect.objectContaining({
            id: "beta",
            enabled: false,
            origin: "manual",
          }),
        ]),
      }),
    );

    fireEvent.click(row.getByRole("button", { name: "Beta 삭제" }));
    expect(onGuideChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        glossary: [expect.objectContaining({ id: "alpha" })],
      }),
    );
  });

  it("keeps usage as the default sort while statistics transition from loading to ready", () => {
    const guide = makeGuide();
    const props = {
      busy: false,
      guide,
      memory: null,
      onGuideChange: vi.fn(),
      onMemoryChange: vi.fn(),
      tab: "glossary" as const,
    };
    const { rerender } = render(
      <StyleGuideTabContent {...props} usage={null} usageStatus="loading" />,
    );

    rerender(
      <StyleGuideTabContent
        {...props}
        usage={{ workId: guide.workId, glossary: makeUsage(), characters: [] }}
        usageStatus="ready"
      />,
    );

    expect(glossarySourceOrder()).toEqual(["Beta", "Alpha"]);
    expect(screen.getByLabelText("정렬")).toHaveProperty("value", "usage");
  });

  it("supports search, remaining sorts and usage filters", () => {
    const guide = makeGuide();
    guide.glossary.push({
      ...guide.glossary[0],
      id: "gamma",
      source: "Gamma",
      target: "감마",
      enabled: false,
      origin: "manual",
    });
    render(
      <GlossaryTab guide={guide} onGuideChange={vi.fn()} usage={makeUsage()} />,
    );

    chooseCustomSelectOption("정렬", "저장 순서");
    expect(glossarySourceOrder()).toEqual(["Alpha", "Beta", "Gamma"]);

    fireEvent.change(screen.getByLabelText("이름·번역·별칭 검색"), {
      target: { value: "감마" },
    });
    expect(glossarySourceOrder()).toEqual(["Gamma"]);
    fireEvent.change(screen.getByLabelText("이름·번역·별칭 검색"), {
      target: { value: "" },
    });

    chooseCustomSelectOption("필터", "등장 횟수 0");
    expect(glossarySourceOrder()).toEqual(["Gamma"]);
    chooseCustomSelectOption("필터", "0~1쪽 등장");
    expect(glossarySourceOrder()).toEqual(["Alpha", "Gamma"]);
    chooseCustomSelectOption("필터", "비활성");
    expect(glossarySourceOrder()).toEqual(["Gamma"]);
  });

  it("sorts every criterion in an explicit ascending or descending direction", () => {
    render(
      <GlossaryTab
        guide={makeGuide()}
        onGuideChange={vi.fn()}
        usage={makeUsage()}
      />,
    );

    expect(screen.getByLabelText("정렬 방향")).toHaveProperty("value", "desc");
    expect(glossarySourceOrder()).toEqual(["Beta", "Alpha"]);

    chooseCustomSelectOption("정렬 방향", "오름차순");
    expect(glossarySourceOrder()).toEqual(["Alpha", "Beta"]);
    chooseCustomSelectOption("정렬 방향", "내림차순");
    expect(glossarySourceOrder()).toEqual(["Beta", "Alpha"]);

    chooseCustomSelectOption("정렬", "이름");
    expect(screen.getByLabelText("정렬 방향")).toHaveProperty("value", "asc");
    expect(glossarySourceOrder()).toEqual(["Alpha", "Beta"]);
    chooseCustomSelectOption("정렬 방향", "내림차순");
    expect(glossarySourceOrder()).toEqual(["Beta", "Alpha"]);

    chooseCustomSelectOption("정렬", "최근 등장");
    expect(screen.getByLabelText("정렬 방향")).toHaveProperty("value", "desc");
    expect(glossarySourceOrder()).toEqual(["Beta", "Alpha"]);
    chooseCustomSelectOption("정렬 방향", "오름차순");
    expect(glossarySourceOrder()).toEqual(["Alpha", "Beta"]);

    chooseCustomSelectOption("정렬", "저장 순서");
    expect(screen.getByLabelText("정렬 방향")).toHaveProperty("value", "asc");
    expect(glossarySourceOrder()).toEqual(["Alpha", "Beta"]);
    chooseCustomSelectOption("정렬 방향", "내림차순");
    expect(glossarySourceOrder()).toEqual(["Beta", "Alpha"]);
  });

  it("does not expose usage-based cleanup when statistics failed", () => {
    render(
      <GlossaryTab
        guide={makeGuide()}
        onGuideChange={vi.fn()}
        usage={[]}
        usageAvailable={false}
      />,
    );

    expect(
      screen.getAllByText("사용 통계를 불러오지 못했습니다.").length,
    ).toBeGreaterThan(0);
    const filterOptions = openCustomSelect("필터");
    expect(
      within(filterOptions)
        .getByRole("option", { name: "등장 횟수 0" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
  });

  it("keeps selected entries when bulk deletion is cancelled", () => {
    const onGuideChange = vi.fn();
    render(
      <GlossaryTab
        guide={makeGuide()}
        onGuideChange={onGuideChange}
        usage={makeUsage()}
      />,
    );
    fireEvent.click(screen.getByLabelText("Alpha 선택"));
    fireEvent.click(screen.getByRole("button", { name: "1개 삭제" }));
    const dialog = screen.getByRole("dialog", { name: "1개 삭제" });
    fireEvent.click(within(dialog).getByRole("button", { name: "취소" }));

    expect(onGuideChange).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Alpha 선택")).toHaveProperty("checked", true);
  });

  it("accepts keyboard input after confirming a bulk deletion", async () => {
    const nativeConfirm = vi.spyOn(window, "confirm");
    render(<StatefulGlossaryTab />);

    fireEvent.click(screen.getByLabelText("Alpha 선택"));
    fireEvent.click(screen.getByRole("button", { name: "1개 삭제" }));
    const dialog = screen.getByRole("dialog", { name: "1개 삭제" });
    fireEvent.click(within(dialog).getByRole("button", { name: "삭제" }));

    await waitFor(() =>
      expect(screen.queryByLabelText("Alpha 선택")).toBeNull(),
    );
    expect(nativeConfirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "행 추가" }));
    const draftRow = document.querySelector(".style-guide-row.is-draft");
    expect(draftRow).not.toBeNull();
    const translation = within(draftRow as HTMLElement).getByPlaceholderText(
      "번역",
    );
    translation.focus();
    fireEvent.keyDown(translation, { key: "ㅎ", code: "KeyG" });
    fireEvent.change(translation, { target: { value: "삭제 후 입력" } });

    expect(document.activeElement).toBe(translation);
    expect(translation).toHaveProperty("value", "삭제 후 입력");
  });

  it("selects and clears every visible glossary entry from the table header", () => {
    render(
      <GlossaryTab
        guide={makeGuide()}
        onGuideChange={vi.fn()}
        usage={makeUsage()}
      />,
    );
    const selectAll = screen.getByLabelText("현재 목록 전체 선택");

    fireEvent.click(selectAll);
    expect(screen.getByLabelText("Alpha 선택")).toHaveProperty("checked", true);
    expect(screen.getByLabelText("Beta 선택")).toHaveProperty("checked", true);
    expect(screen.getByRole("button", { name: "2개 삭제" })).toHaveProperty(
      "disabled",
      false,
    );

    fireEvent.click(selectAll);
    expect(screen.getByLabelText("Alpha 선택")).toHaveProperty(
      "checked",
      false,
    );
    expect(screen.getByLabelText("Beta 선택")).toHaveProperty("checked", false);
  });

  it("prunes selected IDs when entries are removed by an external update", () => {
    const guide = makeGuide();
    const props = {
      onGuideChange: vi.fn(),
      usage: makeUsage(),
    };
    const { rerender } = render(<GlossaryTab guide={guide} {...props} />);
    fireEvent.click(screen.getByLabelText("Alpha 선택"));
    expect(screen.getByRole("button", { name: "1개 삭제" })).toHaveProperty(
      "disabled",
      false,
    );

    rerender(
      <GlossaryTab
        guide={{
          ...guide,
          glossary: guide.glossary.filter((entry) => entry.id !== "alpha"),
        }}
        {...props}
      />,
    );

    expect(screen.queryByLabelText("Alpha 선택")).toBeNull();
    expect(screen.getByLabelText("Beta 선택")).toHaveProperty("checked", false);
    expect(screen.getByRole("button", { name: "0개 삭제" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("distinguishes an empty glossary from a filtered list with no matches", () => {
    const guide = makeGuide();
    const props = { onGuideChange: vi.fn(), usage: makeUsage() };
    const { rerender } = render(
      <GlossaryTab guide={{ ...guide, glossary: [] }} {...props} />,
    );

    expect(screen.getByText(/등록된 용어가 없습니다/)).toBeTruthy();

    rerender(<GlossaryTab guide={guide} {...props} />);
    fireEvent.change(screen.getByLabelText("이름·번역·별칭 검색"), {
      target: { value: "존재하지 않는 용어" },
    });

    expect(screen.getByText("조건에 맞는 항목이 없습니다.")).toBeTruthy();
  });

  it("keeps add-row in the table action header beside enabled, even when empty", () => {
    const guide = makeGuide();
    const onGuideChange = vi.fn();
    render(
      <GlossaryTab
        guide={{ ...guide, glossary: [] }}
        onGuideChange={onGuideChange}
      />,
    );

    const addRow = screen.getByRole("button", { name: "행 추가" });
    const header = addRow.closest(".style-guide-row.head");
    expect(header).not.toBeNull();
    expect(addRow.previousElementSibling?.textContent).toBe("활성");

    fireEvent.click(addRow);
    expect(onGuideChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        glossary: [expect.objectContaining({ source: "", target: "" })],
      }),
    );
  });

  it("uses a target-only glossary name when optional metadata is absent", () => {
    const guide = makeGuide();
    guide.glossary = [
      {
        ...guide.glossary[0],
        source: "",
        target: "번역어",
        aliases: undefined,
        note: undefined,
      },
    ];
    render(<GlossaryTab guide={guide} onGuideChange={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("이름·번역·별칭 검색"), {
      target: { value: "번역어" },
    });
    chooseCustomSelectOption("정렬", "이름");
    expect(screen.getByLabelText("번역어 선택")).toBeTruthy();
    expect(screen.getByRole("switch", { name: "번역어 활성화" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "번역어 삭제" })).toBeTruthy();
  });
});

function glossarySourceOrder(): string[] {
  return screen
    .getAllByPlaceholderText("원문")
    .map((input) => (input as HTMLInputElement).value);
}

function StatefulGlossaryTab(): React.JSX.Element {
  const [guide, setGuide] = React.useState(makeGuide);
  return (
    <GlossaryTab guide={guide} onGuideChange={setGuide} usage={makeUsage()} />
  );
}

function StatefulCharactersTab(): React.JSX.Element {
  const [guide, setGuide] = React.useState(makeGuide);
  return (
    <CharactersTab
      guide={guide}
      onGuideChange={setGuide}
      usage={makeCharacterUsage()}
    />
  );
}

function StatefulTabContent({
  tab,
}: {
  tab: "glossary" | "characters";
}): React.JSX.Element {
  const [guide, setGuide] = React.useState(makeGuide);
  return (
    <StyleGuideTabContent
      busy={false}
      guide={guide}
      memory={null}
      onGuideChange={setGuide}
      onMemoryChange={() => undefined}
      tab={tab}
      usage={{
        workId: guide.workId,
        glossary: makeUsage(),
        characters: makeCharacterUsage(),
      }}
      usageStatus="ready"
    />
  );
}

function makeGuide(): WorkStyleGuide {
  return {
    schemaVersion: 1,
    workId: "work-1",
    glossary: [
      {
        id: "alpha",
        source: "Alpha",
        target: "Alpha",
        category: "term",
        aliases: [],
        enabled: true,
        origin: "manual",
        createdAt: TS,
        updatedAt: TS,
      },
      {
        id: "beta",
        source: "Beta",
        target: "Beta",
        category: "term",
        aliases: [],
        enabled: true,
        origin: "ai",
        createdAt: TS,
        updatedAt: TS,
      },
    ],
    characters: [
      {
        id: "minho",
        displayName: "민호",
        sourceNames: ["ミンホ"],
        targetName: "민호",
        aliases: [],
        speechStyle: "neutral",
        enabled: true,
        origin: "manual",
        createdAt: TS,
        updatedAt: TS,
      },
      {
        id: "yuna",
        displayName: "유나",
        sourceNames: ["ユナ"],
        targetName: "유나",
        aliases: [],
        speechStyle: "casual",
        enabled: true,
        origin: "ai",
        createdAt: TS,
        updatedAt: TS,
      },
    ],
    rules: {
      honorifics: "preserve",
      sfxMode: "translate",
      defaultTone: "natural_korean",
    },
    createdAt: TS,
    updatedAt: TS,
  };
}

function makeUsage(): WorkContextUsageMetric[] {
  return [
    { id: "alpha", pageCount: 1, mentionCount: 2 },
    {
      id: "beta",
      pageCount: 5,
      mentionCount: 7,
      lastSeen: {
        chapterId: "chapter-1",
        chapterTitle: "1화",
        chapterIndex: 0,
        pageId: "page-5",
        pageName: "005.png",
        pageIndex: 4,
      },
    },
  ];
}

function makeCharacterUsage(): WorkContextUsageMetric[] {
  return [
    { id: "minho", pageCount: 1, mentionCount: 1 },
    { id: "yuna", pageCount: 3, mentionCount: 4 },
  ];
}
