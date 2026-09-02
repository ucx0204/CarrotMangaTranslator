import { describe, expect, it, vi } from "vitest";
import {
  PageImageExportApplicationService,
  type PageImageExportDestinationPort,
  type PageImageExportExecutionPort,
} from "../src/main/application/pageImageExportService";
import type {
  PageImageExportPreflightResult,
  PageImageExportRequest,
  PagePsdExportRequest,
} from "../src/shared/pageImageExportTypes";

const OUTPUT_DIRECTORY = "D:\\exports";

describe("PageImageExportApplicationService", () => {
  it("removes stale target snapshots before preflight", async () => {
    const harness = createHarness();
    const request: PageImageExportRequest = {
      ...imageRequest(),
      expectedTargets: [
        {
          chapterId: "chapter-1",
          pageId: "page-1",
          revision: "page-v1:stale",
        },
      ],
    };

    await expect(harness.service.preflight(request)).resolves.toEqual(
      preflightResult(),
    );

    expect(harness.execution.preflight).toHaveBeenCalledWith({
      ...request,
      expectedTargets: undefined,
    });
    expect(harness.execution.assertIdle).not.toHaveBeenCalled();
    expect(harness.destinations.pick).not.toHaveBeenCalled();
  });

  it("checks the active job before asking for a destination", async () => {
    const harness = createHarness({ destination: null });

    await expect(
      harness.service.exportImages(imageRequest()),
    ).resolves.toBeNull();

    expect(harness.execution.exportImages).not.toHaveBeenCalled();
    expect(
      harness.execution.assertIdle.mock.invocationCallOrder[0],
    ).toBeLessThan(harness.destinations.pick.mock.invocationCallOrder[0] ?? 0);
  });

  it("remembers the selected parent only after a completed image export", async () => {
    const harness = createHarness({
      imageResult: {
        status: "completed",
        outputDir: `${OUTPUT_DIRECTORY}\\translated`,
        pageCount: 2,
      },
    });
    const request = imageRequest();

    await expect(harness.service.exportImages(request)).resolves.toMatchObject({
      status: "completed",
      pageCount: 2,
    });

    expect(harness.execution.exportImages).toHaveBeenCalledWith(
      request,
      OUTPUT_DIRECTORY,
    );
    expect(harness.destinations.remember).toHaveBeenCalledWith(
      OUTPUT_DIRECTORY,
    );
    expect(
      harness.execution.exportImages.mock.invocationCallOrder[0],
    ).toBeLessThan(
      harness.destinations.remember.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("does not remember a parent after cancellation", async () => {
    const harness = createHarness({ imageResult: { status: "cancelled" } });

    await expect(harness.service.exportImages(imageRequest())).resolves.toEqual(
      {
        status: "cancelled",
      },
    );

    expect(harness.destinations.remember).not.toHaveBeenCalled();
  });

  it("uses the same destination policy for PSD export", async () => {
    const harness = createHarness({
      psdResult: {
        status: "completed",
        outputDir: `${OUTPUT_DIRECTORY}\\psd`,
        pageCount: 1,
      },
    });
    const request = psdRequest();

    await expect(harness.service.exportPsd(request)).resolves.toMatchObject({
      status: "completed",
    });

    expect(harness.execution.exportPsd).toHaveBeenCalledWith(
      request,
      OUTPUT_DIRECTORY,
    );
    expect(harness.destinations.remember).toHaveBeenCalledWith(
      OUTPUT_DIRECTORY,
    );
  });

  it("preserves idle and export failures without recording success", async () => {
    const busyError = new Error("export already running");
    const busy = createHarness({ assertError: busyError });

    await expect(busy.service.exportImages(imageRequest())).rejects.toBe(
      busyError,
    );
    expect(busy.destinations.pick).not.toHaveBeenCalled();

    const exportError = new Error("write failed");
    const failed = createHarness({ imageError: exportError });
    await expect(failed.service.exportImages(imageRequest())).rejects.toBe(
      exportError,
    );
    expect(failed.destinations.remember).not.toHaveBeenCalled();
  });
});

type HarnessOptions = {
  destination?: string | null;
  assertError?: Error;
  imageError?: Error;
  imageResult?: Awaited<
    ReturnType<PageImageExportExecutionPort["exportImages"]>
  >;
  psdResult?: Awaited<ReturnType<PageImageExportExecutionPort["exportPsd"]>>;
};

function createHarness(options: HarnessOptions = {}) {
  const execution = {
    assertIdle: vi.fn(() => {
      if (options.assertError) throw options.assertError;
    }),
    preflight: vi.fn(async () => preflightResult()),
    exportImages: vi.fn(async () => {
      if (options.imageError) throw options.imageError;
      return options.imageResult ?? { status: "cancelled" as const };
    }),
    exportPsd: vi.fn(async () =>
      Promise.resolve(options.psdResult ?? { status: "cancelled" as const }),
    ),
  } satisfies PageImageExportExecutionPort;
  const destinations = {
    pick: vi.fn(async () =>
      Promise.resolve(
        options.destination === undefined
          ? OUTPUT_DIRECTORY
          : options.destination,
      ),
    ),
    remember: vi.fn(),
  } satisfies PageImageExportDestinationPort;
  return {
    execution,
    destinations,
    service: new PageImageExportApplicationService(execution, destinations),
  };
}

function imageRequest(): PageImageExportRequest {
  return {
    workId: "work-1",
    selections: [{ chapterId: "chapter-1", mode: "all" }],
    outputFormat: "png",
  };
}

function psdRequest(): PagePsdExportRequest {
  return {
    workId: "work-1",
    selections: [{ chapterId: "chapter-1", mode: "all" }],
  };
}

function preflightResult(): PageImageExportPreflightResult {
  return {
    workTitle: "Work",
    chapterCount: 1,
    pageCount: 1,
    sampleRelativePath: "Chapter 1\\001.png",
    outputPolicy: "new-timestamped-folder",
    issues: [],
    targets: [],
  };
}
