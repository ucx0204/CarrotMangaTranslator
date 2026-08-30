/** @vitest-environment jsdom */

import React from "react";
import type { TFunction } from "i18next";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JobProgressReadout } from "../src/renderer/src/components/JobProgressReadout";
import { StatusOperationActivityFeedback } from "../src/renderer/src/components/StatusOperationActivityFeedback";
import { Modal } from "../src/renderer/src/components/ui/Modal";
import {
  WebImportCandidateGrid,
  WebImportResultNotice,
  WebImportToolbar,
} from "../src/renderer/src/components/webImport/WebImportResults";
import {
  formatAppOperationActivity,
  isAppOperationActive,
} from "../src/renderer/src/lib/appOperationPresentation";
import type { AppOperationActivityEvent } from "../src/shared/appOperationTypes";
import type { JobState } from "../src/shared/jobTypes";
import type {
  WebImportCandidate,
  WebImportScanResult,
} from "../src/shared/webImportTypes";

afterEach(cleanup);

describe("background progress presentation", () => {
  it("uses raw counters, snapshots, and log-only labels consistently", () => {
    const view = render(
      <JobProgressReadout
        jobState={job({
          detail: "  모델 파일 확인 중  ",
          progressCurrent: 3,
          progressTotal: 10,
        })}
        progressSnapshot={null}
        showEta={false}
        stats={<span>12 MB / 40 MB</span>}
      />,
    );

    expect(screen.getByText("3 / 10")).not.toBeNull();
    expect(screen.getByText("모델 파일 확인 중")).not.toBeNull();
    expect(screen.getByText("12 MB / 40 MB")).not.toBeNull();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
      "3",
    );

    view.rerender(
      <JobProgressReadout
        jobState={job({
          detail: "hidden detail",
          progressCurrent: Number.NaN,
          progressTotal: 0,
        })}
        progressSnapshot={{ mode: "log-only" }}
        indeterminateLabel="설치 로그 확인 중"
        showDetail={false}
        showEta={false}
      />,
    );
    expect(screen.getByText("설치 로그 확인 중")).not.toBeNull();
    expect(screen.queryByText("hidden detail")).toBeNull();
    expect(screen.getByRole("progressbar").hasAttribute("aria-valuenow")).toBe(
      false,
    );

    view.rerender(
      <JobProgressReadout
        jobState={job({
          progressText: "4 / 8 페이지 글자·폰트 맞춤 중",
        })}
        progressSnapshot={{
          mode: "determinate",
          current: 4,
          total: 8,
          ratio: 0.5,
        }}
      />,
    );
    expect(screen.getByText("4 / 8")).not.toBeNull();
    expect(screen.getByText("페이지 글자·폰트 맞춤 중")).not.toBeNull();
    expect(screen.queryByText("4 / 8 페이지 글자·폰트 맞춤 중")).toBeNull();
  });

  it("formats byte, percent, item, waiting, and cancelling operations", () => {
    const onCancel = vi.fn();
    const view = render(
      <StatusOperationActivityFeedback
        activity={operation({
          progressCurrent: 1_024,
          progressTotal: 2_048,
          progressUnit: "bytes",
          waitingForUser: true,
        })}
        onCancel={onCancel}
      />,
    );
    expect(screen.getByText(/1.*KB.*2.*KB/)).not.toBeNull();
    expect(
      screen.getByText("브라우저에서 사용자 작업을 기다리는 중"),
    ).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "현재 작업 취소" }));
    expect(onCancel).toHaveBeenCalledOnce();

    view.rerender(
      <StatusOperationActivityFeedback
        activity={operation({
          status: "cancelling",
          progressCurrent: 1,
          progressTotal: 4,
          progressUnit: "percent",
        })}
        onCancel={onCancel}
      />,
    );
    expect(screen.getByText("25%")).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "취소 요청 중…" }),
    ).toHaveProperty("disabled", true);
    expect(screen.queryByText("작업 센터에서 실행 중")).toBeNull();

    view.rerender(
      <StatusOperationActivityFeedback
        activity={operation({
          progressCurrent: -2,
          progressTotal: 3,
          progressUnit: "items",
          cancellable: false,
        })}
      />,
    );
    expect(screen.getByText("0 / 3")).not.toBeNull();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
      "0",
    );

    view.rerender(
      <StatusOperationActivityFeedback
        activity={operation({ progressCurrent: 1, progressTotal: 0 })}
      />,
    );
    expect(screen.getByText("진행 중")).not.toBeNull();

    view.rerender(
      <StatusOperationActivityFeedback
        activity={operation({ status: "completed", cancellable: false })}
      />,
    );
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("labels every managed operation kind and active state", () => {
    const translate = vi.fn((key: string) => key);
    const t = asRendererT(translate);
    const cases: Array<
      [
        AppOperationActivityEvent["kind"],
        string,
        Partial<AppOperationActivityEvent>?,
      ]
    > = [
      [
        "library-import-preview",
        "statusDock.operation.kind.importPreview",
        { sourceKind: "pdf" },
      ],
      [
        "library-import-preview",
        "statusDock.operation.kind.importPreview",
        { sourceKind: undefined },
      ],
      ["library-import", "statusDock.operation.kind.libraryImport"],
      ["web-import-preview", "statusDock.operation.kind.webScan"],
      [
        "web-import-preview",
        "statusDock.operation.kind.webPrepare",
        { phase: "web-preparing" },
      ],
      ["work-share-import", "statusDock.operation.kind.shareImport"],
      ["work-share-export", "statusDock.operation.kind.shareExport"],
      ["model-test", "statusDock.operation.kind.modelTest"],
      ["codex-auth", "statusDock.operation.kind.codexAuth"],
    ];

    for (const [kind, expectedKey, overrides] of cases) {
      translate.mockClear();
      formatAppOperationActivity(operation({ kind, ...overrides }), t);
      expect(
        translate.mock.calls.some(([calledKey]) => calledKey === expectedKey),
      ).toBe(true);
    }
    translate.mockClear();
    formatAppOperationActivity(
      operation({ status: "completed", phase: undefined }),
      t,
    );
    expect(translate).toHaveBeenCalledWith(
      "statusDock.operation.status.completed",
    );
    expect(isAppOperationActive(operation())).toBe(true);
    expect(isAppOperationActive(operation({ status: "cancelling" }))).toBe(
      true,
    );
    expect(isAppOperationActive(operation({ status: "failed" }))).toBe(false);
    expect(isAppOperationActive(null)).toBe(false);
  });
});

