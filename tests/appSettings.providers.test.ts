import { describe, it, expect } from "vitest";
import {
  DEFAULT_API_KEY_MAX_ATTEMPTS,
  DEFAULT_API_RETRY_DELAY_SECONDS,
} from "../src/shared/apiKeySettings";
import {
  resolveDefaultAppSettings,
  parseStoredAppSettings,
  DEFAULT_API_TEMPERATURE,
  DEFAULT_API_TOP_P,
  DEFAULT_API_TOP_K,
  DEFAULT_API_REASONING_EFFORT,
  DEFAULT_API_EXTRA_BODY_JSON,
  DEFAULT_API_CUSTOM_HEADERS_JSON,
  buildBaseTranslationOptions,
} from "../src/main/appSettings";

const describeWindows = process.platform === "win32" ? describe : describe.skip;

describeWindows("app settings helpers: model providers", () => {
  it("keeps local model settings when the source is local", () => {
    const defaults = resolveDefaultAppSettings();

    expect(
      parseStoredAppSettings(
        JSON.stringify({
          gemma: {
            modelSource: "local",
            localModelPath: "D:/models/custom-vision-model.gguf",
            localMmprojPath: "D:/models/mmproj.gguf",
          },
        }),
        defaults,
      ),
    ).toEqual({
      modelProvider: defaults.modelProvider,
      hardware: defaults.hardware,
      translation: defaults.translation,
      gemma: {
        modelSource: "local",
        modelRepo: defaults.gemma.modelRepo,
        modelFile: defaults.gemma.modelFile,
        localModelPath: "D:/models/custom-vision-model.gguf",
        localMmprojPath: "D:/models/mmproj.gguf",
        vramMode: defaults.gemma.vramMode,
        fitTargetMb: defaults.gemma.fitTargetMb,
        mmprojOffload: defaults.gemma.mmprojOffload,
        llamaRuntimeProfile: defaults.gemma.llamaRuntimeProfile,
      },
      codex: defaults.codex,
      internetResearch: defaults.internetResearch,
      api: defaults.api,
      ocr: defaults.ocr,
      inpainting: defaults.inpainting,
      ui: defaults.ui,
      blockFormatDefaults: defaults.blockFormatDefaults,
      blockStylePresetGroups: defaults.blockStylePresetGroups,
      blockStylePresets: defaults.blockStylePresets,
      keybindings: defaults.keybindings,
      maxTokens: defaults.maxTokens,
      ctx: defaults.ctx,
    });
  });

  it("repairs optional API defaults omitted by older default objects", () => {
    const defaults = resolveDefaultAppSettings();
    const sparseDefaults = {
      ...defaults,
      api: {
        baseUrl: defaults.api.baseUrl,
        model: defaults.api.model,
      },
    };

    const normalized = parseStoredAppSettings("{}", sparseDefaults);

    expect(normalized.api).toMatchObject({
      keyMaxAttempts: DEFAULT_API_KEY_MAX_ATTEMPTS,
      retryDelaySeconds: DEFAULT_API_RETRY_DELAY_SECONDS,
      temperature: null,
      topP: null,
      topK: DEFAULT_API_TOP_K,
      reasoningEffort: DEFAULT_API_REASONING_EFFORT,
      extraBodyJson: DEFAULT_API_EXTRA_BODY_JSON,
      customHeadersJson: DEFAULT_API_CUSTOM_HEADERS_JSON,
    });
  });

  it("normalizes Codex provider settings", () => {
    const defaults = resolveDefaultAppSettings();

    expect(
      parseStoredAppSettings(
        JSON.stringify({
          modelProvider: "openai-codex",
          codex: {
            model: "gpt-5.6-sol",
            reasoningEffort: "ultra",
            oauthPort: 10532,
          },
        }),
        defaults,
      ),
    ).toEqual({
      modelProvider: "openai-codex",
      hardware: defaults.hardware,
      translation: defaults.translation,
      gemma: defaults.gemma,
      codex: {
        model: "gpt-5.6-sol",
        reasoningEffort: "ultra",
      },
      internetResearch: defaults.internetResearch,
      api: defaults.api,
      ocr: defaults.ocr,
      inpainting: defaults.inpainting,
      ui: defaults.ui,
      blockFormatDefaults: defaults.blockFormatDefaults,
      blockStylePresetGroups: defaults.blockStylePresetGroups,
      blockStylePresets: defaults.blockStylePresets,
      keybindings: defaults.keybindings,
      maxTokens: defaults.maxTokens,
      ctx: defaults.ctx,
    });
  });

  it("normalizes API provider settings", () => {
    const defaults = resolveDefaultAppSettings();

    expect(
      parseStoredAppSettings(
        JSON.stringify({
          modelProvider: "openai-api",
          api: {
            baseUrl: "http://127.0.0.1:1234/v1/chat/completions/",
            model: "local-vision-model",
            apiKey: "sk-test",
          },
        }),
        defaults,
      ),
    ).toEqual({
      modelProvider: "openai-api",
      hardware: defaults.hardware,
      translation: defaults.translation,
      gemma: defaults.gemma,
      codex: defaults.codex,
      internetResearch: defaults.internetResearch,
      api: {
        baseUrl: "http://127.0.0.1:1234/v1",
        model: "local-vision-model",
        apiKey: "sk-test",
        keyMaxAttempts: defaults.api.keyMaxAttempts,
        retryDelaySeconds: defaults.api.retryDelaySeconds,
        temperature: DEFAULT_API_TEMPERATURE,
        topP: DEFAULT_API_TOP_P,
        topK: DEFAULT_API_TOP_K,
        reasoningEffort: DEFAULT_API_REASONING_EFFORT,
        extraBodyJson: DEFAULT_API_EXTRA_BODY_JSON,
        customHeadersJson: DEFAULT_API_CUSTOM_HEADERS_JSON,
      },
      ocr: defaults.ocr,
      inpainting: defaults.inpainting,
      ui: defaults.ui,
      blockFormatDefaults: defaults.blockFormatDefaults,
      blockStylePresetGroups: defaults.blockStylePresetGroups,
      blockStylePresets: defaults.blockStylePresets,
      keybindings: defaults.keybindings,
      maxTokens: defaults.maxTokens,
      ctx: defaults.ctx,
    });

    expect(
      parseStoredAppSettings(
        JSON.stringify({
          modelProvider: "openai-api",
          api: {
            baseUrl: "ftp://example.test/v1",
            model: "",
          },
        }),
        defaults,
      ).api,
    ).toEqual(defaults.api);
  });

  it("applies API runtime environment overrides", () => {
    const defaults = resolveDefaultAppSettings();
    const options = buildBaseTranslationOptions({
      jobId: "job-api",
      runDir: "C:/runs/job-api",
      paths: {
        dataRoot: "C:/app-data",
        toolsDir: "C:/tools",
        llamaServerPath: "C:/tools/llama-server.exe",
      },
      settings: {
        ...defaults,
        modelProvider: "openai-api",
        api: {
          baseUrl: "https://api.openai.com/v1",
          model: "saved-model",
          apiKey: "saved-key-one\nsaved-key-two",
          keyMaxAttempts: 3,
          retryDelaySeconds: 2.5,
        },
      },
      env: {
        MANGA_TRANSLATOR_API_BASE_URL:
          "http://127.0.0.1:1234/v1/chat/completions",
        MANGA_TRANSLATOR_API_MODEL: "env-model",
        MANGA_TRANSLATOR_API_KEY_MAX_ATTEMPTS: "4",
        MANGA_TRANSLATOR_API_RETRY_DELAY_SECONDS: "0.5",
        OPENAI_API_KEY: "env-key",
      } satisfies NodeJS.ProcessEnv,
    });

    expect(options.modelProvider).toBe("openai-api");
    expect(options.apiBaseUrl).toBe("http://127.0.0.1:1234/v1");
    expect(options.apiModel).toBe("env-model");
    expect(options.apiKey).toBe("saved-key-one\nsaved-key-two");
    expect(options.apiKeyMaxAttempts).toBe(4);
    expect(options.apiRetryDelaySeconds).toBe(0.5);
  });

  it("normalizes and preserves API advanced settings", () => {
    const defaults = resolveDefaultAppSettings();
    const stored = parseStoredAppSettings(
      JSON.stringify({
        modelProvider: "openai-api",
        api: {
          baseUrl: "https://openrouter.ai/api/v1",
          model: "vision/model",
          temperature: null,
          topP: null,
          topK: 2048,
          reasoningEffort: "minimal",
          extraBodyJson: '{"provider":{"sort":"throughput"}}',
          customHeadersJson: '{"X-OpenRouter-Title":"Manga Translator"}',
        },
      }),
      defaults,
    );

    expect(stored.api.temperature).toBeNull();
    expect(stored.api.topP).toBeNull();
    expect(stored.api.topK).toBe(1000);
    expect(stored.api.reasoningEffort).toBe("minimal");
    expect(stored.api.extraBodyJson).toBe('{"provider":{"sort":"throughput"}}');
    expect(stored.api.customHeadersJson).toBe(
      '{"X-OpenRouter-Title":"Manga Translator"}',
    );

    const options = buildBaseTranslationOptions({
      jobId: "job-api-advanced",
      runDir: "C:/runs/job-api-advanced",
      paths: {
        dataRoot: "C:/app-data",
        toolsDir: "C:/tools",
        llamaServerPath: "C:/tools/llama-server.exe",
      },
      settings: stored,
      env: {
        MANGA_TRANSLATOR_API_TEMPERATURE: "",
        MANGA_TRANSLATOR_API_TOP_K: "5",
        MANGA_TRANSLATOR_API_REASONING_EFFORT: "high",
        MANGA_TRANSLATOR_API_EXTRA_BODY: '{"top_k":1}',
        MANGA_TRANSLATOR_API_HEADERS: '{"X-Test":"yes"}',
      } satisfies NodeJS.ProcessEnv,
    });

    expect(options.apiTemperature).toBeNull();
    expect(options.apiTopP).toBeNull();
    expect(options.apiTopK).toBe(5);
    expect(options.apiReasoningEffort).toBe("high");
    expect(options.apiExtraBodyJson).toBe('{"top_k":1}');
    expect(options.apiCustomHeadersJson).toBe('{"X-Test":"yes"}');
  });

  it("uses OPENAI_API_KEY only when API settings target the official endpoint", () => {
    const defaults = resolveDefaultAppSettings();
    const officialOptions = buildBaseTranslationOptions({
      jobId: "job-api-openai",
      runDir: "C:/runs/job-api-openai",
      paths: {
        dataRoot: "C:/app-data",
        toolsDir: "C:/tools",
        llamaServerPath: "C:/tools/llama-server.exe",
      },
      settings: {
        ...defaults,
        modelProvider: "openai-api",
        api: {
          baseUrl: "https://api.openai.com/v1",
          model: "gpt-5.5",
        },
      },
      env: {
        OPENAI_API_KEY: "openai-env-key",
      } satisfies NodeJS.ProcessEnv,
    });
    const compatibleOptions = buildBaseTranslationOptions({
      jobId: "job-api-compatible",
      runDir: "C:/runs/job-api-compatible",
      paths: {
        dataRoot: "C:/app-data",
        toolsDir: "C:/tools",
        llamaServerPath: "C:/tools/llama-server.exe",
      },
      settings: {
        ...defaults,
        modelProvider: "openai-api",
        api: {
          baseUrl: "https://integrate.api.nvidia.com/v1",
          model: "nvidia/nemotron-3-ultra-550b-a55b",
        },
      },
      env: {
        OPENAI_API_KEY: "openai-env-key",
      } satisfies NodeJS.ProcessEnv,
    });
    const explicitCompatibleOptions = buildBaseTranslationOptions({
      jobId: "job-api-compatible-explicit",
      runDir: "C:/runs/job-api-compatible-explicit",
      paths: {
        dataRoot: "C:/app-data",
        toolsDir: "C:/tools",
        llamaServerPath: "C:/tools/llama-server.exe",
      },
      settings: {
        ...defaults,
        modelProvider: "openai-api",
        api: {
          baseUrl: "https://integrate.api.nvidia.com/v1",
          model: "nvidia/nemotron-3-ultra-550b-a55b",
          apiKey: "saved-provider-key",
        },
      },
      env: {
        MANGA_TRANSLATOR_API_KEY: "provider-env-key",
        OPENAI_API_KEY: "openai-env-key",
      } satisfies NodeJS.ProcessEnv,
    });

    expect(officialOptions.apiKey).toBe("openai-env-key");
    expect(compatibleOptions.apiKey).toBeUndefined();
    expect(explicitCompatibleOptions.apiKey).toBe("provider-env-key");
  });

  it("configures automatic Vertex tokens from a service-account path unless an environment token overrides it", () => {
    const defaults = resolveDefaultAppSettings();
    const settings = {
      ...defaults,
      modelProvider: "openai-api" as const,
      api: {
        ...defaults.api,
        baseUrl:
          "https://aiplatform.googleapis.com/v1/projects/sample-project/locations/global/endpoints/openapi",
        model: "google/gemini-2.5-flash",
        apiKey: "stale-token",
        vertexAuthMode: "service-account" as const,
        vertexServiceAccountPath: "C:\\keys\\vertex.json",
      },
    };
    const serviceAccountOptions = buildBaseTranslationOptions({
      jobId: "job-vertex-service-account",
      runDir: "C:/runs/job-vertex-service-account",
      paths: {
        dataRoot: "C:/app-data",
        toolsDir: "C:/tools",
        llamaServerPath: "C:/tools/llama-server.exe",
      },
      settings,
      env: {},
    });
    const environmentOverrideOptions = buildBaseTranslationOptions({
      jobId: "job-vertex-env-token",
      runDir: "C:/runs/job-vertex-env-token",
      paths: {
        dataRoot: "C:/app-data",
        toolsDir: "C:/tools",
        llamaServerPath: "C:/tools/llama-server.exe",
      },
      settings,
      env: { MANGA_TRANSLATOR_API_KEY: "env-token" },
    });

    expect(serviceAccountOptions.apiKey).toBeUndefined();
    expect(serviceAccountOptions.apiAccessTokenProvider).toBeTypeOf("function");
    expect(environmentOverrideOptions.apiKey).toBe("env-token");
    expect(environmentOverrideOptions.apiAccessTokenProvider).toBeUndefined();
  });
});
