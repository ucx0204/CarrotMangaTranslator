import { expect, it, vi } from "vitest";
import { translationFixture as fixture } from "./mcpBlockTranslation.fixture";

it("uses one text request and existing saved context without changing the page or images", async () => {
  const f = await fixture();
  try {
    const before = await f.snapshot();
    const result = await f.run();
    expect(result).toMatchObject({
      translatedText: "translated\n\ud83e\udd55",
      engine: "openai-api",
      execution: "external",
    });
    expect(f.runtime.request).toHaveBeenCalledOnce();
    const call = vi.mocked(f.runtime.request).mock.calls[0][0];
    expect(JSON.parse(call.userPrompt)).toMatchObject({
      blockId: "a",
      sourceText: "source",
      textRole: "ordinary",
    });
    expect(call.userPrompt).not.toMatch(
      /image_url|imagePath|\/private\/|PRIVATE|original-a/,
    );
    expect(call.options).toMatchObject({
      imagePath: "",
      textOnlyModel: true,
      reuseServer: false,
      useDraft: false,
      apiKey: "first-key",
      apiKeyMaxAttempts: 1,
      autoFontMatching: false,
    });
    expect(call.systemPrompt).toContain("untrusted data");
    expect(f.session.dispose).toHaveBeenCalledOnce();
    expect(await f.snapshot()).toEqual(before);
    expect(JSON.stringify(result)).not.toMatch(
      /apiKey|first-key|imagePath|referenceNotes/,
    );
  } finally {
    await f.close();
  }
});

it.each([
  "not JSON",
  "{}",
  "[]",
  JSON.stringify({ blockId: "wrong", translatedText: "text" }),
  JSON.stringify({ blockId: "a", translatedText: "" }),
  JSON.stringify({ blockId: "a", translatedText: "text", fontSizePx: 30 }),
  JSON.stringify({ blockId: "a", translatedText: "x".repeat(8193) }),
  "x".repeat(48_001),
])(
  "rejects unusable reply %# without another generation or page write",
  async (reply) => {
    const f = await fixture();
    try {
      const before = await f.snapshot();
      vi.mocked(f.runtime.request).mockResolvedValueOnce(reply);
      await expect(f.run()).rejects.toMatchObject({ code: "invalid_edit" });
      expect(f.runtime.request).toHaveBeenCalledOnce();
      expect(f.session.dispose).toHaveBeenCalledOnce();
      expect(await f.snapshot()).toEqual(before);
    } finally {
      await f.close();
    }
  },
);

it("releases the session on request failure, cancellation, revocation and context change", async () => {
  for (const mode of ["request", "cancel", "revoke", "context"]) {
    const f = await fixture();
    try {
      vi.mocked(f.runtime.request).mockImplementationOnce(async () => {
        if (mode === "request") throw new Error("upstream failed");
        if (mode === "cancel") f.controller.abort();
        if (mode === "revoke")
          f.operation.assertAuthorized.mockImplementation(() => {
            throw new Error("revoked");
          });
        if (mode === "context") {
          const guide = await f.library.getWorkStyleGuide("work");
          await f.library.saveWorkStyleGuide({
            ...guide,
            rules: { ...guide.rules, defaultTone: "literal" },
          });
        }
        return JSON.stringify({ blockId: "a", translatedText: "text" });
      });
      await expect(f.run()).rejects.toThrow();
      expect(f.session.dispose).toHaveBeenCalledOnce();
      expect(f.runtime.request).toHaveBeenCalledOnce();
    } finally {
      await f.close();
    }
  }
});

it("waits for cleanup and fences a failed local release instead of publishing the proposal", async () => {
  const f = await fixture();
  const { releaseModelResource, modelCleanupIsBlocked } =
    await import("../src/main/runtimeSupport/modelCleanupBarrier");
  let finish!: () => void;
  let enter!: () => void;
  const wait = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  f.options.modelProvider = "gemma";
  f.session.dispose.mockImplementationOnce(async () => {
    enter();
    await wait;
    throw new Error("unload failed");
  });
  const outcome = f.run().then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  try {
    await entered;
    expect(modelCleanupIsBlocked()).toBe(true);
    finish();
    expect(await outcome).toMatchObject({
      error: { code: "MODEL_CLEANUP_INCOMPLETE" },
    });
    expect(modelCleanupIsBlocked()).toBe(true);
    await releaseModelResource(f.session, () => f.session.dispose());
    expect(modelCleanupIsBlocked()).toBe(false);
  } finally {
    finish();
    await outcome;
    await f.close();
  }
});

it("retains request and cleanup failures without leaking raw provider data", async () => {
  const f = await fixture();
  try {
    const request = new Error("request failed"),
      cleanup = new Error("cleanup failed");
    vi.mocked(f.runtime.request).mockRejectedValueOnce(request);
    f.session.dispose.mockRejectedValueOnce(cleanup);
    await expect(f.run()).rejects.toMatchObject({ errors: [request, cleanup] });
  } finally {
    await f.close();
  }
});

it("constrains task options without rewriting settings or allowing extra tool/generation overrides", async () => {
  const f = await fixture();
  try {
    const before = structuredClone(f.base);
    const prepared = f.prepare({ ...f.base, modelProvider: "openai-codex" });
    expect(prepared.execution).toBe("external");
    expect(f.base).toEqual(before);
    for (const apiBaseUrl of [
      "invalid",
      "http://localhost:1234/v1",
      "https://127.0.0.1/v1",
      "https://local.lan/v1",
      "http://localhost:11434/v1",
      "https://user:secret@remote.test/v1",
    ]) {
      expect(() => f.prepare({ ...f.options, apiBaseUrl })).toThrow();
    }
    for (const apiExtraBodyJson of [
      "invalid",
      "[]",
      "null",
      '{"tools":[]}',
      '{"n":2}',
      '{"stream":true}',
      '{"temperature":{}}',
    ]) {
      expect(() => f.prepare({ ...f.options, apiExtraBodyJson })).toThrow();
    }
    expect(
      f.prepare({ ...f.options, apiExtraBodyJson: '{"temperature":0.2}' })
        .options.apiExtraBodyJson,
    ).toBe('{"temperature":0.2}');
    expect(() => f.prepare({ ...f.options, maxTokens: 0 })).toThrow();
    expect(f.runtime.request).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});
