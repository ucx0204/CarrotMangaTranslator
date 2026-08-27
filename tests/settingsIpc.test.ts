import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppActivityGate } from "../src/main/appActivityGate";
import { AppOperationRegistry } from "../src/main/appOperationRegistry";
import type { AppSettings } from "../src/shared/settingsTypes";
import type { ModelTestProgressEvent } from "../src/shared/jobTypes";
import type { IpcContext, PanelWindowPort } from "../src/main/ipc/context";
import type { SimplePageRuntime } from "../src/main/simplePageRuntime";
import type { CodexAppServerEndpoint } from "../src/main/codexAppServerEndpoint";
import type {
  CodexAccountClient,
  CodexAccountIpcRuntime,
} from "../src/main/ipc/codexAccountIpc";
import { normalizeAppSettingsForRuntime } from "../src/main/settingsStore";

type IpcHandler = (
  event: {
    sender: { id: number; send: (channel: string, payload: unknown) => void };
    senderFrame?: { url: string };
  },
  ...args: unknown[]
) => Promise<unknown> | unknown;

const electronMock = vi.hoisted(() => {
  const handlers = new Map<string, IpcHandler>();
  return {
    handlers,
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      handlers.set(channel, handler);
    }),
    showOpenDialog: vi.fn(),
  };
});

const codexMock = {
  start: vi.fn(),
  stop: vi.fn(async () => {}),
};

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: () => "",
    getVersion: () => "1.20.2-test",
  },
  dialog: {
    showOpenDialog: electronMock.showOpenDialog,
  },
  ipcMain: {
    handle: electronMock.handle,
  },
  shell: {
    openExternal: vi.fn(async () => undefined),
  },
}));

import { registerSettingsIpc } from "../src/main/ipc/settingsIpc";

const tempDirs: string[] = [];

