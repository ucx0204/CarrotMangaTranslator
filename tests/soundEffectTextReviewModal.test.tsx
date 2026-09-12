// @vitest-environment jsdom
import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SoundEffectTextReviewModal } from "../src/renderer/src/components/SoundEffectTextReviewModal";
import { SoundEffectTextReviewDialog } from "../src/renderer/src/components/SoundEffectTextReviewDialog";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import type { SoundEffectTextReview } from "../src/shared/soundEffectTextReview";
import type { JobEvent } from "../src/shared/jobTypes";

const sessionId = "11111111-1111-4111-8111-111111111111";
const review: SoundEffectTextReview = {
  sessionId,
  pages: ["one", "two"].map((pageId) => ({
    pageId,
    name: `${pageId}.png`,
    imagePath: `${pageId}.png`,
    width: 800,
    height: 1200,
    review: {
      sessionId,
      regions: [
        {
          id: pageId,
          sourceText: "ゴ",
          translatedText: "고오",
          sourceBbox: { x: 100, y: 200, w: 200, h: 100 },
        },
      ],
    },
  })),
};

beforeEach(() => {
  window.mangaApi = createTestMangaGatewayStub({
    getPageImageDataUrl: async () => "data:image/png;base64,AA==",
  });
});
afterEach(cleanup);

it("blocks Escape while a batch submission is busy", () => {
  const onClose = vi.fn();
  render(
    <SoundEffectTextReviewModal
      review={review}
      busy
      onClose={onClose}
      onConfirm={vi.fn()}
    />,
  );
  fireEvent.keyDown(window, { key: "Escape" });
  expect(onClose).not.toHaveBeenCalled();
});

it("keeps edits across pages and confirms the entire batch together", async () => {
  const onConfirm = vi.fn();
  render(
    <SoundEffectTextReviewModal
      review={review}
      onConfirm={onConfirm}
      onClose={vi.fn()}
    />,
  );
  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: "전체 확정 후 생성",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  fireEvent.change(screen.getByRole("textbox", { name: "번역문 1" }), {
    target: { value: "수정된 첫 효과음" },
  });
  fireEvent.change(screen.getByRole("textbox", { name: "원문 1" }), {
    target: { value: "ゴゴゴ" },
  });
  fireEvent.click(screen.getByRole("button", { name: /two.png/ }));
  fireEvent.change(screen.getByRole("textbox", { name: "번역문 1" }), {
    target: { value: "두 번째 효과음" },
  });
  fireEvent.click(screen.getByRole("button", { name: /one.png/ }));
  expect(
    (screen.getByRole("textbox", { name: "번역문 1" }) as HTMLInputElement)
      .value,
  ).toBe("수정된 첫 효과음");
  expect(
    (screen.getByRole("textbox", { name: "원문 1" }) as HTMLInputElement).value,
  ).toBe("ゴゴゴ");
  expect(onConfirm).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: "전체 확정 후 생성",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "전체 확정 후 생성" }));
  await waitFor(() => expect(onConfirm).toHaveBeenCalledOnce());
  expect(onConfirm.mock.calls[0][0]).toMatchObject([
    {
      pageId: "one",
      translations: [
        { regionId: "one", text: "수정된 첫 효과음", sourceText: "ゴゴゴ" },
      ],
    },
    {
      pageId: "two",
      translations: [{ regionId: "two", text: "두 번째 효과음" }],
    },
  ]);
});

it.each(["button", "escape"])(
  "keeps a failed confirmation editable and cancels the actual job with %s",
  async (method) => {
    let emit: (event: JobEvent) => void = () => {};
    const confirm = vi.fn(async () => {
      throw new Error("확정 실패");
    });
    const cancel = vi.fn(async () => ({ cancelled: true }));
    window.mangaApi = createTestMangaGatewayStub({
      onJobEvent: (listener) => {
        emit = listener;
        return () => {};
      },
      getPageImageDataUrl: async () => "data:image/png;base64,AA==",
      confirmSoundEffectTextReview: confirm,
      cancelJob: cancel,
    });
    render(<SoundEffectTextReviewDialog />);
    act(() =>
      emit({
        id: "job",
        kind: "sound-effect-translation",
        status: "running",
        progressText: "review",
        soundEffectTextReview: review,
      }),
    );
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "전체 확정 후 생성",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "전체 확정 후 생성" }));
    await screen.findByText("확정 실패");
    expect(screen.getByRole("dialog")).toBeTruthy();
    if (method === "escape") fireEvent.keyDown(window, { key: "Escape" });
    else fireEvent.click(screen.getByRole("button", { name: "취소" }));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith({ jobId: "job" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  },
);
