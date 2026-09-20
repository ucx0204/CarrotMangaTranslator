// @vitest-environment jsdom
import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import { useConfirmDialog } from "../src/renderer/src/hooks/useConfirmDialog";
import { useDeleteRenameTargetAction } from "../src/renderer/src/hooks/useDeleteRenameTargetAction";
import { ConfirmModal } from "../src/renderer/src/components/ConfirmModal";

afterEach(cleanup);
const id = "11111111-1111-4111-8111-111111111111";

function Subject({ kind }: { kind: "work" | "chapter" }) {
  const confirm = useConfirmDialog();
  const action = useDeleteRenameTargetAction({
    askConfirm: confirm.askConfirm,
    clearCurrentChapter: vi.fn(),
    currentChapter: null,
    dirty: false,
    pushStatus: vi.fn(),
    renameTarget: { kind, id, title: "테스트 작품" },
    saveNow: vi.fn(),
    setLibrary: vi.fn(),
    setRenameBusy: vi.fn(),
    setRenameTarget: vi.fn(),
  });
  return (
    <>
      <button onClick={() => void action()}>삭제 열기</button>
      {confirm.confirmDialog ? (
        <ConfirmModal
          {...confirm.confirmDialog}
          onConfirm={() => confirm.resolveConfirmDialog(true)}
          onCancel={() => confirm.resolveConfirmDialog(false)}
        />
      ) : null}
    </>
  );
}

it.each(["work", "chapter"] as const)(
  "includes custom output by default and honors deselection for %s",
  async (kind) => {
    const remove = vi.fn(async () => ({ works: [], workOrder: [] }));
    window.mangaApi = createTestMangaGatewayStub({
      deleteWork: remove,
      deleteChapter: remove,
    });
    render(<Subject kind={kind} />);
    fireEvent.click(screen.getByText("삭제 열기"));
    const checkbox = await screen.findByRole("checkbox");
    expect((checkbox as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "삭제" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith(id, true));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByText("삭제 열기"));
    expect(
      ((await screen.findByRole("checkbox")) as HTMLInputElement).checked,
    ).toBe(true);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "삭제" }));
    await waitFor(() => expect(remove).toHaveBeenLastCalledWith(id, false));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByText("삭제 열기"));
    expect(
      ((await screen.findByRole("checkbox")) as HTMLInputElement).checked,
    ).toBe(true);
  },
);

it("cancelling a deletion never invokes the deletion gateway", async () => {
  const remove = vi.fn(async () => ({ works: [], workOrder: [] }));
  window.mangaApi = createTestMangaGatewayStub({ deleteWork: remove });
  render(<Subject kind="work" />);
  fireEvent.click(screen.getByText("삭제 열기"));
  fireEvent.click(await screen.findByRole("button", { name: "취소" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(remove).not.toHaveBeenCalled();
});
