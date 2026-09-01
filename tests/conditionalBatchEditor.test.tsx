/* eslint-disable max-lines -- stateful editor, result-panel, and workspace integration scenarios share one production harness */
/** @vitest-environment jsdom */

import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { AppWorkspaceProps } from "../src/renderer/src/components/appWorkspaceTypes";
import {
  ConditionalBatchEditor,
  type ConditionalBatchEditorProps,
} from "../src/renderer/src/components/ConditionalBatchEditor";
import { ConditionalBatchResultsCard } from "../src/renderer/src/components/ConditionalBatchResultsCard";
import {
  ConditionalBatchRulePanel,
  type ConditionalBatchRulePanelProps,
} from "../src/renderer/src/components/ConditionalBatchRulePanel";
import {
  isNewConditionalBatchConditionField,
  isNewConditionalBatchWritableField,
  listConditionalBatchFields,
} from "../src/renderer/src/components/conditionalBatchUi";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import {
  FontsContext,
  type FontsContextValue,
} from "../src/renderer/src/fonts/fontsContextValue";
import {
  DEFAULT_BLOCK_FONT_CATALOG,
  getBaseBlockFontOptions,
  getBlockFontOptions,
} from "../src/renderer/src/lib/fonts";
import { createWorkspaceInteractionPreviewStore } from "../src/renderer/src/lib/workspaceInteractionPreview";
import { createConditionalBatchPreview } from "../src/shared/conditionalBatchEngine";
import {
  createConditionalBatchStarterSchemes,
  createEllipsisBatchSchemeDraft,
  type ConditionalBatchPreview,
  type ConditionalBatchPreviewResult,
  type ConditionalBatchSchemeV2,
} from "../src/shared/conditionalBatchRules";
import type { ChapterSnapshot, MangaPage } from "../src/shared/libraryTypes";
import type { TranslationBlock } from "../src/shared/textTypes";

const gatewayMocks = vi.hoisted(() => ({
  deleteScheme: vi.fn(),
  listSchemes: vi.fn(),
  saveScheme: vi.fn(),
}));

const originalGetContext = HTMLCanvasElement.prototype.getContext;
const originalResizeObserver = globalThis.ResizeObserver;

beforeAll(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: () => ({
      font: "",
      measureText: (text: string) => ({ width: Array.from(text).length * 10 }),
    }),
  });
  globalThis.ResizeObserver = class ResizeObserver {
    disconnect(): void {}

    observe(): void {}

    unobserve(): void {}
  };
});

afterAll(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: originalGetContext,
  });
  globalThis.ResizeObserver = originalResizeObserver;
});

