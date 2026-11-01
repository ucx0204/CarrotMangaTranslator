/** @vitest-environment jsdom */
import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChapterSnapshot } from "../src/shared/libraryTypes";
import { PageEditorModal } from "../src/renderer/src/components/PageEditorModal";
import { usePageEditor } from "../src/renderer/src/components/pageEditor/usePageEditor";
import { DEFAULT_PAGE_RENAME_RULE } from "../src/renderer/src/lib/pageEditorRename";
import { chooseCustomSelectOption } from "./testUtils/customSelect";
import { AppModals } from "../src/renderer/src/components/AppModals";
import { PageListHeader } from "../src/renderer/src/components/pageList/PageListHeader";
import {
  isAppModalSubtreeActive,
  memoWhileInactive,
} from "../src/renderer/src/app/session/sessionRenderBoundaries";

const stamp = "2026-10-01T00:00:00.000Z";
const chapter: ChapterSnapshot = {
  id: "00000000-0000-4000-8000-000000000001",
  workId: "00000000-0000-4000-8000-000000000002",
  title: "1화",
  sourceKind: "images",
  status: "idle",
  createdAt: stamp,
  updatedAt: stamp,
  pageOrder: ["a", "b", "c", "d"],
  pages: ["a", "b", "c", "d"].map((id, i) => ({
    id,
    name: `${i + 1}.png`,
    imagePath: `${i + 1}.png`,
    dataUrl: "data:image/png;base64,AA==",
    width: 20,
    height: 30,
    blocks: [],
    analysisStatus: "idle",
    createdAt: stamp,
    updatedAt: stamp,
  })),
};
afterEach(cleanup);

const SessionModals = memoWhileInactive(AppModals, isAppModalSubtreeActive);

it("opens, closes, and reopens the page editor through the header and inactive app modal boundary", () => {
  const noop = vi.fn();
  function Session() {
    const [open, setOpen] = React.useState(false);
    return (
      <>
        <PageListHeader
          pages={chapter.pages}
          visibleCount={1}
          filter="pending"
          collapsed={false}
          otherPanelCollapsed={false}
          statusMode="translation"
          onFilterChange={noop}
          onOpenTiming={noop}
          onToggleOtherPanel={noop}
          onEditPages={() => setOpen(true)}
        />
        <SessionModals
          pageEditor={
            open
              ? {
                  chapter,
                  workTitle: "작품",
                  onClose: () => setOpen(false),
                  onSave: async () => {},
                  onReload: async () => chapter,
                }
              : null
          }
          library={{ works: [], workOrder: [] }}
          currentWorkId={chapter.workId}
          translationSourceOpen={false}
          webImportOpen={false}
          importPreview={null}
          importBusy={false}
          importDraft={null}
          importFeedback={null}
          shareExportOpen={false}
          shareExportDraft={null}
          shareExportBusy={false}
          shareImportPreview={null}
          shareImportDraft={null}
          shareImportBusy={false}
          renameTarget={null}
          renameBusy={false}
          settingsOpen={false}
          settingsOpenRequest={undefined}
          settings={null}
          settingsBusy={false}
          jobActive={false}
          confirmDialog={null}
          inpaintingGuideOpen={false}
          fontManagerOpen={false}
          onCancelTranslationSource={noop}
          onCancelWebImport={noop}
          onWebImportBackgroundStateChange={noop}
          onPreparedWebImport={noop}
          onSelectTranslationSource={noop}
          onCancelImport={noop}
          onSubmitImport={noop}
          onCancelShareExport={noop}
          onSubmitShareExport={noop}
          onCancelShareImport={noop}
          onSubmitShareImport={noop}
          onCancelRename={noop}
          onSubmitRename={noop}
          onCancelSettings={noop}
          onOpenErrorReport={noop}
          onOpenLogFolder={noop}
          onOpenModelFolder={noop}
          onResetSettings={async () => null}
          onSubmitSettings={noop}
          onResolveConfirm={noop}
          onCloseInpaintingGuide={noop}
          onCloseFontManager={noop}
        />
      </>
    );
  }
  render(<Session />);
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "페이지 편집" }));
  expect(
    screen.getByRole("dialog", { name: "페이지 편집 · 1화" }),
  ).toBeTruthy();
  expect(screen.getAllByRole("textbox", { name: /바꿀 이름/ })).toHaveLength(4);
  fireEvent.click(screen.getByRole("button", { name: "취소" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "페이지 편집" }));
  expect(
    screen.getByRole("dialog", { name: "페이지 편집 · 1화" }),
  ).toBeTruthy();
});