beforeEach(() => {
  electronMock.handlers.clear();
  electronMock.handle.mockClear();
  electronMock.showOpenDialog.mockClear();
  codexMock.start.mockReset();
  codexMock.stop.mockReset();
  codexMock.stop.mockResolvedValue(undefined);
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("settings IPC Codex account", () => {
  it("coalesces concurrent status reads without taking the global activity lock", async () => {
    const client = createCodexAccountClient();
    client.readAccount.mockResolvedValue({
      account: {
        type: "chatgpt",
        email: "reader@example.com",
        planType: "plus",
      },
      requiresOpenaiAuth: true,
    });
    const accountRuntime = createCodexAccountRuntime(client.client);
    const handler = registerAndGetCodexAccountHandler(
      "settings:codex-account",
      accountRuntime,
    );

    const [first, second] = await Promise.all([
      handler(trustedEvent()),
      handler(trustedEvent()),
    ]);

    expect(first).toMatchObject({ authenticated: true });
    expect(second).toEqual(first);
    expect(accountRuntime.startClient).toHaveBeenCalledOnce();
    expect(client.readAccount).toHaveBeenCalledOnce();
    expect(client.listModels).toHaveBeenCalledOnce();
    expect(client.dispose).toHaveBeenCalledOnce();
  });

  it("opens only the official ChatGPT login URL and returns the refreshed account", async () => {
    const client = createCodexAccountClient();
    client.readAccount.mockResolvedValue({
      account: {
        type: "chatgpt",
        email: "reader@example.com",
        planType: "plus",
      },
      requiresOpenaiAuth: true,
    });
    const accountRuntime = createCodexAccountRuntime(client.client);
    const handler = registerAndGetCodexAccountHandler(
      "settings:codex-login",
      accountRuntime,
    );

    await expect(handler(trustedEvent())).resolves.toEqual({
      authenticated: true,
      accountKind: "chatgpt",
      email: "reader@example.com",
      planType: "plus",
      requiresOpenaiAuth: true,
      appServerVersion: "0.150.1",
      models: [
        {
          id: "gpt-test",
          displayName: "GPT Test",
          supportedReasoningEfforts: ["low", "high"],
          defaultReasoningEffort: "low",
          isDefault: true,
        },
      ],
    });
    expect(accountRuntime.openExternal).toHaveBeenCalledWith(
      "https://auth.openai.com/oauth/authorize?client_id=test",
    );
    expect(client.waitForLogin).toHaveBeenCalledWith(
      "login-1",
      expect.any(AbortSignal),
    );
    expect(client.readAccount).toHaveBeenCalledWith(true);
    expect(client.dispose).toHaveBeenCalledOnce();
  });

  it("rejects a non-OpenAI login URL and cancels the pending login", async () => {
    const client = createCodexAccountClient();
    client.startChatGptLogin.mockResolvedValue({
      loginId: "login-unsafe",
      authUrl: "https://openai.com.evil.example/oauth",
    });
    const accountRuntime = createCodexAccountRuntime(client.client);
    const handler = registerAndGetCodexAccountHandler(
      "settings:codex-login",
      accountRuntime,
    );

    await expect(handler(trustedEvent())).rejects.toThrow(
      "허용되지 않은 로그인 URL",
    );
    expect(accountRuntime.openExternal).not.toHaveBeenCalled();
    expect(client.cancelLogin).toHaveBeenCalledWith("login-unsafe");
    expect(client.dispose).toHaveBeenCalledOnce();
  });

  it("logs out through App Server and reports the signed-out state", async () => {
    const client = createCodexAccountClient();
    client.readAccount.mockResolvedValue({
      account: null,
      requiresOpenaiAuth: true,
    });
    const handler = registerAndGetCodexAccountHandler(
      "settings:codex-logout",
      createCodexAccountRuntime(client.client),
    );

    await expect(handler(trustedEvent())).resolves.toMatchObject({
      authenticated: false,
      accountKind: null,
    });
    expect(client.logout).toHaveBeenCalledOnce();
    expect(client.readAccount).toHaveBeenCalledWith(false);
  });
});

describe("settings IPC model/runtime check", () => {
  it("uses the renderer-provided test id for progress events", async () => {
    const providedTestId = "settings-test-renderer-id";
    const runtimeProgress = {
      phase: "model_downloading",
      progressText: "Gemma 실행 런타임 다운로드 중",
      detail: "runtime.zip",
      progressMode: "log-only",
      installLogLine: "Gemma runtime preparation log",
    } satisfies Omit<ModelTestProgressEvent, "id">;
    const runtime = createRuntime({
      cached: false,
      startProgress: runtimeProgress,
    });

    const { result, progressEvents } = await invokeSettingsModelTest({
      runtime,
      settings: createGemmaSettings(),
      testId: providedTestId,
    });

    expect(result).toMatchObject({
      ok: true,
      message: "Paddle OCR과 번역 엔진 확인 완료: model test ok",
      launchMode: "cached-hf",
    });
    expect(progressEvents.length).toBeGreaterThan(0);
    expect(progressEvents.every((event) => event.id === providedTestId)).toBe(
      true,
    );
    expect(progressEvents.map((event) => event.progressText)).toContain(
      "Paddle OCR 확인 완료",
    );
    expect(progressEvents.map((event) => event.installLogLine)).toContain(
      runtimeProgress.installLogLine,
    );
    expect(runtime.ensurePaddleOcrRuntime).toHaveBeenCalledTimes(1);
    expect(runtime.stopServer).toHaveBeenCalledTimes(1);
  });

  it("falls back to an internal id when the renderer id is too long", async () => {
    const providedTestId = "x".repeat(201);
    const runtime = createRuntime({
      cached: true,
    });

    const { progressEvents } = await invokeSettingsModelTest({
      runtime,
      settings: createGemmaSettings(),
      testId: providedTestId,
    });

    const eventIds = new Set(progressEvents.map((event) => event.id));
    expect(eventIds.size).toBe(1);
    expect([...eventIds][0]).not.toBe(providedTestId);
    expect([...eventIds][0]).toHaveLength(36);
  });

  it("retries Gemma model tests when the reserved port is taken before startup", async () => {
    const runtime = createRuntime({
      cached: true,
      startErrors: [portBindError()],
    });

    const { result, progressEvents } = await invokeSettingsModelTest({
      runtime,
      settings: createGemmaSettings(),
      testId: "retry-gemma-port",
    });

    expect(result.ok).toBe(true);
    expect(runtime.startServer).toHaveBeenCalledTimes(2);
    expect(progressEvents.map((event) => event.progressText)).toContain(
      "모델/런타임 확인 포트 재시도 중",
    );
    expect(runtime.stopServer).toHaveBeenCalledTimes(1);
  });

  it("tests OpenAI Codex through the embedded App Server endpoint", async () => {
    const endpointStub: Partial<CodexAppServerEndpoint> = {
      baseUrl: "http://127.0.0.1:18080/v1",
      startedByScript: true,
      provider: "openai-codex",
    };
    const endpoint = endpointStub as CodexAppServerEndpoint;
    codexMock.start.mockResolvedValueOnce(endpoint);
    const runtime = createRuntime({
      cached: true,
    });

    const { result, progressEvents } = await invokeSettingsModelTest({
      runtime,
      settings: createCodexSettings(),
      testId: "embedded-codex-app-server",
    });

    expect(result).toMatchObject({
      ok: true,
      launchMode: "openai-codex",
      resolvedEndpoint: endpoint.baseUrl,
    });
    expect(codexMock.start).toHaveBeenCalledTimes(1);
    expect(codexMock.start).toHaveBeenCalledWith(
      expect.objectContaining({ port: 0, modelProvider: "openai-codex" }),
    );
    expect(progressEvents.map((event) => event.progressText)).toContain(
      "OpenAI Codex 런타임 엔드포인트 준비 중",
    );
    expect(codexMock.stop).toHaveBeenCalledWith(endpoint);
  });

  it("tests API settings through the direct compatible endpoint", async () => {
    const runtime = createRuntime({
      cached: true,
    });

    const { result, progressEvents } = await invokeSettingsModelTest({
      runtime,
      settings: createApiSettings(),
      testId: "api-direct",
    });

    expect(result).toMatchObject({
      ok: true,
      launchMode: "openai-api",
      resolvedEndpoint: "http://127.0.0.1:1234/v1",
    });
    expect(runtime.startServer).not.toHaveBeenCalled();
    expect(runtime.stopServer).not.toHaveBeenCalled();
    expect(codexMock.start).not.toHaveBeenCalled();
    expect(codexMock.stop).not.toHaveBeenCalled();
    expect(runtime.testModelReply).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "http://127.0.0.1:1234/v1",
        provider: "openai-api",
      }),
      expect.objectContaining({
        modelProvider: "openai-api",
        apiModel: "local-vision-model",
      }),
    );
    expect(progressEvents.map((event) => event.progressText)).toContain(
      "API 엔드포인트 확인 중",
    );
  });

  it("shows a localized failure summary while keeping raw errors out of the UI payload", async () => {
    const runtime = createRuntime({
      cached: true,
      startErrors: [new Error("raw runtime failure")],
    });

    const { result, progressEvents } = await invokeSettingsModelTest({
      runtime,
      settings: createGemmaSettings(),
      testId: "localized-failure",
    });

    const expected =
      "모델/런타임 확인에 실패했습니다. 자세한 원인은 로그에서 확인하세요.";
    expect(result).toMatchObject({ ok: false, message: expected });
    expect(
      progressEvents.find((event) => event.phase === "failed")?.detail,
    ).toBe(expected);
    expect(JSON.stringify({ result, progressEvents })).not.toContain(
      "raw runtime failure",
    );
  });

  it("tests the same hardware-normalized OCR route that Save would persist", async () => {
    const runtime = createRuntime({ cached: true });
    const draft = {
      ...createGemmaSettings(),
      ocr: {
        device: "gpu" as const,
        gpuBackend: "rocm-transformers" as const,
        qualityMode: "full" as const,
        gpuCudaTag: "cu126",
      },
      // A forged/stale renderer capability must not be authoritative.
      runtimeHardware: {
        gpuVendor: "amd" as const,
        supportsOcrRocm: true,
      },
    };
    const detectedRx6700 = {
      name: "AMD Radeon RX 6700 XT",
      memoryMb: 12288,
      rtxGeneration: null,
      computeCapability: null,
      vendor: "amd" as const,
      rocmArch: "gfx1031",
      supportsVulkan: true,
      supportsRocm: false,
    };

    await invokeSettingsModelTest({
      runtime,
      settings: draft,
      testId: "rx6700-normalized",
      normalizeSettingsForRuntime: (settings) =>
        normalizeAppSettingsForRuntime(
          settings,
          {},
          async () => detectedRx6700,
        ),
    });

    expect(runtime.ensurePaddleOcrRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        ocrDevice: "cpu",
        ocrGpuBackend: "cuda",
        ocrQualityMode: "economy",
      }),
    );
  });
});

