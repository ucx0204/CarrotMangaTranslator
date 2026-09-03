import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isOllamaCloudModelId,
  releaseOllamaLocalModel,
  resolveOllamaUnloadUrl,
} from "../src/main/ollamaModelLifecycle";
import { startModelEndpointSession } from "../src/main/pipeline/runtimeModules";
import type { TranslationOptions } from "../src/main/appSettings";
import type { RuntimeModules } from "../src/main/pipeline/types";

const localOptions = {
  modelProvider: "openai-api" as const,
  apiBaseUrl: "http://192.168.1.5:11434/v1",
  apiModel: "gemma4:latest",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Ollama model lifecycle", () => {
  it("unloads exactly the selected local model through Ollama's native API", async () => {
    const fetchImpl = vi.fn(
      async (_input: string | URL, _init?: RequestInit) => ({
        ok: true,
        status: 200,
      }),
    );

    await expect(
      releaseOllamaLocalModel(localOptions, fetchImpl),
    ).resolves.toBe(true);

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("http://192.168.1.5:11434/api/generate");
    expect(init).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "gemma4:latest",
      keep_alive: 0,
      stream: false,
    });
  });

  it.each(["gemma4:31b-cloud", "glm-5.3-flash:cloud"])(
    "does not issue a local unload request for Cloud model %s",
    async (apiModel) => {
      const fetchImpl = vi.fn(
        async (_input: string | URL, _init?: RequestInit) => ({
          ok: true,
          status: 200,
        }),
      );

      await expect(
        releaseOllamaLocalModel({ ...localOptions, apiModel }, fetchImpl),
      ).resolves.toBe(false);

      expect(fetchImpl).not.toHaveBeenCalled();
      expect(isOllamaCloudModelId(apiModel)).toBe(true);
    },
  );

  it("does not treat another provider endpoint as local Ollama", async () => {
    const fetchImpl = vi.fn(
      async (_input: string | URL, _init?: RequestInit) => ({
        ok: true,
        status: 200,
      }),
    );

    await expect(
      releaseOllamaLocalModel(
        { ...localOptions, apiBaseUrl: "https://openrouter.ai/api/v1" },
        fetchImpl,
      ),
    ).resolves.toBe(false);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(resolveOllamaUnloadUrl("https://openrouter.ai/api/v1")).toBeNull();
  });

  it("runs the unload once when the shared endpoint session is disposed", async () => {
    const fetchImpl = vi.fn(
      async (_input: string | URL, _init?: RequestInit) => ({
        ok: true,
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchImpl);
    const session = await startModelEndpointSession(
      {} as RuntimeModules,
      localOptions as TranslationOptions,
    );

    await session.dispose();
    await session.dispose();

    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