describe("web import result controls", () => {
  it("summarizes partial and skipped results without an inline progress view", () => {
    const view = render(<WebImportResultNotice result={webResult()} />);
    expect(screen.queryByRole("status")).toBeNull();

    view.rerender(
      <WebImportResultNotice
        result={webResult({
          skipped: { unsupported: 1, failed: 2, duplicate: 3, blocked: 4 },
        })}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain("10");

    view.rerender(
      <WebImportResultNotice
        result={webResult({
          skipped: { unsupported: 0, failed: 0, duplicate: 0, blocked: 0 },
          truncated: true,
        })}
      />,
    );
    expect(screen.getByRole("status")).not.toBeNull();
  });

  it("supports empty results, all image formats, byte units, and bulk selection", () => {
    const onSelectedChange = vi.fn();
    const view = render(
      <WebImportCandidateGrid
        candidates={[]}
        excluded={new Set()}
        disabled={false}
        onSelectedChange={onSelectedChange}
      />,
    );
    expect(screen.getByText("이 크기에 맞는 이미지가 없습니다")).not.toBeNull();

    view.rerender(
      <WebImportCandidateGrid
        candidates={CANDIDATES}
        excluded={new Set([CANDIDATES[1].id])}
        disabled={false}
        onSelectedChange={onSelectedChange}
      />,
    );
    expect(screen.getByText(/WEBP → PNG.*500 B/)).not.toBeNull();
    expect(screen.getByText(/JPG.*2 KB/)).not.toBeNull();
    expect(screen.getByText(/PNG.*2.0 MB/)).not.toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: /2번 이미지/ }));
    expect(onSelectedChange).toHaveBeenCalledWith(CANDIDATES[1].id, true);
  });

  it("keeps filtering and selection actions available only when useful", () => {
    const onFilterChange = vi.fn();
    const onSelectAll = vi.fn();
    const onClearAll = vi.fn();
    const view = render(
      <WebImportToolbar
        busy={false}
        filter="all"
        visibleCount={3}
        onFilterChange={onFilterChange}
        onSelectAll={onSelectAll}
        onClearAll={onClearAll}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: "최대" }));
    fireEvent.click(screen.getByRole("button", { name: "전체 선택" }));
    fireEvent.click(screen.getByRole("button", { name: "전체 해제" }));
    expect(onFilterChange).toHaveBeenCalledWith("large");
    expect(onSelectAll).toHaveBeenCalledOnce();
    expect(onClearAll).toHaveBeenCalledOnce();

    view.rerender(
      <WebImportToolbar
        busy
        filter="large"
        visibleCount={0}
        onFilterChange={onFilterChange}
        onSelectAll={onSelectAll}
        onClearAll={onClearAll}
      />,
    );
    expect(screen.getByRole("button", { name: "전체 선택" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByRole("radio", { name: "전체" })).toHaveProperty(
      "disabled",
      true,
    );
  });
});