describe("settings IPC recent model directories", () => {
  it("keeps local model and MMProj folders independent and reuses each one", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "settings-paths-ipc-"));
    tempDirs.push(dataRoot);
    const modelDir = join(dataRoot, "models");
    const mmprojDir = join(dataRoot, "mmproj");
    const modelPath = join(modelDir, "translation-model.gguf");
    const mmprojPath = join(mmprojDir, "vision-projection.gguf");
    mkdirSync(modelDir, { recursive: true });
    mkdirSync(mmprojDir, { recursive: true });
    writeFileSync(modelPath, "model");
    writeFileSync(mmprojPath, "mmproj");

    registerSettingsIpc(
      createContext(dataRoot, createRuntime({ cached: true })),
    );
    const modelHandler = electronMock.handlers.get("settings:pick-local-model");
    const mmprojHandler = electronMock.handlers.get(
      "settings:pick-local-mmproj",
    );
    if (!modelHandler || !mmprojHandler) {
      throw new Error("Local model file picker handlers were not registered");
    }
    const event = {
      sender: { id: 1, send: vi.fn() },
      senderFrame: { url: "http://127.0.0.1:5173/" },
    };
    electronMock.showOpenDialog
      .mockResolvedValueOnce({ canceled: false, filePaths: [modelPath] })
      .mockResolvedValueOnce({ canceled: false, filePaths: [mmprojPath] })
      .mockResolvedValueOnce({ canceled: true, filePaths: [] })
      .mockResolvedValueOnce({ canceled: true, filePaths: [] });

    await expect(modelHandler(event)).resolves.toEqual({ modelPath });
    await expect(mmprojHandler(event)).resolves.toBe(mmprojPath);
    await expect(modelHandler(event)).resolves.toBeNull();
    await expect(mmprojHandler(event)).resolves.toBeNull();

    expect(electronMock.showOpenDialog).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({ defaultPath: undefined }),
    );
    expect(electronMock.showOpenDialog).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({ defaultPath: undefined }),
    );
    expect(electronMock.showOpenDialog).toHaveBeenNthCalledWith(
      3,
      expect.anything(),
      expect.objectContaining({ defaultPath: modelDir }),
    );
    expect(electronMock.showOpenDialog).toHaveBeenNthCalledWith(
      4,
      expect.anything(),
      expect.objectContaining({ defaultPath: mmprojDir }),
    );
  });
});