beforeEach(() => {
  window.localStorage.clear();
  const starterSchemes = createConditionalBatchStarterSchemes();
  gatewayMocks.listSchemes.mockReset().mockResolvedValue({
    schemaVersion: 1,
    schemes: starterSchemes,
    sequences: [],
  });
  gatewayMocks.saveScheme
    .mockReset()
    .mockImplementation(async ({ id, scheme }) => ({
      schemaVersion: 1,
      schemes: [
        {
          id: id ?? "saved-rule",
          ...scheme,
        } satisfies ConditionalBatchSchemeV2,
        ...starterSchemes.filter((starter) => starter.id !== id),
      ],
      sequences: [],
    }));
  gatewayMocks.deleteScheme.mockReset().mockResolvedValue({
    schemaVersion: 1,
    schemes: starterSchemes,
    sequences: [],
  });
  Object.defineProperty(window, "mangaApi", {
    configurable: true,
    value: createTestMangaGatewayStub({
      deleteConditionalBatchScheme: gatewayMocks.deleteScheme,
      listConditionalBatchSchemes: gatewayMocks.listSchemes,
      saveConditionalBatchScheme: gatewayMocks.saveScheme,
    }),
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "mangaApi");
});

describe("beginner conditional batch editor", () => {
  it("keeps sequence and advanced tools independently open by default", () => {
    const draft = createEllipsisBatchSchemeDraft();
    const savedSchemes: ConditionalBatchSchemeV2[] = [
      { id: "rule-1", ...draft, name: "첫 규칙" },
      { id: "rule-2", ...draft, name: "둘째 규칙" },
    ];
    const sequence = {
      id: "sequence-1",
      name: "연속 규칙",
      description: "순서대로 실행",
      steps: [
        { id: "step-1", schemeId: "rule-1", enabled: true },
        { id: "step-2", schemeId: "rule-2", enabled: false },
      ],
    };
    const callbacks = {
      onChangeDraft: vi.fn(),
      onChangeScope: vi.fn(),
      onChooseRecipe: vi.fn(),
      onCloseRecipePicker: vi.fn(),
      onDeleteScheme: vi.fn(),
      onDeleteSequence: vi.fn(),
      onDuplicateScheme: vi.fn(),
      onExportYaml: vi.fn(),
      onImportYaml: vi.fn(),
      onExitSequence: vi.fn(),
      onNewScheme: vi.fn(),
      onOpenYaml: vi.fn(),
      onOpenYamlFile: vi.fn(),
      onReflectYaml: vi.fn(),
      onPreviewSequence: vi.fn(),
      onSaveScheme: vi.fn(),
      onSaveSequence: vi.fn(),
      onSelectScheme: vi.fn(),
      onSetYamlOpen: vi.fn(),
      onSetYamlText: vi.fn(),
      onToggleSchemeFavorite: vi.fn(),
    };
    const props: ConditionalBatchRulePanelProps = {
      activeSequence: null,
      applyNotice: { kind: "info", message: "미리보기 갱신됨" },
      autosaveState: "saved",
      blockStylePresets: [],
      canDeleteScheme: true,
      currentResult: null,
      draft,
      favoriteSchemeIds: ["rule-1"],
      recipePickerCanClose: true,
      recipePickerOpen: false,
      savedSchemes,
      scopeKind: "page",
      selectedBlockCount: 2,
      selectedSchemeId: "rule-1",
      sequences: [sequence],
      sequencePreview: null,
      storageBusy: false,
      storageError: "저장소 경고",
      temporarySchemes: [{ id: "temp-1", name: "임시 규칙", dirty: true }],
      validationMessage: null,
      yamlError: "YAML 구문 오류",
      yamlOpen: true,
      yamlText: "schemaVersion: 1",
      ...callbacks,
    };
    const view = render(
      <FontsContext.Provider value={FONTS_CONTEXT}>
        <ConditionalBatchRulePanel {...props} />
      </FontsContext.Provider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "규칙 편집" }));
    fireEvent.change(screen.getByLabelText("규칙 이름"), {
      target: { value: "이름 수정" },
    });
    fireEvent.change(screen.getByLabelText("설명"), {
      target: { value: "설명 수정" },
    });
    fireEvent.click(screen.getByRole("button", { name: "규칙 복제" }));
    expect(callbacks.onDuplicateScheme).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "저장된 규칙 삭제" }));
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "규칙 삭제" })).getByRole(
        "button",
        { name: "취소" },
      ),
    );

    const sequenceToggle = screen.getByRole("button", { name: "연속 실행" });
    const advancedToggle = screen.getByRole("button", { name: "고급" });
    expect(sequenceToggle.getAttribute("aria-expanded")).toBe("true");
    expect(advancedToggle.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(sequenceToggle);
    expect(sequenceToggle.getAttribute("aria-expanded")).toBe("false");
    expect(advancedToggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(sequenceToggle);

    fireEvent.click(advancedToggle);
    expect(advancedToggle.getAttribute("aria-expanded")).toBe("false");
    expect(sequenceToggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(advancedToggle);

    fireEvent.click(screen.getByRole("button", { name: "규칙 내보내기" }));
    fireEvent.click(screen.getByRole("button", { name: "전체 내보내기" }));
    fireEvent.click(screen.getByRole("button", { name: "직접 편집" }));
    fireEvent.click(screen.getByRole("button", { name: "가져오기" }));
    fireEvent.change(screen.getByLabelText("일괄 편집 YAML"), {
      target: { value: "schemaVersion: 1\nschemes: []" },
    });
    fireEvent.click(screen.getByRole("button", { name: "카드에 반영" }));
    fireEvent.click(
      screen.getByRole("button", { name: "새 규칙으로 가져오기" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "같은 ID 덮어쓰기" }));

    fireEvent.click(screen.getByRole("button", { name: "미리보기" }));
    fireEvent.click(screen.getByRole("button", { name: "연속 규칙 편집" }));
    fireEvent.click(
      screen.getAllByRole("button", { name: "연속 실행 단계 복제" })[0],
    );
    fireEvent.click(
      screen.getAllByRole("button", { name: "연속 실행 단계 아래로 이동" })[0],
    );
    fireEvent.click(
      screen.getAllByRole("button", { name: "연속 실행 단계 삭제" })[0],
    );
    fireEvent.click(screen.getByRole("button", { name: "업데이트" }));
    expect(callbacks.onSaveSequence).toHaveBeenCalled();

    view.rerender(
      <FontsContext.Provider value={FONTS_CONTEXT}>
        <ConditionalBatchRulePanel
          {...props}
          activeSequence={sequence}
          sequencePreview={null}
        />
      </FontsContext.Provider>,
    );
    expect(screen.getByText("사용 안 함")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "규칙 편집으로 돌아가기" }),
    );
    expect(callbacks.onExitSequence).toHaveBeenCalledOnce();
  });

  it("toggles condition and action sections independently across rule changes", async () => {
    render(
      <FontsContext.Provider value={FONTS_CONTEXT}>
        <ConditionalBatchEditor
          chapter={CHAPTER}
          selectedPageId="page-1"
          workspaceProps={WORKSPACE_PROPS}
          busy={false}
          canUndo={false}
          undoLabel={null}
          onApply={() => ({
            appliedCount: 0,
            conflictCount: 0,
            dirtyPageIds: [],
          })}
          onClose={() => undefined}
          onSelectPage={() => undefined}
          onUndo={async () => false}
        />
      </FontsContext.Provider>,
    );
    await waitFor(() =>
      expect(gatewayMocks.listSchemes).toHaveBeenCalledOnce(),
    );
    const recipePanel = screen
      .getByText("새 규칙", { selector: "strong" })
      .closest("section");
    expect(recipePanel).not.toBeNull();
    const recipes = within(recipePanel as HTMLElement);
    expect(recipes.getByRole("button", { name: "찾아 바꾸기" })).toBeTruthy();
    expect(
      recipes.getByRole("button", { name: "말줄임표·공백 정리" }),
    ).toBeTruthy();
    expect(
      recipes.getByRole("button", { name: "직접 규칙 생성" }),
    ).toBeTruthy();
    expect(
      recipes.queryByRole("button", { name: "효과음 서식 적용" }),
    ).toBeNull();
    expect(recipes.queryByRole("button", { name: "빈 번역 찾기" })).toBeNull();
    expect(
      recipes.queryByRole("button", { name: "낮은 인식 신뢰도 찾기" }),
    ).toBeNull();
    expect(recipes.queryByText("검사 레시피")).toBeNull();
    expect(screen.queryByRole("button", { name: "적용" })).toBeNull();
    fireEvent.click(recipes.getByRole("button", { name: "직접 규칙 생성" }));
    expect(screen.getByRole("button", { name: "적용" })).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "모두 맞을 때" }));

    const conditionToggle = getTopLevelSectionToggle("대상 조건");
    const actionToggle = getTopLevelSectionToggle("작업");
    expect(conditionToggle.getAttribute("aria-expanded")).toBe("true");
    expect(actionToggle.getAttribute("aria-expanded")).toBe("true");

    fireEvent.change(screen.getByLabelText("값"), {
      target: { value: "접어도 남는 조건" },
    });
    fireEvent.change(screen.getByLabelText("글자 그대로"), {
      target: { value: "유효한 찾기" },
    });
    fireEvent.click(conditionToggle);
    expect(conditionToggle.getAttribute("aria-expanded")).toBe("false");
    expect(actionToggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByLabelText("글자 그대로")).toBeTruthy();

    fireEvent.click(actionToggle);
    expect(conditionToggle.getAttribute("aria-expanded")).toBe("false");
    expect(actionToggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByLabelText("값")).toBeNull();
    expect(screen.queryByLabelText("글자 그대로")).toBeNull();

    fireEvent.click(conditionToggle);
    expect(conditionToggle.getAttribute("aria-expanded")).toBe("true");
    expect(actionToggle.getAttribute("aria-expanded")).toBe("false");
    expect((screen.getByLabelText("값") as HTMLInputElement).value).toBe(
      "접어도 남는 조건",
    );

    fireEvent.click(screen.getByRole("button", { name: "새 규칙" }));
    fireEvent.click(screen.getByRole("button", { name: "직접 규칙 생성" }));
    expect(
      getTopLevelSectionToggle("대상 조건").getAttribute("aria-expanded"),
    ).toBe("true");
    expect(getTopLevelSectionToggle("작업").getAttribute("aria-expanded")).toBe(
      "false",
    );

    fireEvent.click(screen.getByRole("combobox", { name: "현재 규칙" }));
    fireEvent.click(screen.getByRole("option", { name: "새 규칙 •" }));
    expect((screen.getByLabelText("값") as HTMLInputElement).value).toBe(
      "접어도 남는 조건",
    );
    expect(
      getTopLevelSectionToggle("대상 조건").getAttribute("aria-expanded"),
    ).toBe("true");
    expect(getTopLevelSectionToggle("작업").getAttribute("aria-expanded")).toBe(
      "false",
    );

    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(gatewayMocks.saveScheme).toHaveBeenCalledOnce());
    expect(
      getTopLevelSectionToggle("대상 조건").getAttribute("aria-expanded"),
    ).toBe("true");
    expect(getTopLevelSectionToggle("작업").getAttribute("aria-expanded")).toBe(
      "false",
    );

    fireEvent.click(screen.getByRole("button", { name: "저장된 규칙 삭제" }));
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "규칙 삭제" })).getByRole(
        "button",
        { name: "삭제" },
      ),
    );
    await waitFor(() =>
      expect(gatewayMocks.deleteScheme).toHaveBeenCalledOnce(),
    );
    expect(
      getTopLevelSectionToggle("대상 조건").getAttribute("aria-expanded"),
    ).toBe("true");
    expect(getTopLevelSectionToggle("작업").getAttribute("aria-expanded")).toBe(
      "false",
    );
  });

  it("uses saved-rule stars as the new-rule quick buttons", async () => {
    render(
      <FontsContext.Provider value={FONTS_CONTEXT}>
        <ConditionalBatchEditor
          chapter={CHAPTER}
          selectedPageId="page-1"
          workspaceProps={WORKSPACE_PROPS}
          busy={false}
          canUndo={false}
          undoLabel={null}
          onApply={() => ({
            appliedCount: 0,
            conflictCount: 0,
            dirtyPageIds: [],
          })}
          onClose={() => undefined}
          onSelectPage={() => undefined}
          onUndo={async () => false}
        />
      </FontsContext.Provider>,
    );
    await waitFor(() =>
      expect(gatewayMocks.listSchemes).toHaveBeenCalledOnce(),
    );
    const recipePanel = screen
      .getByText("새 규칙", { selector: "strong" })
      .closest("section");
    if (!recipePanel) throw new Error("new-rule panel is missing");
    expect(
      within(recipePanel).getByRole("button", { name: "찾아 바꾸기" }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("combobox", { name: "현재 규칙" }));
    fireEvent.click(screen.getByLabelText("찾아 바꾸기 빠른 규칙에서 제거"));
    expect(
      within(recipePanel).queryByRole("button", { name: "찾아 바꾸기" }),
    ).toBeNull();
    expect(
      JSON.parse(
        window.localStorage.getItem("conditionalBatch.favoriteSchemeIds.v1") ??
          "[]",
      ),
    ).not.toContain("starter-find-replace");

    fireEvent.click(screen.getByLabelText("찾아 바꾸기 빠른 규칙에 추가"));
    expect(
      within(recipePanel).getByRole("button", { name: "찾아 바꾸기" }),
    ).toBeTruthy();
  });

  it("keeps conditions while switching match modes", async () => {
    render(
      <FontsContext.Provider value={FONTS_CONTEXT}>
        <ConditionalBatchEditor
          chapter={CHAPTER}
          selectedPageId="page-1"
          workspaceProps={WORKSPACE_PROPS}
          busy={false}
          canUndo={false}
          undoLabel={null}
          onApply={() => ({
            appliedCount: 0,
            conflictCount: 0,
            dirtyPageIds: [],
          })}
          onClose={() => undefined}
          onSelectPage={() => undefined}
          onUndo={async () => false}
        />
      </FontsContext.Provider>,
    );
    await waitFor(() =>
      expect(gatewayMocks.listSchemes).toHaveBeenCalledOnce(),
    );
    fireEvent.click(screen.getByRole("button", { name: "직접 규칙 생성" }));
    fireEvent.click(screen.getByRole("radio", { name: "모두 맞을 때" }));
    fireEvent.change(screen.getByLabelText("값"), {
      target: { value: "돌아와도 남을 조건" },
    });

    fireEvent.click(screen.getByRole("radio", { name: "모든 말풍선" }));
    expect(screen.queryByLabelText("값")).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "하나라도 맞을 때" }));
    expect((screen.getByLabelText("값") as HTMLInputElement).value).toBe(
      "돌아와도 남을 조건",
    );
    fireEvent.click(screen.getByRole("radio", { name: "모두 맞을 때" }));
    expect((screen.getByLabelText("값") as HTMLInputElement).value).toBe(
      "돌아와도 남을 조건",
    );
  });

  it("groups fields by workflow priority and uses the favorite-aware font picker", async () => {
    const savePreferences = vi.fn(async () => undefined);
    const font = requiredItem(FONT_OPTIONS, 1);
    const fields = listConditionalBatchFields();
    expect(fields.slice(0, 6).map((field) => field.id)).toEqual([
      "translatedText",
      "sourceText",
      "textRole",
      "speakerId",
      "hasSpeaker",
      "hasGlossary",
    ]);
    expect([...new Set(fields.map((field) => field.categoryLabel))]).toEqual([
      "텍스트·대사",
      "글꼴·글자 모양",
      "방향·배치",
      "검수·인식",
      "자동 검사",
      "위치·분량",
      "고급 텍스트 효과",
    ]);
    expect(isNewConditionalBatchConditionField("outlineWidthScale")).toBe(
      false,
    );
    expect(isNewConditionalBatchWritableField("outlineWidthScale")).toBe(false);
    expect(isNewConditionalBatchConditionField("textEffectColor")).toBe(false);
    expect(isNewConditionalBatchWritableField("textEffectColor")).toBe(true);
    expect(isNewConditionalBatchConditionField("textEffectEnabled")).toBe(true);
    expect(isNewConditionalBatchConditionField("pageIndex")).toBe(false);
    expect(isNewConditionalBatchConditionField("blockIndex")).toBe(false);
    expect(isNewConditionalBatchConditionField("bboxAspectRatio")).toBe(false);

    render(
      <FontsContext.Provider value={{ ...FONTS_CONTEXT, savePreferences }}>
        <ConditionalBatchEditor
          chapter={CHAPTER}
          selectedPageId="page-1"
          workspaceProps={WORKSPACE_PROPS}
          busy={false}
          canUndo={false}
          undoLabel={null}
          onApply={() => ({
            appliedCount: 0,
            conflictCount: 0,
            dirtyPageIds: [],
          })}
          onClose={() => undefined}
          onSelectPage={() => undefined}
          onUndo={async () => false}
        />
      </FontsContext.Provider>,
    );
    await waitFor(() =>
      expect(gatewayMocks.listSchemes).toHaveBeenCalledOnce(),
    );
    fireEvent.click(screen.getByRole("button", { name: "직접 규칙 생성" }));
    fireEvent.click(screen.getByRole("radio", { name: "모두 맞을 때" }));
    fireEvent.click(screen.getByRole("combobox", { name: "조건 필드" }));
    fireEvent.click(screen.getByRole("option", { name: "글꼴" }));
    expect(
      screen.getByRole("combobox", { name: "비교 방법" }).textContent,
    ).toContain("같음");

    const fontSelect = screen.getByRole("combobox", {
      name: "글꼴 조건 값",
    });
    fireEvent.click(fontSelect);
    const fontOption = screen.getByRole("option", { name: font.label });
    const favorite = fontOption.querySelector<HTMLButtonElement>(
      'button[aria-pressed="false"]',
    );
    expect(favorite).not.toBeNull();
    fireEvent.click(favorite as HTMLButtonElement);
    expect(savePreferences).toHaveBeenCalledWith(
      expect.objectContaining({ favoriteIds: [font.id] }),
    );
    fireEvent.click(fontOption);
    expect(fontSelect.textContent).toContain(font.label);
    expect(screen.queryByRole("textbox", { name: "값" })).toBeNull();

    fireEvent.click(screen.getByText("작업 추가"));
    fireEvent.click(screen.getByRole("button", { name: "글자 일부 서식" }));
    fireEvent.click(
      screen.getByRole("checkbox", { name: "기존 서식으로 범위 좁히기" }),
    );
    fireEvent.click(screen.getByRole("combobox", { name: "기존 부분 서식" }));
    fireEvent.click(screen.getByRole("option", { name: "글꼴" }));
    expect(
      screen.getByRole("combobox", {
        name: "비교할 부분 서식 글꼴",
      }),
    ).toBeTruthy();
  });

  it("uses an in-app confirmation instead of the native close prompt", async () => {
    const onClose = vi.fn();
    const nativeConfirm = vi.spyOn(window, "confirm");
    render(
      <FontsContext.Provider value={FONTS_CONTEXT}>
        <ConditionalBatchEditor
          chapter={CHAPTER}
          selectedPageId="page-1"
          workspaceProps={WORKSPACE_PROPS}
          busy={false}
          canUndo={false}
          undoLabel={null}
          onApply={() => ({
            appliedCount: 0,
            conflictCount: 0,
            dirtyPageIds: [],
          })}
          onClose={onClose}
          onSelectPage={() => undefined}
          onUndo={async () => false}
        />
      </FontsContext.Provider>,
    );
    await waitFor(() =>
      expect(gatewayMocks.listSchemes).toHaveBeenCalledOnce(),
    );
    fireEvent.click(screen.getByRole("button", { name: "직접 규칙 생성" }));
    fireEvent.click(screen.getByLabelText("규칙 편집"));
    fireEvent.change(screen.getByLabelText("규칙 이름"), {
      target: { value: "닫기 확인 대상" },
    });
    fireEvent.click(screen.getByRole("button", { name: "닫기" }));
    expect(nativeConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "임시 규칙 닫기" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "닫기" }));
    fireEvent.click(screen.getByRole("button", { name: "버리고 닫기" }));
    expect(onClose).toHaveBeenCalledOnce();
    nativeConfirm.mockRestore();
  });

  it("switches between multiple unsaved rules without losing their inputs", async () => {
    render(
      <FontsContext.Provider value={FONTS_CONTEXT}>
        <ConditionalBatchEditor
          chapter={CHAPTER}
          selectedPageId="page-1"
          workspaceProps={WORKSPACE_PROPS}
          busy={false}
          canUndo={false}
          undoLabel={null}
          onApply={() => ({
            appliedCount: 0,
            conflictCount: 0,
            dirtyPageIds: [],
          })}
          onClose={() => undefined}
          onSelectPage={() => undefined}
          onUndo={async () => false}
        />
      </FontsContext.Provider>,
    );
    await waitFor(() =>
      expect(gatewayMocks.listSchemes).toHaveBeenCalledOnce(),
    );
    fireEvent.click(screen.getByRole("button", { name: "직접 규칙 생성" }));
    await waitFor(() =>
      expect(screen.getByLabelText("글자 그대로")).toBeTruthy(),
    );
    fireEvent.change(screen.getByLabelText("글자 그대로"), {
      target: { value: "규칙 A 입력" },
    });

    fireEvent.click(screen.getByRole("button", { name: "새 규칙" }));
    fireEvent.click(screen.getByRole("button", { name: "말줄임표·공백 정리" }));
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "현재 규칙" }).textContent,
      ).toContain("말줄임표·공백 정리"),
    );

    fireEvent.click(screen.getByRole("combobox", { name: "현재 규칙" }));
    fireEvent.click(screen.getByRole("option", { name: "새 규칙 •" }));
    await waitFor(() =>
      expect(
        (screen.getByLabelText("글자 그대로") as HTMLInputElement).value,
      ).toBe("규칙 A 입력"),
    );

    fireEvent.click(screen.getByRole("button", { name: "임시 규칙 제거" }));
    expect(screen.getByRole("dialog", { name: "임시 규칙 제거" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "제거" }));
    expect(
      screen.getByRole("combobox", { name: "현재 규칙" }).textContent,
    ).toContain("새 규칙");

    fireEvent.click(screen.getByRole("button", { name: "새 규칙" }));
    const closeButtons = screen.getAllByRole("button", { name: "닫기" });
    fireEvent.click(requiredItem(closeButtons, closeButtons.length - 1));
    expect(screen.queryByText("검사 레시피")).toBeNull();
  });

  it("uses empty placeholders and lets a single find part be cleared", async () => {
    render(
      <FontsContext.Provider value={FONTS_CONTEXT}>
        <ConditionalBatchEditor
          chapter={CHAPTER}
          selectedPageId="page-1"
          workspaceProps={WORKSPACE_PROPS}
          busy={false}
          canUndo={false}
          undoLabel={null}
          onApply={() => ({
            appliedCount: 0,
            conflictCount: 0,
            dirtyPageIds: [],
          })}
          onClose={() => undefined}
          onSelectPage={() => undefined}
          onUndo={async () => false}
        />
      </FontsContext.Provider>,
    );
    await waitFor(() =>
      expect(gatewayMocks.listSchemes).toHaveBeenCalledOnce(),
    );
    fireEvent.click(
      requiredItem(screen.getAllByRole("button", { name: "찾아 바꾸기" }), 0),
    );

    const find = screen.getByLabelText("글자 그대로") as HTMLInputElement;
    const replace = screen.getByLabelText("바꿀 글자") as HTMLInputElement;
    expect(find.value).toBe("");
    expect(find.placeholder).toBe("찾을 글자");
    expect(replace.value).toBe("");
    expect(replace.placeholder).toBe("바꿀 글자");
    expect(screen.queryByLabelText("패턴 조각 끌기")).toBeNull();

    fireEvent.change(find, { target: { value: "지울 수 있는 값" } });
    fireEvent.change(find, { target: { value: "" } });
    expect(find.value).toBe("");
    fireEvent.click(screen.getByLabelText("패턴 조각 추가"));
    fireEvent.click(screen.getByRole("button", { name: "반복·기억 설정" }));
    fireEvent.click(screen.getByLabelText("조각 삭제"));
    expect(
      (screen.getByLabelText("글자 그대로") as HTMLInputElement).value,
    ).toBe("");
    expect(screen.getByLabelText("1번 작업 삭제")).toBeTruthy();
    expect(screen.getByLabelText("메모")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("1번 작업 삭제"));
    expect(screen.queryByText("검수 필요로 표시")).toBeNull();
    expect(screen.getByText("작업 추가")).toBeTruthy();
  });

  it("opens a prefilled compact rule without exposing regex syntax", async () => {
    render(
      <FontsContext.Provider value={FONTS_CONTEXT}>
        <ConditionalBatchEditor
          chapter={CHAPTER}
          selectedPageId="page-1"
          workId="work-1"
          initialFind="제12화"
          initialReplace="12화"
          workspaceProps={WORKSPACE_PROPS}
          busy={false}
          canUndo={false}
          undoLabel={null}
          onApply={() => ({
            appliedCount: 0,
            conflictCount: 0,
            dirtyPageIds: [],
          })}
          onClose={() => undefined}
          onSelectPage={() => undefined}
          onUndo={async () => false}
        />
      </FontsContext.Provider>,
    );

    await waitFor(() =>
      expect(gatewayMocks.listSchemes).toHaveBeenCalledOnce(),
    );
    expect(
      (screen.getByLabelText("글자 그대로") as HTMLInputElement).value,
    ).toBe("제12화");
    expect(screen.queryByText("새 규칙", { selector: "strong" })).toBeNull();
    fireEvent.click(screen.getByText("작업 추가"));
    fireEvent.click(screen.getByRole("button", { name: "텍스트 전체 바꾸기" }));
    expect(screen.getAllByLabelText(/번 작업 삭제/)).toHaveLength(2);

    fireEvent.click(screen.getByLabelText("규칙 편집"));
    fireEvent.change(screen.getByLabelText("규칙 이름"), {
      target: { value: "회차 표기 정리" },
    });
    expect(
      screen.getByRole("combobox", { name: "현재 규칙" }).textContent,
    ).toContain("회차 표기 정리");
  });

  it("previews, excludes, applies, persists, deletes, and undoes from the real editor controls", async () => {
    const onApply = vi.fn<ConditionalBatchEditorProps["onApply"]>(() => ({
      appliedCount: 2,
      conflictCount: 0,
      dirtyPageIds: ["page-1", "page-2"],
    }));
    const onClose = vi.fn();
    const onSelectPage = vi.fn();
    const onUndo = vi.fn(async () => true);
    render(
      <FontsContext.Provider value={FONTS_CONTEXT}>
        <ConditionalBatchEditor
          chapter={CHAPTER}
          selectedPageId="page-1"
          workspaceProps={WORKSPACE_PROPS}
          busy={false}
          canUndo
          undoLabel="일괄 편집: 말줄임표·공백 정리"
          onApply={onApply}
          onClose={onClose}
          onSelectPage={onSelectPage}
          onUndo={onUndo}
        />
      </FontsContext.Provider>,
    );

    await waitFor(() =>
      expect(gatewayMocks.listSchemes).toHaveBeenCalledOnce(),
    );
    expect(screen.getByRole("dialog", { name: "일괄 편집" })).toBeTruthy();
    expect(screen.queryByText("쉬운 규칙 만들기")).toBeNull();
    expect(
      screen.queryByText("처음에는 한 페이지만 시험해 보는 편이 안전합니다."),
    ).toBeNull();
    expect(
      screen.queryByText(
        "정규식이 아닌 일반 글자 그대로 찾습니다. 바꿀 글자를 비우면 삭제합니다.",
      ),
    ).toBeNull();
    expect(screen.queryByText("한 번의 실행 취소로 묶입니다.")).toBeNull();
    expect(screen.queryByText(/이 페이지에서 적용할 말풍선/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "말줄임표·공백 정리" }));
    await waitFor(() =>
      expect(screen.getByLabelText("글자 그대로")).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "규칙 편집" }));
    fireEvent.click(screen.getByRole("button", { name: "규칙 복제" }));
    expect(screen.getByRole("combobox", { name: "치환할 글" })).toBeTruthy();
    expect(
      screen.getByRole("checkbox", { name: "대소문자 구분" }),
    ).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "바꿀 범위" })).toBeTruthy();
    expect(screen.queryByRole("radio", { name: "정규식" })).toBeNull();
    fireEvent.click(screen.getByText("정규식 코드 보기"));
    fireEvent.click(screen.getByRole("button", { name: "직접 수정" }));
    fireEvent.change(screen.getByLabelText("정규식 코드"), {
      target: { value: "[" },
    });
    expect(
      screen.getAllByText(/정규식이 올바르지 않습니다/).length,
    ).toBeGreaterThan(0);
    expect(
      (
        screen.getByRole("button", {
          name: "저장",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.change(screen.getByLabelText("정규식 코드"), {
      target: { value: "\\.{3}" },
    });
    expect(WORKSPACE_PROPS.imageRef.current).toBeNull();
    expect(WORKSPACE_PROPS.stageRef.current).toBeNull();
    expect(WORKSPACE_PROPS.workspacePanelRef.current).toBeNull();
    expect(readWorkspaceTexts()).toEqual(["하나…", "둘…"]);
    expect(
      (
        screen.getByRole("button", {
          name: "적용",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);

    fireEvent.click(screen.getByRole("radio", { name: "변경 전" }));
    expect(readWorkspaceTexts()).toEqual(["하나...", "둘..."]);
    fireEvent.click(screen.getByRole("radio", { name: "화" }));
    expect(
      (
        screen.getByRole("button", {
          name: "적용",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);

    const nextButtons = screen.getAllByRole("button", {
      name: "다음 변경 후보",
    });
    fireEvent.click(requiredItem(nextButtons, 0));
    fireEvent.click(requiredItem(nextButtons, 0));
    expect(onSelectPage).toHaveBeenCalledWith("page-2");

    const previewColumn = document.querySelector(
      "[data-conditional-batch-preview-column]",
    );
    expect(previewColumn).toBeTruthy();
    expect(screen.getByText("결과 3")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "전체 제외" }));
    expect(
      (screen.getByRole("button", { name: "적용" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "전체 포함" }));
    expect(
      (screen.getByRole("button", { name: "적용" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    const firstResultButton = requiredItem(
      Array.from(
        screen
          .getByRole("list", { name: "결과 목록" })
          .querySelectorAll<HTMLButtonElement>(
            "li button, [role='listitem'] button",
          ),
      ),
      0,
    );
    fireEvent.click(firstResultButton);
    const firstWorkspaceText = requiredItem(
      Array.from(
        document.querySelectorAll<HTMLElement>(
          ".workspace .overlay-text-content",
        ),
      ),
      0,
    );
    fireEvent.pointerDown(firstWorkspaceText);
    fireEvent.click(screen.getByRole("checkbox", { name: "1번 결과 포함" }));
    fireEvent.click(screen.getByRole("button", { name: "적용" }));
    expect(onApply).toHaveBeenCalledOnce();
    const excluded = onApply.mock.calls[0]?.[2];
    expect(excluded).toBeInstanceOf(Set);
    expect((excluded as ReadonlySet<string>).size).toBe(1);
    expect(
      screen.getByText("2개를 적용했습니다. 충돌로 건너뜀: 0개"),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(gatewayMocks.saveScheme).toHaveBeenCalledOnce());
    const deleteButton = screen.getByRole("button", {
      name: "저장된 규칙 삭제",
    });
    expect((deleteButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(deleteButton);
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "규칙 삭제" })).getByRole(
        "button",
        { name: "삭제" },
      ),
    );
    await waitFor(() =>
      expect(gatewayMocks.deleteScheme).toHaveBeenCalledWith("saved-rule"),
    );

    fireEvent.click(screen.getByRole("button", { name: "실행 취소" }));
    await waitFor(() => expect(onUndo).toHaveBeenCalledOnce());
    expect(
      await screen.findByText("방금 일괄 편집을 되돌렸습니다."),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "닫기" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps dense result diffs, traces, inspection values, and navigation usable", () => {
    const generated = createConditionalBatchPreview(
      CHAPTER,
      { kind: "chapter" },
      createEllipsisBatchSchemeDraft(),
    );
    const base = requiredItem(generated.results, 0);
    const beforeBlock = {
      ...base.beforeBlock,
      fontFamily: undefined,
      fontSizePx: 20,
      inpaintExcluded: false,
    };
    const afterBlock = {
      ...base.afterBlock,
      fontFamily: "QA Sans",
      fontSizePx: 30,
      inpaintExcluded: true,
    };
    const result: ConditionalBatchPreviewResult = {
      ...base,
      beforeBlock,
      afterBlock,
      changedFields: [
        "translatedText",
        "fontFamily",
        "fontSizePx",
        "inpaintExcluded",
      ],
      conditionEvaluations: [
        {
          conditionId: "condition-1",
          field: "translatedText",
          actualValue: "하나...",
          rawValue: "하나...",
          matched: true,
          enabled: true,
        },
        {
          conditionId: "condition-2",
          field: "sourceText",
          actualValue: "source-block-1",
          rawValue: "source-block-1",
          matched: false,
          enabled: true,
        },
      ],
      actionTrace: [
        {
          actionId: "replace",
          actionType: "replaceText",
          changedFields: ["translatedText"],
        },
        {
          actionId: "fields",
          actionType: "setFields",
          changedFields: ["fontSizePx"],
        },
        {
          actionId: "preset",
          actionType: "applyStylePreset",
          changedFields: ["fontFamily"],
        },
        {
          actionId: "style",
          actionType: "styleText",
          changedFields: [],
        },
      ],
      sequenceTrace: [
        {
          stepId: "step-1",
          schemeId: "scheme-1",
          schemeName: "첫 규칙",
          beforeBlock,
          afterBlock,
          changedFields: ["translatedText"],
          actionTargetFields: ["translatedText"],
          conditionEvaluations: [],
          actionTrace: [],
          conflictFingerprint: base.conflictFingerprint,
        },
        {
          stepId: "step-2",
          schemeId: "scheme-2",
          schemeName: "검사 규칙",
          beforeBlock: afterBlock,
          afterBlock,
          changedFields: [],
          actionTargetFields: [],
          conditionEvaluations: [],
          actionTrace: [],
          conflictFingerprint: base.conflictFingerprint,
        },
      ],
    };
    const preview: ConditionalBatchPreview = {
      ...generated,
      results: [result, ...generated.results.slice(1)],
    };
    const onMoveResult = vi.fn();
    const onSelectResult = vi.fn();
    const onSetAllResultsIncluded = vi.fn();
    const onToggleResult = vi.fn();
    const { rerender } = render(
      <ConditionalBatchResultsCard
        currentResult={result}
        currentResultIndex={0}
        excludedResultKeys={new Set()}
        preview={preview}
        onMoveResult={onMoveResult}
        onSelectResult={onSelectResult}
        onSetAllResultsIncluded={onSetAllResultsIncluded}
        onToggleResult={onToggleResult}
      />,
    );

    expect(screen.getByText("QA Sans")).toBeTruthy();
    expect(screen.getByText("30")).toBeTruthy();
    expect(screen.getByText("예")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "이전 변경 후보" }));
    fireEvent.click(screen.getByRole("button", { name: "다음 변경 후보" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "이번 실행에 포함" }));
    fireEvent.click(screen.getByRole("button", { name: "전체 제외" }));
    fireEvent.click(screen.getByRole("button", { name: "전체 포함" }));
    fireEvent.click(screen.getByText("규칙별 중간 결과"));
    fireEvent.click(screen.getByText("판정 내역"));
    fireEvent.click(
      requiredItem(
        Array.from(
          screen
            .getByRole("list", { name: "결과 목록" })
            .querySelectorAll<HTMLButtonElement>("[role='listitem'] button"),
        ),
        0,
      ),
    );
    expect(onMoveResult.mock.calls).toEqual([[-1], [1]]);
    expect(onToggleResult).toHaveBeenCalledWith(result.key, false);
    expect(onSetAllResultsIncluded.mock.calls).toEqual([[false]]);
    expect(onSelectResult).toHaveBeenCalledWith(result);

    const inspectionResult = {
      ...result,
      beforeBlock: { ...beforeBlock, sourceText: "", translatedText: "" },
      changedFields: [],
    };
    rerender(
      <ConditionalBatchResultsCard
        currentResult={inspectionResult}
        currentResultIndex={0}
        excludedResultKeys={new Set([inspectionResult.key])}
        preview={{
          ...preview,
          inspectionOnly: true,
          results: [inspectionResult],
        }}
        onMoveResult={onMoveResult}
        onSelectResult={onSelectResult}
        onSetAllResultsIncluded={onSetAllResultsIncluded}
        onToggleResult={onToggleResult}
      />,
    );
    expect(screen.getAllByText("∅").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("빈 번역")).toBeTruthy();
  });
});

const TS = "2026-08-30T00:00:00.000Z";
const IMAGE_DATA_URL =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";

function makeBlock(id: string, translatedText: string): TranslationBlock {
  return {
    id,
    type: "nonsolid",
    bbox: { x: 100, y: 100, w: 300, h: 200 },
    sourceText: `source-${id}`,
    translatedText,
    confidence: 1,
    sourceDirection: "horizontal",
    renderDirection: "horizontal",
    fontSizePx: 28,
    lineHeight: 1.3,
    textAlign: "center",
    textColor: "#111111",
    backgroundColor: "#ffffff",
    opacity: 1,
  };
}

function makePage(id: string, blocks: TranslationBlock[]): MangaPage {
  return {
    id,
    name: `${id}.png`,
    imagePath: `C:/qa/${id}.png`,
    dataUrl: IMAGE_DATA_URL,
    width: 1000,
    height: 1600,
    blocks,
    blockOrder: blocks.map((block) => block.id),
    analysisStatus: "completed",
    createdAt: TS,
    updatedAt: TS,
  };
}

const CHAPTER: ChapterSnapshot = {
  id: "chapter-1",
  workId: "work-1",
  title: "1화",
  sourceKind: "images",
  status: "completed",
  pageOrder: ["page-1", "page-2"],
  pages: [
    makePage("page-1", [
      makeBlock("block-1", "하나..."),
      makeBlock("block-2", "둘..."),
    ]),
    makePage("page-2", [makeBlock("block-3", "셋...")]),
  ],
  createdAt: TS,
  updatedAt: TS,
};

const WORKSPACE_PROPS: AppWorkspaceProps = {
  brushColor: "#ffffff",
  wheelZoomSensitivityPercent: 1,
  imageRef: React.createRef<HTMLImageElement | null>(),
  interactionPreviewStore: createWorkspaceInteractionPreviewStore(),
  jobActive: false,
  jobState: {
    id: "",
    kind: "gemma-analysis",
    progressText: "",
    status: "idle",
  },
  lastRetouchTool: "brush",
  maskStrokes: [],
  originalImageOpacity: 0,
  originalImageOpacityAvailable: false,
  onApplyBubbleLayoutDraft: () => undefined,
  onBlockPointerDown: () => undefined,
  onCancelBubbleLayoutDraft: () => undefined,
  onChangeOriginalImageOpacity: () => undefined,
  onChangeWorkspaceFitMode: () => undefined,
  onChangeWorkspaceZoom: () => undefined,
  onOpenBatchImport: () => undefined,
  onOpenSettings: () => undefined,
  onOpenShareImport: () => undefined,
  onOpenTranslationSource: () => undefined,
  onResetWorkspaceZoom: () => undefined,
  onSelectStageTool: () => undefined,
  onStagePointerDown: () => undefined,
  onStagePointerLeave: () => undefined,
  onStagePointerMove: () => undefined,
  onStagePointerUp: () => undefined,
  onToggleRegionTranslation: () => undefined,
  onToggleStageToolbarHidden: () => undefined,
  onUndoBubbleLayoutPoint: () => undefined,
  onZoomInWorkspace: () => undefined,
  onZoomOutWorkspace: () => undefined,
  progressSnapshot: null,
  regionSelectionActive: false,
  regionSelectionRect: null,
  regionTranslationAvailable: true,
  retouchCursor: null,
  retouchOriginalImageDataUrl: "",
  selectedBlockId: null,
  selectedBlockIds: [],
  selectedPage: requiredItem(CHAPTER.pages, 0),
  selectedPageImageDataUrl: IMAGE_DATA_URL,
  selectedPageImagePageId: "page-1",
  showBlockChrome: false,
  showTextBlocks: true,
  showingOriginalPeek: false,
  stageRef: React.createRef<HTMLDivElement | null>(),
  stageSize: { width: 1000, height: 1600 },
  stageTool: "select",
  stageToolbarHidden: false,
  workspaceFitMode: "contain",
  workspacePanelRef: React.createRef<HTMLElement | null>(),
  workspaceZoom: 1,
  workspaceZoomControllerRef: React.createRef(),
};

const FONT_OPTIONS = getBlockFontOptions(DEFAULT_BLOCK_FONT_CATALOG);

const FONTS_CONTEXT: FontsContextValue = {
  baseOptions: getBaseBlockFontOptions(DEFAULT_BLOCK_FONT_CATALOG),
  busy: false,
  catalog: DEFAULT_BLOCK_FONT_CATALOG,
  options: FONT_OPTIONS,
  registerFont: async () => undefined,
  removeFont: async () => undefined,
  savePreferences: async () => undefined,
};

function getTopLevelSectionToggle(label: "대상 조건" | "작업") {
  const toggle = screen
    .getAllByRole<HTMLButtonElement>("button")
    .find(
      (button) =>
        button.getAttribute("aria-expanded") !== null &&
        button.textContent?.startsWith(label),
    );
  if (!toggle) throw new Error(`missing ${label} section toggle`);
  return toggle;
}

function requiredItem<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`missing fixture item ${index}`);
  return item;
}

function readWorkspaceTexts(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(".workspace .overlay-text-content"),
    (element) => element.textContent ?? "",
  );
}
