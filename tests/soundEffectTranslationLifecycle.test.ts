import type { BrowserWindow } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ActiveJobStore } from "../src/main/jobs/activeJob";
import {
  startSoundEffectTranslationJob,
  type TranslationJobContext,
} from "../src/main/jobs/translationJobs";
import type { SoundEffectTranslationJobState } from "../src/main/jobs/soundEffectTranslationJobRunner";
import type { StartSoundEffectTranslationRequest } from "../src/shared/analysisTypes";
import type { JobEvent } from "../src/shared/jobTypes";

const runnerMocks = {
  handleError: vi.fn(),
  run: vi.fn(),
};

const runtime = {
  handleSoundEffectTranslationJobError: runnerMocks.handleError,
  runSoundEffectTranslationJob: runnerMocks.run,
};

vi.mock("electron", () => ({
  app: { isPackaged: false },
}));

beforeEach(() => {
  runnerMocks.handleError.mockReset();
  runnerMocks.run.mockReset();
});

describe("sound-effect translation job lifecycle", () => {
  it("rejects a batch while another app job owns the activity gate", async () => {
    const jobs = new ActiveJobStore();
    jobs.start({
      id: "busy-job",
      kind: "gemma-analysis",
      abortController: new AbortController(),
    });

    await expect(
      startSoundEffectTranslationJob(makeContext(jobs, []), REQUEST, runtime),
    ).resolves.toMatchObject({
      status: "failed",
      translatedRegionCount: 0,
      error: expect.any(String),
    });
    expect(runnerMocks.run).not.toHaveBeenCalled();
    jobs.clearIfCurrent("busy-job");
  });

  it("runs the dedicated job, emits through the common channel, and clears it", async () => {
    const jobs = new ActiveJobStore();
    const events: JobEvent[] = [];
    runnerMocks.run.mockImplementation(
      async (input: {
        emit: (event: JobEvent) => void;
        id: string;
        state: SoundEffectTranslationJobState;
      }) => {
        input.emit({
          id: input.id,
          kind: "sound-effect-translation",
          status: "running",
          progressText: "효과음 번역 중",
          phase: "model_requesting",
        });
        input.state.translatedRegionCount = 1;
        return {
          status: "completed" as const,
          createdBlocksByPage: [{ pageId: "page-1", blockIds: ["block-1"] }],
          translatedRegionCount: 1,
          remainingRegionCount: 0,
        };
      },
    );

    await expect(
      startSoundEffectTranslationJob(
        makeContext(jobs, events),
        REQUEST,
        runtime,
      ),
    ).resolves.toMatchObject({ status: "completed", translatedRegionCount: 1 });
    expect(events).toEqual([
      expect.objectContaining({
        kind: "sound-effect-translation",
        status: "running",
        phase: "model_requesting",
      }),
    ]);
    expect(runnerMocks.handleError).not.toHaveBeenCalled();
    expect(jobs.current).toBeNull();
  });

  it("delegates failures with the persisted partial state before cleanup", async () => {
    const jobs = new ActiveJobStore();
    const failure = new Error("model response rejected");
    runnerMocks.run.mockRejectedValue(failure);
    runnerMocks.handleError.mockImplementation(
      async ({
        error,
        state,
      }: {
        error: unknown;
        state: SoundEffectTranslationJobState;
      }) => {
        expect(error).toBe(failure);
        expect(state.createdBlocksByPage).toEqual([]);
        return {
          status: "failed" as const,
          createdBlocksByPage: [],
          translatedRegionCount: 0,
          remainingRegionCount: 1,
          error: "model response rejected",
        };
      },
    );

    await expect(
      startSoundEffectTranslationJob(makeContext(jobs, []), REQUEST, runtime),
    ).resolves.toMatchObject({
      status: "failed",
      remainingRegionCount: 1,
    });
    expect(runnerMocks.handleError).toHaveBeenCalledOnce();
    expect(jobs.current).toBeNull();
  });
});

const REQUEST: StartSoundEffectTranslationRequest = {
  chapterId: "chapter-1",
  targets: [
    {
      pageId: "page-1",
      pageRevision: "page-v1:0000000000000000",
      regionIds: ["FX001"],
    },
  ],
  inpaintAfterTranslation: false,
  autoFontMatching: true,
};

function makeContext(
  jobs: ActiveJobStore,
  events: JobEvent[],
): TranslationJobContext {
  return {
    jobs,
    decodeImage: vi.fn(),
    getMainWindow: () => makeWindow(events),
  };
}

function makeWindow(events: JobEvent[]): BrowserWindow {
  const browserWindow: BrowserWindow = Object.create(null);
  Object.defineProperties(browserWindow, {
    isDestroyed: { value: () => false },
    webContents: {
      value: {
        getURL: () => "http://127.0.0.1:5173/",
        id: 17,
        isDestroyed: () => false,
        send: (_channel: string, event: JobEvent) => {
          events.push(event);
        },
      },
    },
  });
  return browserWindow;
}
