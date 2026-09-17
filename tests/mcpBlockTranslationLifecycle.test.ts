import { basename } from "node:path";
import { expect, it, vi } from "vitest";
import { translationFixture as fixture } from "./mcpBlockTranslation.fixture";

it.each(["gemma", "openai-codex"] as const)(
  "returns a %s proposal only after releasing its session",
  async (provider) => {
    const f = await fixture();
    try {
      const before = await f.snapshot();
      const prepared = f.prepare({ ...f.options, modelProvider: provider });
      expect(prepared.execution).toBe(
        provider === "gemma" ? "local" : "external",
      );
      Object.assign(f.options, prepared.options);
      const result = await f.run();
      expect(result).toMatchObject({
        translatedText: "translated\n\ud83e\udd55",
        engine: provider,
        execution: provider === "gemma" ? "local" : "external",
        model:
          provider === "gemma"
            ? basename(f.options.modelFile)
            : f.options.codexModel,
      });
      expect(f.runtime.start).toHaveBeenCalledOnce();
      expect(f.runtime.request).toHaveBeenCalledOnce();
      expect(f.session.dispose).toHaveBeenCalledOnce();
      expect(await f.snapshot()).toEqual(before);
      const { modelCleanupIsBlocked } =
        await import("../src/main/runtimeSupport/modelCleanupBarrier");
      expect(modelCleanupIsBlocked()).toBe(false);
    } finally {
      await f.close();
    }
  },
);

it("releases an acquired session when authorization disappears before generation", async () => {
  const f = await fixture();
  try {
    const before = await f.snapshot();
    vi.mocked(f.runtime.start).mockImplementationOnce(async () => {
      f.controller.abort(new Error("revoked before generation"));
      return f.session;
    });
    await expect(f.run()).rejects.toThrow("revoked before generation");
    expect(f.runtime.request).not.toHaveBeenCalled();
    expect(f.session.dispose).toHaveBeenCalledOnce();
    expect(await f.snapshot()).toEqual(before);
  } finally {
    await f.close();
  }
});

it("does not generate or pretend to dispose an unacquired session after startup failure", async () => {
  const f = await fixture();
  try {
    const before = await f.snapshot();
    vi.mocked(f.runtime.start).mockRejectedValueOnce(new Error("start failed"));
    await expect(f.run()).rejects.toThrow("start failed");
    expect(f.runtime.request).not.toHaveBeenCalled();
    expect(f.session.dispose).not.toHaveBeenCalled();
    expect(await f.snapshot()).toEqual(before);
  } finally {
    await f.close();
  }
});

it("allows an empty hosted API key without inventing credentials or changing settings", async () => {
  const f = await fixture();
  try {
    const base = { ...f.options, apiKey: "", apiExtraBodyJson: undefined };
    const prepared = f.prepare(base);
    expect(prepared.options.apiKey).toBe("");
    expect(prepared.options.apiKeyMaxAttempts).toBe(1);
    expect(prepared.options.apiExtraBodyJson).toBeUndefined();
    expect(base.apiKey).toBe("");
    expect(f.runtime.start).not.toHaveBeenCalled();
    expect(f.runtime.request).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it("rejects credentials and unmanaged hosts while preserving a hosted scalar request", async () => {
  const f = await fixture();
  try {
    for (const apiBaseUrl of [
      "https://:secret@translation.example.test/v1",
      "https://localhost/v1",
      "https://[::1]/v1",
      "https://models.internal/v1",
      "https://translation.example.test:11434/v1",
    ]) {
      expect(() => f.prepare({ ...f.options, apiBaseUrl })).toThrow();
    }
    for (const apiExtraBodyJson of [
      "0",
      JSON.stringify("sampling"),
      '{"temperature":null}',
    ]) {
      expect(() => f.prepare({ ...f.options, apiExtraBodyJson })).toThrow();
    }
    const raw =
      '{"temperature":0,"enable_thinking":false,"reasoning_effort":"low"}';
    expect(
      f.prepare({ ...f.options, apiExtraBodyJson: raw }).options
        .apiExtraBodyJson,
    ).toBe(raw);
    expect(f.runtime.request).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});