describe("settings IPC Vertex service-account picker", () => {
  it("validates the selected JSON, returns only public metadata, and remembers its folder", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "settings-vertex-ipc-"));
    tempDirs.push(dataRoot);
    const keyDirectory = join(dataRoot, "google-keys");
    const keyPath = join(keyDirectory, "vertex-service-account.json");
    mkdirSync(keyDirectory, { recursive: true });
    writeFileSync(
      keyPath,
      JSON.stringify({
        type: "service_account",
        project_id: "sample-project",
        private_key:
          "-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n",
        client_email:
          "carrot-translator@sample-project.iam.gserviceaccount.com",
        token_uri: "https://oauth2.googleapis.com/token",
      }),
    );

    registerSettingsIpc(
      createContext(dataRoot, createRuntime({ cached: true })),
    );
    const handler = electronMock.handlers.get(
      "settings:pick-vertex-service-account",
    );
    if (!handler) {
      throw new Error("Vertex service-account picker was not registered");
    }
    const event = {
      sender: { id: 1, send: vi.fn() },
      senderFrame: { url: "http://127.0.0.1:5173/" },
    };
    electronMock.showOpenDialog
      .mockResolvedValueOnce({ canceled: false, filePaths: [keyPath] })
      .mockResolvedValueOnce({ canceled: true, filePaths: [] });

    await expect(handler(event)).resolves.toEqual({
      filePath: keyPath,
      fileName: "vertex-service-account.json",
      projectId: "sample-project",
      clientEmail: "carrot-translator@sample-project.iam.gserviceaccount.com",
    });
    await expect(handler(event)).resolves.toBeNull();

    expect(electronMock.showOpenDialog).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({
        defaultPath: undefined,
        filters: [
          {
            name: "Google service account JSON",
            extensions: ["json"],
          },
        ],
      }),
    );
    expect(electronMock.showOpenDialog).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({ defaultPath: keyDirectory }),
    );
  });

  it("rejects a selected file that is not a service-account key", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "settings-vertex-bad-ipc-"));
    tempDirs.push(dataRoot);
    const keyPath = join(dataRoot, "user-credential.json");
    writeFileSync(keyPath, JSON.stringify({ type: "authorized_user" }));
    const context = createContext(dataRoot, createRuntime({ cached: true }));
    registerSettingsIpc(context);
    const handler = electronMock.handlers.get(
      "settings:pick-vertex-service-account",
    );
    if (!handler) {
      throw new Error("Vertex service-account picker was not registered");
    }
    electronMock.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: [keyPath],
    });

    await expect(
      handler({
        sender: { id: 1, send: vi.fn() },
        senderFrame: { url: "http://127.0.0.1:5173/" },
      }),
    ).rejects.toThrow("type 값이 service_account");
    expect(electronMock.showOpenDialog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ properties: ["openFile"] }),
    );
  });
});

