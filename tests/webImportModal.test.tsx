/** @vitest-environment jsdom */

import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebImportModal } from "../src/renderer/src/components/WebImportModal";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import type { ImportPreviewSession } from "../src/shared/importTypes";
import type { WebImportScanResult } from "../src/shared/webImportTypes";

afterEach(() => {
  cleanup();
  window.mangaApi = createTestMangaGatewayStub();
});

describe("WebImportModal", () => {
  it("starts as a compact URL form without an empty hero panel", () => {
    render(<WebImportModal onCancel={vi.fn()} onPrepared={vi.fn()} />);

    expect(
      screen.getByRole("textbox", { name: "웹 페이지 링크" }),
    ).not.toBeNull();
    expect(
      screen.queryByText("공개 웹 페이지의 이미지를 가져옵니다"),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "선택한 이미지로 계속" }),
    ).toBeNull();
  });

  it("defaults to largest images selected and preserves a manual exclusion", async () => {
    window.mangaApi = createTestMangaGatewayStub({
      onWebImportProgress: () => () => undefined,
      scanWebImport: vi.fn(async () => ({
        status: "ready" as const,
        result: RESULT,
      })),
      discardWebImportSession: vi.fn(async () => ({ completed: true })),
    });
    render(<WebImportModal onCancel={vi.fn()} onPrepared={vi.fn()} />);
    fireEvent.change(screen.getByRole("textbox", { name: "웹 페이지 링크" }), {
      target: { value: "https://example.com/gallery" },
    });
    fireEvent.click(screen.getByRole("button", { name: "이미지 불러오기" }));

    expect(await screen.findByText("1.png")).not.toBeNull();
    expect(screen.queryByText("2.png")).toBeNull();
    const largest = screen.getByRole("checkbox", { name: /1번 이미지/ });
    expect((largest as HTMLInputElement).checked).toBe(true);
    fireEvent.click(largest);
    fireEvent.click(screen.getByRole("radio", { name: "전체" }));
    expect(
      (screen.getByRole("checkbox", { name: /1번 이미지/ }) as HTMLInputElement)
        .checked,
    ).toBe(false);
    expect(
      (screen.getByRole("checkbox", { name: /2번 이미지/ }) as HTMLInputElement)
        .checked,
    ).toBe(true);
  });

  it("completes a scan when mounted under React StrictMode", async () => {
    window.mangaApi = createTestMangaGatewayStub({
      onWebImportProgress: () => () => undefined,
      scanWebImport: vi.fn(async () => ({
        status: "ready" as const,
        result: RESULT,
      })),
      discardWebImportSession: vi.fn(async () => ({ completed: true })),
    });
    render(
      <React.StrictMode>
        <WebImportModal onCancel={vi.fn()} onPrepared={vi.fn()} />
      </React.StrictMode>,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "웹 페이지 링크" }), {
      target: { value: "https://example.com/gallery" },
    });
    fireEvent.click(screen.getByRole("button", { name: "이미지 불러오기" }));

    expect(await screen.findByText("1.png")).not.toBeNull();
  });

  it("removes the scan modal immediately and restores it when choices are ready", async () => {
    const scan = deferred<{
      status: "ready";
      result: WebImportScanResult;
    }>();
    const onBackgroundStateChange = vi.fn();
    window.mangaApi = createTestMangaGatewayStub({
      onWebImportProgress: () => () => undefined,
      scanWebImport: vi.fn(() => scan.promise),
      discardWebImportSession: vi.fn(async () => ({ completed: true })),
    });
    render(
      <WebImportModal
        onCancel={vi.fn()}
        onBackgroundStateChange={onBackgroundStateChange}
        onPrepared={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "웹 페이지 링크" }), {
      target: { value: "https://example.com/gallery" },
    });
    fireEvent.click(screen.getByRole("button", { name: "이미지 불러오기" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onBackgroundStateChange).toHaveBeenLastCalledWith(true);
    await act(async () => scan.resolve({ status: "ready", result: RESULT }));
    expect(await screen.findByRole("dialog")).not.toBeNull();
    expect(onBackgroundStateChange).toHaveBeenLastCalledWith(false);
  });

  it("keeps the exact image selection when background preparation fails", async () => {
    const prepare = deferred<ImportPreviewSession>();
    window.mangaApi = createTestMangaGatewayStub({
      onWebImportProgress: () => () => undefined,
      scanWebImport: vi.fn(async () => ({
        status: "ready" as const,
        result: RESULT,
      })),
      prepareWebImport: vi.fn(() => prepare.promise),
      discardWebImportSession: vi.fn(async () => ({ completed: true })),
    });
    render(<WebImportModal onCancel={vi.fn()} onPrepared={vi.fn()} />);
    fireEvent.change(screen.getByRole("textbox", { name: "웹 페이지 링크" }), {
      target: { value: "https://example.com/gallery" },
    });
    fireEvent.click(screen.getByRole("button", { name: "이미지 불러오기" }));
    const selected = await screen.findByRole("checkbox", {
      name: /1번 이미지/,
    });
    fireEvent.click(
      screen.getByRole("button", { name: "선택한 이미지로 계속" }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();

    await act(async () => prepare.reject(new Error("prepare failed")));
    await waitFor(() => expect(screen.getByRole("dialog")).not.toBeNull());
    expect(
      (screen.getByRole("checkbox", { name: /1번 이미지/ }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(selected).not.toBeNull();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

const RESULT: WebImportScanResult = {
  sessionId: "11111111-1111-4111-8111-111111111111",
  pageTitle: "Gallery",
  sourceHost: "example.com",
  skipped: { unsupported: 0, failed: 0, duplicate: 0, blocked: 0 },
  truncated: false,
  candidates: [
    {
      id: "22222222-2222-4222-8222-222222222222",
      previewUrl: "data:image/png;base64,iVBORw0KGgo=",
      width: 1_000,
      height: 800,
      pixelCount: 800_000,
      byteSize: 10,
      format: "png",
      storedExtension: ".png",
      pageIndex: 0,
    },
    {
      id: "33333333-3333-4333-8333-333333333333",
      previewUrl: "data:image/png;base64,iVBORw0KGgo=",
      width: 100,
      height: 100,
      pixelCount: 10_000,
      byteSize: 10,
      format: "png",
      storedExtension: ".png",
      pageIndex: 1,
    },
  ],
};
