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

  it("surfaces an incident that arrived while a report was already open", () => {
    expect(
      openErrorReport({ source: "renderer-global", message: "first" }),
    ).toBe(true);
    // Returns false because it is not shown yet, but it must not be dropped:
    // a crash raised while a report is open is exactly what the user is chasing.
    expect(openErrorReport({ source: "main-process", message: "second" })).toBe(
      false,
    );

    closeErrorReport();
    expect(getErrorReportIncident()).toMatchObject({
      source: "main-process",
      message: "second",
    });

    closeErrorReport();
    expect(getErrorReportIncident()).toBeNull();
  });

  it("bounds the queue and ignores incidents already waiting", () => {
    expect(
      openErrorReport({ source: "renderer-global", message: "open" }),
    ).toBe(true);
    for (let index = 0; index < 8; index += 1) {
      openErrorReport({ source: "main-process", message: `queued ${index}` });
    }
    openErrorReport({ source: "main-process", message: "queued 0" });

    const drained: (string | undefined)[] = [];
    for (let index = 0; index < 6; index += 1) {
      closeErrorReport();
      drained.push(getErrorReportIncident()?.message);
    }
    expect(drained).toEqual([
      "queued 0",
      "queued 1",
      "queued 2",
      "queued 3",
      undefined,
      undefined,
    ]);
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

  it("bounds recent automatic incident fingerprints during an error storm", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    for (let index = 0; index < 129; index += 1) {
      expect(
        openErrorReport({
          source: "renderer-global",
          message: `failure ${index}`,
        }),
      ).toBe(true);
      closeErrorReport();
    }

    expect(
      openErrorReport({
        source: "renderer-global",
        message: "failure 0",
      }),
    ).toBe(true);
  });
});