async function invokeSettingsModelTest({
  runtime,
  settings,
  testId,
  normalizeSettingsForRuntime = async (value) => value,
}: {
  runtime: SimplePageRuntime;
  settings: AppSettings;
  testId: string;
  normalizeSettingsForRuntime?: (settings: AppSettings) => Promise<AppSettings>;
}): Promise<{
  result: Record<string, unknown>;
  progressEvents: ModelTestProgressEvent[];
}> {
  const dataRoot = mkdtempSync(join(tmpdir(), "settings-ipc-"));
  tempDirs.push(dataRoot);
  const context = createContext(dataRoot, runtime);
  registerSettingsIpc(context, {
    modelTestEndpointRuntime: {
      startCodexAppServerEndpoint: codexMock.start,
      stopCodexAppServerEndpoint: codexMock.stop,
    },
    normalizeSettingsForRuntime,
  });
  const handler = electronMock.handlers.get("settings:test-model");
  if (!handler) {
    throw new Error("settings:test-model handler was not registered");
  }

  const progressEvents: ModelTestProgressEvent[] = [];
  const result = await handler(
    {
      sender: {
        id: 1,
        send: (channel, payload) => {
          if (channel === "settings:model-test-progress") {
            progressEvents.push(payload as ModelTestProgressEvent);
          }
        },
      },
      senderFrame: { url: "http://127.0.0.1:5173/" },
    },
    settings,
    testId,
  );

  return {
    result: result as Record<string, unknown>,
    progressEvents,
  };
}

function createCodexAccountClient() {
  const readAccount = vi.fn<CodexAccountClient["readAccount"]>(
    async (_refreshToken = false) => ({
      account: null,
      requiresOpenaiAuth: true,
    }),
  );
  const startChatGptLogin = vi.fn(async () => ({
    loginId: "login-1",
    authUrl: "https://auth.openai.com/oauth/authorize?client_id=test",
  }));
  const listModels = vi.fn<CodexAccountClient["listModels"]>(async () => [
    {
      id: "gpt-test",
      displayName: "GPT Test",
      hidden: false,
      supportedReasoningEfforts: ["low", "high"],
      defaultReasoningEffort: "low",
      isDefault: true,
    },
  ]);
  const waitForLogin = vi.fn(async () => undefined);
  const cancelLogin = vi.fn(async () => undefined);
  const logout = vi.fn(async () => undefined);
  const dispose = vi.fn(async () => undefined);
  return {
    client: {
      version: "0.150.1",
      readAccount,
      listModels,
      startChatGptLogin,
      waitForLogin,
      cancelLogin,
      logout,
      dispose,
    } satisfies CodexAccountClient,
    readAccount,
    listModels,
    startChatGptLogin,
    waitForLogin,
    cancelLogin,
    logout,
    dispose,
  };
}

function createCodexAccountRuntime(
  client: CodexAccountClient,
): CodexAccountIpcRuntime {
  return {
    startClient: vi.fn(
      async () => client,
    ) as CodexAccountIpcRuntime["startClient"],
    openExternal: vi.fn(async () => undefined),
    appVersion: () => "1.20.2-test",
  };
}

function registerAndGetCodexAccountHandler(
  channel: string,
  codexAccountRuntime: CodexAccountIpcRuntime,
): IpcHandler {
  const dataRoot = mkdtempSync(join(tmpdir(), "settings-codex-account-"));
  tempDirs.push(dataRoot);
  registerSettingsIpc(
    createContext(dataRoot, createRuntime({ cached: true })),
    {
      codexAccountRuntime,
    },
  );
  const handler = electronMock.handlers.get(channel);
  if (!handler)
    throw new Error(`Codex account handler not registered: ${channel}`);
  return handler;
}

function trustedEvent(): Parameters<IpcHandler>[0] {
  return {
    sender: { id: 1, send: vi.fn() },
    senderFrame: { url: "http://127.0.0.1:5173/" },
  };
}

