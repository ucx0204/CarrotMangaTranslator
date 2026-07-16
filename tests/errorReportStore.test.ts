/** @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeErrorReport,
  getErrorReportIncident,
  openErrorReport,
  resetErrorReportStoreForTests,
} from "../src/renderer/src/lib/errorReportStore";

describe("error report incident store", () => {
  afterEach(() => {
    resetErrorReportStoreForTests();
    vi.useRealTimers();
  });

  it("keeps one active incident and normalizes oversized renderer details", () => {
    expect(
      openErrorReport({
        source: "renderer-global",
        message: "m".repeat(5_000),
        stack: "s".repeat(17_000),
      }),
    ).toBe(true);
    expect(
      openErrorReport({
        source: "main-process",
        message: "second",
      }),
    ).toBe(false);

    expect(getErrorReportIncident()).toMatchObject({
      source: "renderer-global",
      message: `${"m".repeat(4_000)}…`,
      stack: `${"s".repeat(16_000)}…`,
    });
  });

  it("deduplicates automatic incidents for 30 seconds", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const context = {
      source: "renderer-global" as const,
      message: "same failure",
      stack: "Error: same failure\n at app.ts:1",
    };

    expect(openErrorReport(context)).toBe(true);
    closeErrorReport();
    expect(openErrorReport(context)).toBe(false);

    vi.advanceTimersByTime(30_000);
    expect(openErrorReport(context)).toBe(true);
  });

  it("allows explicit manual or toast actions to reopen a report", () => {
    const context = {
      source: "job-failure" as const,
      message: "job failed",
    };
    expect(openErrorReport(context)).toBe(true);
    closeErrorReport();
    expect(openErrorReport(context, { force: true })).toBe(true);
  });
});
