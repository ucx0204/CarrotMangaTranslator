import { describe, expect, it, vi } from "vitest";
import type { TranslationOptions } from "../src/main/appSettings";
import { configureWholePageOutputOptions } from "../src/main/pipeline/wholePageOutputOptions";
import type { FontMatchingOutputDependencies } from "../src/main/pipeline/wholePagePipelinePorts";
import { makeAutomaticFontCandidate } from "./helpers/automaticFontCandidate";

describe("whole-page font matching profile loading", () => {
  it("disables matching for the run after a profile read error", async () => {
    const failure = new Error("corrupt profile");
    const loadCandidates = vi.fn(() => [makeAutomaticFontCandidate()]);
    const loadProfile = vi.fn(async () => {
      throw failure;
    });
    const warn = vi.fn();
    const baseOptions = { targetLanguage: "ko" } as TranslationOptions;

    await configureWholePageOutputOptions({
      autoFontMatching: true,
      chapterId: "chapter-1",
      dependencies: makeDependencies({ loadCandidates, loadProfile, warn }),
      naturalTextLayout: false,
      run: { baseOptions } as Parameters<
        typeof configureWholePageOutputOptions
      >[0]["run"],
      workId: "work-1",
    });

    expect(loadCandidates).not.toHaveBeenCalled();
    expect(baseOptions.autoFontMatching).toBeUndefined();
    expect(baseOptions.fontMatchingProfile).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      "Font Matching V2 work profile could not be loaded",
      failure,
    );
  });

  it("keeps a genuinely absent profile distinct from a load error", async () => {
    const loadCandidates = vi.fn(() => [makeAutomaticFontCandidate()]);
    const loadProfile = vi.fn(async () => null);
    const baseOptions = { targetLanguage: "ko" } as TranslationOptions;

    await configureWholePageOutputOptions({
      autoFontMatching: true,
      chapterId: "chapter-1",
      dependencies: makeDependencies({ loadCandidates, loadProfile }),
      naturalTextLayout: false,
      run: { baseOptions } as Parameters<
        typeof configureWholePageOutputOptions
      >[0]["run"],
      workId: "work-1",
    });

    expect(loadCandidates).toHaveBeenCalledOnce();
    expect(baseOptions.autoFontMatching).toBe(true);
    expect(baseOptions.fontMatchingProfile).toBeNull();
  });
});

function makeDependencies({
  loadCandidates,
  loadProfile,
  warn = vi.fn<FontMatchingOutputDependencies["diagnostics"]["warn"]>(),
}: {
  loadCandidates: () => ReturnType<typeof makeAutomaticFontCandidate>[];
  loadProfile: () => Promise<null>;
  warn?: FontMatchingOutputDependencies["diagnostics"]["warn"];
}): FontMatchingOutputDependencies {
  return {
    fontMatching: { loadCandidates, loadProfile },
    diagnostics: { info: vi.fn(), warn, error: vi.fn() },
  };
}