describe("page editor selection and history", () => {
  it("shares range selection and deselection gestures and resets anchors after quick selection", () => {
    const { result } = renderHook(() => usePageEditor(chapter, "작품"));
    act(() => result.current.toggle("a", true));
    act(() => result.current.toggle("c", true));
    expect([...result.current.selected]).toEqual(["a", "b", "c"]);
    act(() => result.current.toggle("c", false));
    act(() => result.current.toggle("a", true));
    expect(result.current.selected.size).toBe(0);
    act(() => result.current.select(new Set(["a"])));
    act(() => result.current.toggle("d", true));
    expect([...result.current.selected]).toEqual(["a", "d"]);
  });
  it("composes naming and ordering with undo/redo without changing stored input", async () => {
    const { result } = renderHook(() => usePageEditor(chapter, "작품"));
    await act(async () =>
      result.current.rename({
        ...DEFAULT_PAGE_RENAME_RULE,
        position: "whole",
        start: 11,
      }),
    );
    expect(result.current.draft.names.a).toBe("011");
    act(() => result.current.move("last", new Set(["a"])));
    expect(result.current.request().pageIds).toEqual(["b", "c", "d", "a"]);
    act(() => result.current.undo());
    expect(result.current.draft.order).toEqual(chapter.pageOrder);
    act(() => result.current.undo());
    expect(result.current.changed).toBe(false);
    act(() => result.current.redo());
    expect(result.current.nameChanges).toBe(4);
    expect(chapter.pages[0].name).toBe("1.png");
  });
});

