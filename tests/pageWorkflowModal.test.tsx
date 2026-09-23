// @vitest-environment jsdom
import React from "react";
import {
  cleanup,
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TranslationOptionsModal } from "../src/renderer/src/components/TranslationOptionsModal";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import { resolveDefaultAppSettings } from "../src/main/appSettings";
import { createPageWorkflowPlan } from "../src/shared/pageWorkflowTypes";
import { createEmptyConditionalBatchSnapshot } from "../src/shared/conditionalBatchRules";
import { preflightPageWorkflow } from "../src/shared/pageWorkflowPolicy";
import { makeChapter, makePage } from "./helpers/workspacePointerFixtures";
import type { LibraryIndex } from "../src/shared/libraryTypes";
import type { UiSettings } from "../src/shared/settingsTypes";
import { normalizePageWorkflowUi } from "../src/shared/pageWorkflowSettings";
import { UiSettingsSchema } from "../src/shared/ipcUiSettingsSchema";

const chapter = makeChapter(makePage({ blockPatch: { translatedText: "" } }));
const library: LibraryIndex = {
  workOrder: [chapter.workId],
  works: [
    {
      id: chapter.workId,
      title: "Test",
      chapterOrder: [chapter.id],
      createdAt: chapter.createdAt,
      updatedAt: chapter.updatedAt,
      chapters: [{ ...chapter, pageCount: 1 }],
    },
  ],
};
const auth = vi.fn(async () => ({
  authenticated: false,
  accountKind: null,
  email: null,
  planType: null,
  requiresOpenaiAuth: false,
  appServerVersion: "test",
  models: [],
}));
beforeEach(() => {
  window.mangaApi = createTestMangaGatewayStub({
    getCodexAccount: auth,
    getPageImageDataUrl: async () => "",
    listConditionalBatchSchemes: async () =>
      createEmptyConditionalBatchSnapshot(),
    preflightPageWorkflow: async (request) =>
      preflightPageWorkflow(request, [chapter]),
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function show(
  plan = createPageWorkflowPlan(["detect"]),
  initialUi: UiSettings = {},
  pipeline: "hayai" | "paddle-legacy" = "hayai",
) {
  const onStart = vi.fn<
    (
      request: import("../src/shared/pageWorkflowTypes").PageWorkflowRequest,
    ) => Promise<void>
  >(async () => {});
  const onPersist = vi.fn();
  const onLegacyStart = vi.fn();
  const settings = resolveDefaultAppSettings({});
  settings.ocr.pipeline = pipeline;
  function Fixture() {
    const [ui, setUi] = React.useState<UiSettings>({
      pageWorkflowDefault: plan,
      ...initialUi,
    });
    return (
      <TranslationOptionsModal
        chapter={chapter}
        library={library}
        settings={settings}
        uiSettings={ui}
        onStart={onLegacyStart}
        onStartPageWorkflow={onStart}
        onPersistDefaults={(patch) => {
          onPersist(patch);
          setUi((current) => ({ ...current, ...patch }));
        }}
        onClose={() => {}}
      />
    );
  }
  render(<Fixture />);
  return { onStart, onPersist, onLegacyStart };
}

describe("Hayai page work modal", () => {
  it("switches Hayai versions, remembers the choice and animates from the measured width", async () => {
    const f = show();
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "작업 시작" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("radio", { name: "새 버전" }));
    expect(f.onPersist).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog");
    vi.spyOn(dialog, "getBoundingClientRect").mockReturnValue({
      width: 1440,
    } as DOMRect);
    fireEvent.click(screen.getByRole("radio", { name: "기존 버전" }));
    expect(f.onPersist).toHaveBeenLastCalledWith({
      hayaiTranslationUi: "classic",
    });
    expect(screen.queryByRole("button", { name: "작업 시작" })).toBeNull();
    const classic = screen.getByRole("dialog");
    expect(classic.style.getPropertyValue("--modal-resize-from")).toBe(
      "1440px",
    );
    expect(classic.style.getPropertyValue("--modal-resize-to")).toBe(
      "min(880px, 100%)",
    );
    expect(document.activeElement).toBe(
      screen.getByRole("radio", { name: "기존 버전" }),
    );
    vi.spyOn(classic, "getBoundingClientRect").mockReturnValue({
      width: 1010,
    } as DOMRect);
    fireEvent.click(screen.getByRole("radio", { name: "새 버전" }));
    expect(
      screen.getByRole("dialog").style.getPropertyValue("--modal-resize-from"),
    ).toBe("1010px");
    expect(f.onPersist).toHaveBeenLastCalledWith({
      hayaiTranslationUi: "workflow",
    });
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "작업 시작" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "작업 시작" }));
    expect(f.onStart).toHaveBeenCalledOnce();
    expect(f.onLegacyStart).not.toHaveBeenCalled();
  });

  it("restores classic mode and runs its existing translation action", async () => {
    const f = show(undefined, { hayaiTranslationUi: "classic" });
    expect(
      screen
        .getByRole("radio", { name: "기존 버전" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    const start = await screen.findByRole("button", { name: "선택 범위 번역" });
    fireEvent.click(start);
    fireEvent.click(
      screen.getByRole("button", { name: "선택 범위 다시 번역" }),
    );
    expect(f.onLegacyStart).toHaveBeenCalledOnce();
    expect(f.onStart).not.toHaveBeenCalled();
  });

  it("keeps Paddle on its original UI regardless of the Hayai preference", () => {
    show(undefined, { hayaiTranslationUi: "workflow" }, "paddle-legacy");
    expect(
      screen.queryByRole("radiogroup", { name: "Hayai 작업 화면" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "작업 시작" })).toBeNull();
    expect(screen.getByRole("button", { name: "선택 범위 번역" })).toBeTruthy();
  });

  it("validates and normalizes the saved Hayai version", () => {
    for (const hayaiTranslationUi of ["classic", "workflow"] as const) {
      expect(UiSettingsSchema.parse({ hayaiTranslationUi })).toEqual({
        hayaiTranslationUi,
      });
      expect(
        normalizePageWorkflowUi({ hayaiTranslationUi }).hayaiTranslationUi,
      ).toBe(hayaiTranslationUi);
    }
    expect(
      UiSettingsSchema.safeParse({ hayaiTranslationUi: "invalid" }).success,
    ).toBe(false);
    expect(
      normalizePageWorkflowUi({ hayaiTranslationUi: "invalid" })
        .hayaiTranslationUi,
    ).toBe("workflow");
  });

  it("revalidates page selection and saves defaults only when requested", async () => {
    const f = show();
    const expand = screen.getByRole("button", { name: "변경" });
    fireEvent.click(expand);
    expect(expand.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(expand);
    expect(expand.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "전체 해제" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "대상 페이지를 선택하세요.",
    );
    const start = screen.getByRole("button", { name: "작업 시작" });
    expect(start.hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "전체 선택" }));
    fireEvent.click(
      screen.getByRole("checkbox", { name: "기본 구성으로 저장" }),
    );
    await waitFor(() => expect(start.hasAttribute("disabled")).toBe(false));
    fireEvent.click(start);
    expect(f.onPersist.mock.lastCall?.[0].pageWorkflowDefault.stages).toEqual([
      "detect",
    ]);
    expect(f.onStart.mock.lastCall?.[0].selection[0].pageIds).toEqual(
      chapter.pages.map((p) => p.id),
    );
  });
  it("edits a saved preset in place and saves a separate copy on request", async () => {
    const f = show(createPageWorkflowPlan(["detect"]), {
      pageWorkflowPresets: [
        {
          id: "saved",
          name: "내 준비",
          plan: createPageWorkflowPlan(["detect", "ocr"]),
        },
      ],
      pageWorkflowFavoritePresetIds: ["saved"],
    });
    const select = screen.getByRole("combobox", { name: "작업 프리셋" });
    fireEvent.click(select);
    fireEvent.click(await screen.findByRole("option", { name: "내 준비" }));
    fireEvent.click(
      screen.getByRole("checkbox", { name: "2. 원문 읽기 · OCR" }),
    );
    expect(select.textContent).toContain("내 준비 •");
    const save = screen.getByRole("button", { name: "변경 저장" });
    await waitFor(() => expect(save.hasAttribute("disabled")).toBe(false));
    fireEvent.click(save);
    expect(f.onPersist.mock.lastCall?.[0].pageWorkflowPresets).toHaveLength(1);
    expect(f.onPersist.mock.lastCall?.[0].pageWorkflowPresets[0]).toMatchObject(
      { id: "saved", name: "내 준비", plan: { stages: ["detect"] } },
    );
    expect(select.textContent).toContain("내 준비");
    expect(select.textContent).not.toContain("•");
    expect(save.hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "새로 저장" }));
    fireEvent.change(
      screen.getByRole("textbox", { name: "사용자 프리셋 이름" }),
      { target: { value: "복사본" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    expect(f.onPersist.mock.lastCall?.[0].pageWorkflowPresets).toHaveLength(2);
    expect(select.textContent).toContain("복사본");
  });
  it("favorites and deletes saved presets without applying their plans", async () => {
    const f = show(createPageWorkflowPlan(["detect"]), {
      pageWorkflowPresets: [
        {
          id: "saved",
          name: "내 준비",
          plan: createPageWorkflowPlan(["detect", "ocr"]),
        },
      ],
    });
    const select = screen.getByRole("combobox", { name: "작업 프리셋" });
    fireEvent.click(select);
    fireEvent.click(
      await screen.findByRole("button", { name: "내 준비 즐겨찾기 추가" }),
    );
    expect(f.onPersist.mock.lastCall?.[0]).toEqual({
      pageWorkflowFavoritePresetIds: ["saved"],
    });
    expect(
      screen
        .getByRole("button", { name: "내 준비 즐겨찾기 해제" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      (
        screen.getByRole("checkbox", {
          name: "2. 원문 읽기 · OCR",
        }) as HTMLInputElement
      ).checked,
    ).toBe(false);
    fireEvent.click(
      screen.getByRole("button", { name: "내 준비 즐겨찾기 해제" }),
    );
    expect(f.onPersist.mock.lastCall?.[0]).toEqual({
      pageWorkflowFavoritePresetIds: [],
    });
    fireEvent.click(screen.getByRole("button", { name: "내 준비 삭제" }));
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "프리셋 삭제" })).getByRole(
        "button",
        { name: "취소" },
      ),
    );
    expect(screen.getByRole("button", { name: "내 준비 삭제" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "내 준비 삭제" }));
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "프리셋 삭제" })).getByRole(
        "button",
        { name: "삭제" },
      ),
    );
    expect(f.onPersist.mock.lastCall?.[0]).toEqual({
      pageWorkflowPresets: [],
      pageWorkflowFavoritePresetIds: [],
    });
    expect(screen.queryByRole("button", { name: "내 준비 삭제" })).toBeNull();
    await screen.findByText("1페이지 · 1개 작업");
  });
  it("persists favorite IDs through IPC validation and settings normalization", () => {
    const patch = UiSettingsSchema.parse({
      pageWorkflowFavoritePresetIds: ["full", "saved", "saved"],
    });
    expect(
      normalizePageWorkflowUi(patch ?? {}).pageWorkflowFavoritePresetIds,
    ).toEqual(["full", "saved"]);
  });
  it("dismisses the setting tooltip while the dropdown is open", async () => {
    show(createPageWorkflowPlan(["translate"]));
    fireEvent.click(screen.getByRole("button", { name: "번역 설정" }));
    const detail = screen.getByRole("combobox", { name: "누적 기억 상세도" });
    fireEvent.focus(detail);
    expect(screen.getByRole("tooltip").textContent).toContain("번역 기억의 양");
    fireEvent.click(detail);
    expect(await screen.findByRole("option", { name: "상세" })).toBeTruthy();
    expect(screen.queryByRole("tooltip")).toBeNull();
    const anchor = detail.closest("[data-control-tooltip]");
    if (!anchor) throw new Error("Missing tooltip anchor");
    fireEvent.pointerEnter(anchor);
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.keyDown(detail, { key: "Escape" });
    fireEvent.focus(detail);
    fireEvent.keyDown(detail, { key: "ArrowDown" });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
  it("keeps the rendered summary during validation while disabling stale execution", async () => {
    const f = show();
    const start = screen.getByRole("button", { name: "작업 시작" });
    await waitFor(() => expect(start.hasAttribute("disabled")).toBe(false));
    const summary = screen.getByText("1페이지 · 1개 작업");
    let finish!: () => void;
    window.mangaApi = createTestMangaGatewayStub({
      preflightPageWorkflow: async (request) => {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return preflightPageWorkflow(request, [chapter]);
      },
      getPageImageDataUrl: async () => "",
    });
    fireEvent.click(
      screen.getByRole("checkbox", { name: "2. 원문 읽기 · OCR" }),
    );
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    expect(summary.textContent).toBe("1페이지 · 2개 작업");
    expect(start.hasAttribute("disabled")).toBe(true);
    fireEvent.click(start);
    expect(f.onStart).not.toHaveBeenCalled();
    await act(async () => {
      finish();
    });
    await waitFor(() => expect(start.hasAttribute("disabled")).toBe(false));
    expect(summary.textContent).toBe("1페이지 · 2개 작업");
  });
  it("provides each stage description on keyboard focus", async () => {
    show();
    const checkbox = screen.getByRole("checkbox", { name: "4. 번역" });
    fireEvent.focus(checkbox);
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip.textContent).toContain(
      "저장된 원문으로 빈 번역문을 채웁니다.",
    );
    expect(checkbox.getAttribute("aria-describedby")).toBe(tooltip.id);
    fireEvent.blur(checkbox);
    expect(screen.queryByRole("tooltip")).toBeNull();
    await screen.findByText("1페이지 · 1개 작업");
    fireEvent.click(screen.getByRole("checkbox", { name: "6. 자동 서식" }));
    fireEvent.click(screen.getByRole("button", { name: "자동 서식 설정" }));
    const font = screen.getByRole("checkbox", { name: "폰트 맞춤" });
    fireEvent.focus(font);
    expect(screen.getByRole("tooltip").textContent).toContain(
      "원문과 어울리는 글꼴",
    );
    fireEvent.blur(font);
    const size = screen.getByRole("checkbox", {
      name: "원문에 글자 크기 맞춤",
    });
    fireEvent.focus(size);
    expect(screen.getByRole("tooltip").textContent).toContain(
      "원문 글자 크기에 맞춥니다.",
    );
    expect(size.getAttribute("aria-describedby")).toBe(
      screen.getByRole("tooltip").id,
    );
    fireEvent.blur(size);
  });
  it("starts detection without reading translation authentication", async () => {
    const f = show();
    const button = screen.getByRole("button", { name: "작업 시작" });
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
    fireEvent.click(button);
    expect(f.onStart.mock.calls[0][0].plan.stages).toEqual(["detect"]);
    expect(auth).not.toHaveBeenCalled();
  });
  it("switches to manual preparation and stores presets without page selection", async () => {
    const f = show();
    fireEvent.click(screen.getByRole("combobox", { name: "작업 프리셋" }));
    fireEvent.click(await screen.findByRole("option", { name: "손번역 준비" }));
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "작업 시작" })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
    expect(
      screen.getByRole("combobox", { name: "작업 프리셋" }).textContent,
    ).toContain("손번역 준비");
    fireEvent.click(screen.getByRole("button", { name: "프리셋 저장" }));
    fireEvent.change(
      screen.getByRole("textbox", { name: "사용자 프리셋 이름" }),
      { target: { value: "준비" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    expect(
      f.onPersist.mock.calls[0][0].pageWorkflowPresets[0].plan.stages,
    ).toEqual(["detect", "ocr", "erase"]);
    expect(
      f.onPersist.mock.calls[0][0].pageWorkflowPresets[0].selection,
    ).toBeUndefined();
    expect(auth).not.toHaveBeenCalled();
  });
  it("shows a concise missing-rule error and blocks execution", async () => {
    show();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "3. 원문 일괄 편집" }),
    );
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "원문 일괄 편집 규칙을 선택하세요.",
    );
    expect(
      screen
        .getByRole("button", { name: "작업 시작" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });
  it("keeps stage choices while opening settings and submits their edited values", async () => {
    const f = show(
      createPageWorkflowPlan([
        "detect",
        "ocr",
        "translate",
        "typography",
        "erase",
        "layout",
        "review",
      ]),
    );
    expect(screen.queryByRole("checkbox", { name: "폰트 맞춤" })).toBeNull();
    const translation = screen.getByRole("button", { name: "번역 설정" });
    fireEvent.click(translation);
    expect(translation.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(screen.getByRole("checkbox", { name: "누적 번역" }));
    expect(
      screen.queryByRole("combobox", { name: "누적 기억 상세도" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "누적 번역" }));
    fireEvent.click(screen.getByRole("combobox", { name: "누적 기억 상세도" }));
    fireEvent.click(await screen.findByRole("option", { name: "핵심" }));
    fireEvent.click(screen.getByRole("button", { name: "자동 서식 설정" }));
    expect(translation.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("checkbox", { name: "누적 번역" })).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "폰트 맞춤" }));
    fireEvent.click(
      screen.getByRole("button", { name: "말풍선·줄 배치 설정" }),
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: "자연스러운 줄바꿈" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "원문 제거 설정" }));
    fireEvent.click(screen.getByRole("combobox", { name: "원문 제거 엔진" }));
    fireEvent.click(await screen.findByRole("option", { name: "Codex" }));
    fireEvent.click(screen.getByRole("button", { name: "처리 내역" }));
    expect(screen.getByRole("table")).toBeTruthy();
    const start = screen.getByRole("button", { name: "작업 시작" });
    await waitFor(() => expect(start.hasAttribute("disabled")).toBe(false));
    fireEvent.click(start);
    expect(f.onStart.mock.calls[0][0].plan).toMatchObject({
      stages: [
        "detect",
        "ocr",
        "translate",
        "typography",
        "erase",
        "layout",
        "review",
      ],
      cumulative: true,
      cumulativeDetail: "essential",
      autoFont: false,
      naturalLayout: true,
      erasureEngine: "codex",
    });
  });
  it("requires acknowledgement when overwrite is chosen inside a stage", async () => {
    const f = show();
    fireEvent.click(screen.getByRole("button", { name: "블록 검출 설정" }));
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "기존 블록 교체 (원문·번역·수동 서식 삭제)",
      }),
    );
    expect(
      screen.getByRole("button", { name: "블록 검출 설정" }).textContent,
    ).toContain("덮어쓰기");
    const start = screen.getByRole("button", { name: "작업 시작" });
    expect(start.hasAttribute("disabled")).toBe(true);
    fireEvent.click(
      screen.getByRole("checkbox", { name: "기존 값 변경 확인: 블록 검출" }),
    );
    await waitFor(() => expect(start.hasAttribute("disabled")).toBe(false));
    fireEvent.click(start);
    expect(f.onStart.mock.calls[0][0].plan.overwrite).toEqual(["detect"]);
  });
  it("requires explicit overwrite acknowledgement and clears it when changing stages", async () => {
    show({ ...createPageWorkflowPlan(["detect"]), overwrite: ["detect"] });
    const start = screen.getByRole("button", { name: "작업 시작" });
    await screen.findByRole("checkbox", {
      name: "기존 값 변경 확인: 블록 검출",
    });
    expect(start.hasAttribute("disabled")).toBe(true);
    fireEvent.click(
      screen.getByRole("checkbox", { name: "기존 값 변경 확인: 블록 검출" }),
    );
    await waitFor(() => expect(start.hasAttribute("disabled")).toBe(false));
    fireEvent.click(
      screen.getByRole("checkbox", { name: "2. 원문 읽기 · OCR" }),
    );
    expect(start.hasAttribute("disabled")).toBe(true);
  });
});
