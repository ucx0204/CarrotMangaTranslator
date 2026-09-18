import { readFile, writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { selectionAppFixture } from "./mcpSelectionApp.fixture";

it("translates only requested saved source strings using task-local languages and actual native context", async () => {
  const f = await selectionAppFixture();
  const before = await readFile(f.chapterPath),
    settings = structuredClone(f.settings);
  try {
    const { job } = await f.run("carrot_run_selection_translation", {
      ...(await f.translationInput()),
      sourceLanguage: "en",
      targetLanguage: "ko",
      contextMode: "none",
    });
    expect(job.status).toBe("completed");
    const result = await f.get(job.jobId);
    expect(result.items).toHaveLength(2);
    expect(f.request).toHaveBeenCalledTimes(2);
    expect(f.dispose).toHaveBeenCalledTimes(2);
    for (const [call] of f.request.mock.calls) {
      expect(call.options).toMatchObject({
        sourceLanguage: "en",
        targetLanguage: "ko",
        imagePath: "",
        textOnlyModel: true,
        skipOcrBboxHints: true,
        autoFontMatching: false,
        collectPageContext: false,
        apiKeyMaxAttempts: 1,
      });
      expect(JSON.parse(call.userPrompt).blockId).toBe("a");
    }
    expect(
      result.items.every((item) => item.translation?.requestCount === 1),
    ).toBe(true);
    expect(f.collect).not.toHaveBeenCalled();
    expect(await readFile(f.chapterPath)).toEqual(before);
    expect(f.settings).toEqual(settings);
    expect(JSON.stringify(result)).not.toMatch(
      /fixture-key|apiBaseUrl|imagePath/,
    );
  } finally {
    await f.close();
  }
});

it("preserves existing translations by default without inventing a manual-translation flag", async () => {
  const f = await selectionAppFixture();
  try {
    const { job } = await f.run("carrot_run_selection_translation", {
      ...(await f.translationInput()),
      preserveExistingTranslations: true,
    });
    expect(job.status).toBe("completed");
    expect(job.result?.performed).toEqual([]);
    expect(
      (await f.get(job.jobId)).items.every(
        (item) => item.excludedReason === "existing_translation_preserved",
      ),
    ).toBe(true);
    expect(f.start).not.toHaveBeenCalled();
    expect(f.request).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it("rejects engine mismatch and missing external permission without fallback", async () => {
  const f = await selectionAppFixture();
  try {
    for (const change of [
      { expectedEngine: "gemma" },
      { allowExternal: false },
    ]) {
      const { job } = await f.run("carrot_run_selection_translation", {
        ...(await f.translationInput()),
        ...change,
      });
      expect(job.status).toBe("failed");
    }
    expect(f.start).not.toHaveBeenCalled();
    expect(f.collect).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it("rejects a missing late block before charging for any earlier target", async () => {
  const f = await selectionAppFixture();
  try {
    const input = await f.translationInput();
    input.pages[1].blockIds.push("absent");
    expect(
      (await f.run("carrot_run_selection_translation", input)).job.error?.code,
    ).toBe("not_found");
    expect(f.request).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it("never retries invalid model replies or publishes partial successful targets", async () => {
  const f = await selectionAppFixture();
  const before = await readFile(f.chapterPath);
  try {
    f.request
      .mockResolvedValueOnce('{"blockId":"a","translatedText":"first"}')
      .mockResolvedValueOnce('{"blockId":"other","translatedText":"wrong"}');
    const { job } = await f.run(
      "carrot_run_selection_translation",
      await f.translationInput(),
    );
    expect(job.status).toBe("failed");
    expect(f.request).toHaveBeenCalledTimes(2);
    expect(f.dispose).toHaveBeenCalledTimes(2);
    expect(job.result?.selectionAnalysis).toBeUndefined();
    await expect(f.get(job.jobId)).rejects.toThrow();
    expect(await readFile(f.chapterPath)).toEqual(before);
  } finally {
    await f.close();
  }
});

it("detects edits to non-current selected pages before publishing any translation analysis", async () => {
  const f = await selectionAppFixture();
  f.request.mockImplementationOnce(async ({ userPrompt }) => {
    const chapter = JSON.parse(await readFile(f.chapterPath, "utf8"));
    chapter.pages[1].blocks[0].sourceText = "external edit";
    await writeFile(f.chapterPath, JSON.stringify(chapter));
    return JSON.stringify({
      blockId: JSON.parse(userPrompt).blockId,
      translatedText: "proposal",
    });
  });
  try {
    const { job } = await f.run(
      "carrot_run_selection_translation",
      await f.translationInput(),
    );
    expect(job.status).toBe("failed");
    expect(job.error?.code).toBe("revision_conflict");
    expect(job.result?.selectionAnalysis).toBeUndefined();
    expect(
      (await f.library.openChapter("chapter")).pages[1].blocks[0].sourceText,
    ).toBe("external edit");
  } finally {
    await f.close();
  }
});

it("keeps the admitted provider and language configuration fixed between selected blocks", async () => {
  const f = await selectionAppFixture();
  const originalModel = f.settings.api.model;
  f.request.mockImplementationOnce(async ({ userPrompt }) => {
    f.settings.modelProvider = "openai-codex";
    f.settings.api.model = "later-settings-value";
    return JSON.stringify({
      blockId: JSON.parse(userPrompt).blockId,
      translatedText: "first",
    });
  });
  try {
    const { job } = await f.run(
      "carrot_run_selection_translation",
      await f.translationInput(),
    );
    expect(job.status).toBe("completed");
    expect(f.request).toHaveBeenCalledTimes(2);
    for (const [call] of f.request.mock.calls)
      expect(call.options).toMatchObject({
        modelProvider: "openai-api",
        apiModel: originalModel,
      });
  } finally {
    await f.close();
  }
});

it("runs the permitted local text path under the shared model lease and excludes empty source text", async () => {
  const f = await selectionAppFixture();
  f.settings.modelProvider = "gemma";
  const stored = JSON.parse(await readFile(f.chapterPath, "utf8"));
  stored.pages[1].blocks[0].sourceText = " ";
  await writeFile(f.chapterPath, JSON.stringify(stored));
  try {
    const { job } = await f.run("carrot_run_selection_translation", {
      ...(await f.translationInput()),
      expectedEngine: "gemma",
      allowAssetDownloads: true,
      allowExternal: false,
    });
    expect(job.status).toBe("completed");
    const result = await f.get(job.jobId);
    expect(result.items[0].translation).toMatchObject({ execution: "local" });
    expect(result.items[1].excludedReason).toBe("no_source_text");
    expect(f.request).toHaveBeenCalledOnce();
    expect(f.dispose).toHaveBeenCalledOnce();
    expect(f.collect).not.toHaveBeenCalled();
    expect(f.app.jobs.all).toEqual([]);
  } finally {
    await f.close();
  }
});