describe("modal presentation variants", () => {
  it("supports a titleless named surface and guards disabled close paths", () => {
    const onClose = vi.fn();
    const view = render(
      <Modal
        ariaLabel="백그라운드 결과"
        bodyLayout="bare"
        elevation="blocking"
        fillHeight
        width="420px"
        maxHeight="500px"
        bodyClassName="body-extra"
        cardClassName="card-extra"
        headerExtra={<span>추가</span>}
        footer={<span>하단</span>}
        closeOnBackdrop
        onClose={onClose}
      >
        <button type="button">본문 버튼</button>
      </Modal>,
    );
    const dialog = screen.getByRole("dialog", { name: "백그라운드 결과" });
    expect(within(dialog).getByText("추가")).not.toBeNull();
    expect(within(dialog).getByText("하단")).not.toBeNull();
    fireEvent.mouseDown(dialog.parentElement as HTMLElement);
    expect(onClose).toHaveBeenCalledOnce();

    view.rerender(
      <Modal
        ariaLabel="백그라운드 결과"
        closeDisabled
        closeOnBackdrop
        onClose={onClose}
      >
        내용
      </Modal>,
    );
    fireEvent.mouseDown(
      screen.getByRole("dialog").parentElement as HTMLElement,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();

    view.rerender(
      <Modal ariaLabel="읽기 전용" bodyLayout="fill">
        내용
      </Modal>,
    );
    expect(screen.queryByRole("button", { name: "닫기" })).toBeNull();
  });
});

function asRendererT(value: unknown): TFunction<"renderer"> {
  return value as TFunction<"renderer">;
}

function job(overrides: Partial<JobState> = {}): JobState {
  return {
    id: "job-1",
    kind: "gemma-analysis",
    status: "running",
    progressText: "백그라운드 작업",
    ...overrides,
  };
}

function operation(
  overrides: Partial<AppOperationActivityEvent> = {},
): AppOperationActivityEvent {
  return {
    id: "operation-1",
    kind: "library-import-preview",
    status: "running",
    phase: "import-source-converting",
    mutatesLibrary: false,
    cancellable: true,
    startedAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function webResult(
  overrides: Partial<WebImportScanResult> = {},
): WebImportScanResult {
  return {
    sessionId: "11111111-1111-4111-8111-111111111111",
    pageTitle: "Web chapter",
    sourceHost: "example.com",
    candidates: CANDIDATES,
    skipped: { unsupported: 0, failed: 0, duplicate: 0, blocked: 0 },
    truncated: false,
    ...overrides,
  };
}

const CANDIDATES: WebImportCandidate[] = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    previewUrl: "data:image/png;base64,iVBORw0KGgo=",
    width: 1_000,
    height: 2_000,
    pixelCount: 2_000_000,
    byteSize: 500,
    format: "webp",
    storedExtension: ".png",
    pageIndex: 0,
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    previewUrl: "data:image/jpeg;base64,/9j/",
    width: 900,
    height: 1_800,
    pixelCount: 1_620_000,
    byteSize: 2_048,
    format: "jpeg",
    storedExtension: ".jpg",
    pageIndex: 1,
  },
  {
    id: "33333333-3333-4333-8333-333333333333",
    previewUrl: "data:image/png;base64,iVBORw0KGgo=",
    width: 800,
    height: 1_600,
    pixelCount: 1_280_000,
    byteSize: 2 * 1_024 * 1_024,
    format: "png",
    storedExtension: ".png",
    pageIndex: 2,
  },
];