function createContext(
  dataRoot: string,
  runtime: SimplePageRuntime,
): IpcContext {
  const activityGate = new AppActivityGate();
  return {
    appPaths: {
      isPackaged: false,
      repoRoot: dataRoot,
      executableDir: dataRoot,
      resourcesDir: dataRoot,
      dataRoot,
      settingsPath: join(dataRoot, "settings.json"),
      libraryDir: join(dataRoot, "library"),
      fontsDir: join(dataRoot, "fonts"),
      logsDir: join(dataRoot, "logs"),
      logFile: join(dataRoot, "logs", "app.log"),
      runtimeDir: join(dataRoot, "runtime"),
      toolsDir: join(dataRoot, "tools"),
      ocrRuntimeDir: join(dataRoot, "ocr-runtime"),
      llamaRuntimeDir: join(dataRoot, "tools"),
      llamaServerPath: join(dataRoot, "tools", "llama-server"),
    },
    jobs: {
      hasActive: false,
    } as IpcContext["jobs"],
    operations: new AppOperationRegistry(activityGate),
    getMainWindow: () =>
      ({
        isDestroyed: () => false,
        webContents: { id: 1, getURL: () => "http://127.0.0.1:5173/" },
      }) as ReturnType<IpcContext["getMainWindow"]>,
    panelWindows: {
      open: () => true,
      close: () => true,
      publishState: () => undefined,
      getOpenPanelIds: () => [],
      getLastState: () => null,
      isPanelSender: () => false,
      closeAll: () => undefined,
    } satisfies PanelWindowPort,
    loadSimplePageRuntime: () => runtime,
    decodeImage: vi.fn(),
  };
}

function createRuntime({
  cached,
  startProgress,
  startErrors = [],
}: {
  cached: boolean;
  startProgress?: Omit<ModelTestProgressEvent, "id">;
  startErrors?: unknown[];
}): SimplePageRuntime {
  const pendingStartErrors = [...startErrors];
  return {
    isModelCached: vi.fn(() => cached),
    validateImageFileWithFfmpeg: vi.fn(async () => undefined),
    convertImageToPngFileWithFfmpeg: vi.fn(async () => undefined),
    ensurePaddleOcrRuntime: vi.fn(async () => ({
      runtimeVariant: "cpu",
      pythonPath: "C:\\python\\python.exe",
      prepared: true,
    })),
    startServer: vi.fn(async (options) => {
      const startError = pendingStartErrors.shift();
      if (startError) {
        throw startError;
      }
      if (startProgress) {
        (
          options.onProgress as
            | ((progress: Omit<ModelTestProgressEvent, "id">) => void)
            | undefined
        )?.(startProgress);
      }
      return {
        baseUrl: "http://127.0.0.1:18180/v1",
        child: null,
        startedByScript: true,
      };
    }),
    stopServer: vi.fn(async () => {}),
    testModelReply: vi.fn(async () => ({
      outputText: "model test ok",
      launchTarget: {
        launchMode: "cached-hf" as const,
        modelPath: "C:\\models\\gemma.gguf",
        mmprojPath: "C:\\models\\mmproj.gguf",
      },
    })),
  };
}

function portBindError(): Error {
  return Object.assign(new Error("EADDRINUSE: address already in use"), {
    code: "EADDRINUSE",
  });
}

function createGemmaSettings(): AppSettings {
  return {
    modelProvider: "gemma",
    gemma: {
      modelSource: "huggingface",
      modelRepo: "example/gemma",
      modelFile: "gemma.gguf",
      mmprojRepo: "example/gemma-mmproj",
      mmprojFile: "mmproj.gguf",
      vramMode: "economy26b",
    },
    codex: {
      model: "gpt-5.5",
      reasoningEffort: "low",
    },
    api: {
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-5.5",
    },
    ocr: {
      device: "cpu",
      qualityMode: "economy",
      gpuCudaTag: "cu126",
    },
    maxTokens: 12000,
    ctx: 16384,
  };
}

function createCodexSettings(): AppSettings {
  return {
    ...createGemmaSettings(),
    modelProvider: "openai-codex",
    codex: {
      model: "gpt-5.5",
      reasoningEffort: "low",
    },
  };
}

function createApiSettings(): AppSettings {
  return {
    ...createGemmaSettings(),
    modelProvider: "openai-api",
    api: {
      baseUrl: "http://127.0.0.1:1234/v1",
      model: "local-vision-model",
      apiKey: "sk-test",
    },
  };
}