describe("page editor dialog", () => {
  function mount(onSave = vi.fn().mockResolvedValue(undefined)) {
    const onClose = vi.fn(),
      onReload = vi.fn().mockResolvedValue(chapter);
    render(
      <PageEditorModal
        chapter={chapter}
        workTitle="작품"
        onSave={onSave}
        onClose={onClose}
        onReload={onReload}
      />,
    );
    return { onSave, onClose, onReload };
  }
  it("edits one name, saves an atomic request and closes only after success", async () => {
    const props = mount();
    const input = screen.getByRole("textbox", { name: "바꿀 이름 1" });
    fireEvent.change(input, { target: { value: "표지" } });
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(props.onClose).toHaveBeenCalledOnce());
    expect(props.onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        chapterId: chapter.id,
        pageIds: chapter.pageOrder,
        names: [{ pageId: "a", baseName: "표지" }],
      }),
    );
  });
  it("groups typing into one undo step and supports Ctrl and Shift row clicks", () => {
    mount();
    const input = screen.getByRole("textbox", { name: "바꿀 이름 1" });
    fireEvent.change(input, { target: { value: "표" } });
    fireEvent.change(input, { target: { value: "표지" } });
    fireEvent.blur(input);
    fireEvent.click(screen.getByRole("button", { name: "실행 취소" }));
    expect((input as HTMLInputElement).value).toBe("1");
    fireEvent.click(screen.getByRole("button", { name: "다시 실행" }));
    expect((input as HTMLInputElement).value).toBe("표지");
    fireEvent.click(screen.getAllByRole("row")[1], { ctrlKey: true });
    fireEvent.click(screen.getAllByRole("row")[3], { shiftKey: true });
    expect(
      (screen.getByRole("checkbox", { name: "선택 2" }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(document.activeElement).toBe(
      screen.getByRole("textbox", { name: "바꿀 이름 2" }),
    );
  });
  it("applies a pasted list and keeps draft on save failure", async () => {
    const props = mount(
      vi.fn().mockRejectedValue(new Error("output conflict")),
    );
    fireEvent.click(screen.getByRole("radio", { name: "이름 변경" }));
    await chooseCustomSelectOption("이름 변경 방식", "이름 목록 붙여넣기");
    fireEvent.change(
      screen.getByRole("textbox", { name: "이름 목록 · 한 줄에 하나" }),
      { target: { value: "표지\n본문1\n본문2\n끝" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "미리보기에 적용" }));
    await waitFor(() =>
      expect(
        (
          screen.getByRole("textbox", {
            name: "바꿀 이름 1",
          }) as HTMLInputElement
        ).value,
      ).toBe("표지"),
    );
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    await screen.findByText("output conflict");
    expect(props.onClose).not.toHaveBeenCalled();
    expect(
      (screen.getByRole("textbox", { name: "바꿀 이름 1" }) as HTMLInputElement)
        .value,
    ).toBe("표지");
  });
  it("moves selected pages through the order controls and sorts selected slots", async () => {
    const props = mount();
    fireEvent.click(screen.getByRole("radio", { name: "순서 변경" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "선택 1" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "선택 3" }));
    fireEvent.click(screen.getByRole("button", { name: "맨 뒤" }));
    fireEvent.click(screen.getByRole("radio", { name: "선택한 페이지" }));
    fireEvent.click(screen.getByRole("button", { name: "순서 뒤집기" }));
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() =>
      expect(props.onSave).toHaveBeenCalledWith(
        expect.objectContaining({ pageIds: ["b", "d", "c", "a"] }),
      ),
    );
  });
  it("applies number settings from the real controls to the draft", async () => {
    mount();
    fireEvent.click(screen.getByRole("radio", { name: "이름 변경" }));
    await chooseCustomSelectOption("적용 위치", "이름 전체");
    fireEvent.change(screen.getByRole("spinbutton", { name: "시작 번호" }), {
      target: { value: "7" },
    });
    fireEvent.blur(screen.getByRole("spinbutton", { name: "시작 번호" }));
    fireEvent.click(screen.getByRole("button", { name: "미리보기에 적용" }));
    await waitFor(() =>
      expect(
        (
          screen.getByRole("textbox", {
            name: "바꿀 이름 1",
          }) as HTMLInputElement
        ).value,
      ).toBe("007"),
    );
  });
  it("explains and applies extra name cleanup, then resets hidden options when disabled", async () => {
    mount();
    const input = screen.getByRole("textbox", {
      name: "바꿀 이름 1",
    }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "  표지  " } });
    fireEvent.blur(input);
    fireEvent.click(screen.getByRole("radio", { name: "이름 변경" }));
    const extra = screen.getByRole("checkbox", {
      name: "공백·대소문자·숫자 정리",
    });
    fireEvent.focus(extra);
    expect(screen.getByRole("tooltip").textContent).toContain(
      "숫자 자릿수 맞춤",
    );
    fireEvent.click(extra);
    chooseCustomSelectOption("이름 변경 방식", "공백 정리");
    fireEvent.click(screen.getByRole("button", { name: "미리보기에 적용" }));
    await waitFor(() => expect(input.value).toBe("표지"));
    fireEvent.click(extra);
    expect(
      screen.getByRole("combobox", { name: "이름 변경 방식" }).textContent,
    ).toContain("번호 붙이기");
    fireEvent.click(extra);
    chooseCustomSelectOption("이름 변경 방식", "문자 바꾸기");
    fireEvent.click(screen.getByRole("checkbox", { name: "정규식" }));
    fireEvent.click(extra);
    expect(screen.queryByRole("checkbox", { name: "정규식" })).toBeNull();
    expect(
      screen.getByRole("combobox", { name: "이름 변경 방식" }).textContent,
    ).toContain("문자 바꾸기");
    fireEvent.click(extra);
    expect(
      (screen.getByRole("checkbox", { name: "정규식" }) as HTMLInputElement)
        .checked,
    ).toBe(false);
  });
  it("marks only colliding rows, leaving unrelated and invalid names distinct", () => {
    mount();
    for (const [index, value] of [
      [1, "same"],
      [2, "same"],
      [3, "bad/name"],
      [4, "safe"],
    ] as const)
      fireEvent.change(
        screen.getByRole("textbox", { name: `바꿀 이름 ${index}` }),
        { target: { value } },
      );
    expect(screen.getAllByText("출력 이름이 겹칩니다.")).toHaveLength(2);
    // Each invalid field is described by its own row's message.
    for (const index of [1, 2, 3]) {
      const field = screen.getByRole("textbox", { name: `바꿀 이름 ${index}` });
      const message = document.getElementById(
        field.getAttribute("aria-describedby") ?? "",
      );
      if (index === 3) expect(message?.textContent).toBeTruthy();
      else expect(message?.textContent).toBe("출력 이름이 겹칩니다.");
    }
    expect(
      screen
        .getByRole("textbox", { name: "바꿀 이름 4" })
        .getAttribute("aria-invalid"),
    ).toBe("false");
    expect(
      screen
        .getByRole("textbox", { name: "바꿀 이름 4" })
        .hasAttribute("aria-describedby"),
    ).toBe(false);
  });
  it("prevents invalid names and asks before discarding", () => {
    const props = mount();
    const input = screen.getByRole("textbox", { name: "바꿀 이름 1" });
    fireEvent.change(input, { target: { value: "../x" } });
    fireEvent.blur(input);
    expect(
      (
        screen.getByRole("button", {
          name: "저장",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    expect(screen.getByText("변경 내용을 버릴까요?")).not.toBeNull();
    expect(props.onClose).not.toHaveBeenCalled();
  });
});
