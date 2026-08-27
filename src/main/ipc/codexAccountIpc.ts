import { app, shell } from "electron";
import { randomUUID } from "node:crypto";
import type {
  CodexAccountModel,
  CodexAccountSnapshot,
} from "../../shared/codexAccountTypes";
import {
  CODEX_REASONING_EFFORTS,
  type CodexReasoningEffort,
} from "../../shared/codexSettings";
import { settingsIpcContracts } from "../../shared/ipcContextSettingsContracts";
import { runManagedAppOperation } from "../appOperationRegistry";
import { CodexAppServerClient } from "../codexAppServerClient";
import type {
  CodexAppServerAccountResult,
  CodexAppServerModel,
} from "../codexAppServerProtocol";
import type { IpcContext } from "./context";
import { trustedHandleContract } from "./trustedIpc";

export type CodexAccountIpcRuntime = {
  startClient: (options: {
    paths: IpcContext["appPaths"];
    appVersion: string;
  }) => Promise<CodexAccountClient>;
  openExternal: (url: string) => Promise<void>;
  appVersion: () => string;
};

export type CodexAccountClient = Pick<
  CodexAppServerClient,
  | "version"
  | "readAccount"
  | "listModels"
  | "startChatGptLogin"
  | "waitForLogin"
  | "cancelLogin"
  | "logout"
  | "dispose"
>;

const productionRuntime: CodexAccountIpcRuntime = {
  startClient: CodexAppServerClient.start,
  openExternal: (url) => shell.openExternal(url),
  appVersion: () => app.getVersion(),
};

export function registerCodexAccountIpc(
  context: IpcContext,
  providedRuntime?: CodexAccountIpcRuntime,
): void {
  const runtime = providedRuntime ?? productionRuntime;
  const getAccount = createCodexAccountReader(context, runtime);
  trustedHandleContract(
    context,
    settingsIpcContracts.getCodexAccount,
    async () => getAccount(),
  );
  trustedHandleContract(
    context,
    settingsIpcContracts.loginCodexAccount,
    async () => runCodexAccountOperation(context, runtime, loginAccount),
  );
  trustedHandleContract(
    context,
    settingsIpcContracts.logoutCodexAccount,
    async () => runCodexAccountOperation(context, runtime, logoutAccount),
  );
}

function createCodexAccountReader(
  context: IpcContext,
  runtime: CodexAccountIpcRuntime,
): () => Promise<CodexAccountSnapshot> {
  let inFlight: Promise<CodexAccountSnapshot> | null = null;
  return () => {
    if (inFlight) return inFlight;
    const pending = runCodexAccountRead(context, runtime);
    inFlight = pending;
    const clear = () => {
      if (inFlight === pending) inFlight = null;
    };
    void pending.then(clear, clear);
    return pending;
  };
}

async function runCodexAccountRead(
  context: IpcContext,
  runtime: CodexAccountIpcRuntime,
): Promise<CodexAccountSnapshot> {
  const client = await startAccountClient(context, runtime);
  try {
    return await readAccount(client);
  } finally {
    await client.dispose();
  }
}

async function runCodexAccountOperation(
  context: IpcContext,
  runtime: CodexAccountIpcRuntime,
  operation: (
    client: CodexAccountClient,
    signal: AbortSignal,
    runtime: CodexAccountIpcRuntime,
  ) => Promise<CodexAccountSnapshot>,
): Promise<CodexAccountSnapshot> {
  return runManagedAppOperation(
    context.operations,
    {
      id: `codex-auth-${randomUUID()}`,
      kind: "codex-auth",
      mutatesLibrary: false,
    },
    async (signal) => {
      const client = await startAccountClient(context, runtime);
      const abort = () => void client.dispose();
      signal.addEventListener("abort", abort, { once: true });
      try {
        return await operation(client, signal, runtime);
      } finally {
        signal.removeEventListener("abort", abort);
        await client.dispose();
      }
    },
  );
}

function startAccountClient(
  context: IpcContext,
  runtime: CodexAccountIpcRuntime,
): Promise<CodexAccountClient> {
  return runtime.startClient({
    paths: context.appPaths,
    appVersion: runtime.appVersion(),
  });
}

async function readAccount(
  client: CodexAccountClient,
): Promise<CodexAccountSnapshot> {
  return readAccountSnapshot(client, false);
}

async function loginAccount(
  client: CodexAccountClient,
  signal: AbortSignal,
  runtime: CodexAccountIpcRuntime,
): Promise<CodexAccountSnapshot> {
  const login = await client.startChatGptLogin();
  try {
    assertOfficialLoginUrl(login.authUrl);
    await runtime.openExternal(login.authUrl);
    await client.waitForLogin(login.loginId, signal);
  } catch (error) {
    await client.cancelLogin(login.loginId);
    throw error;
  }
  return readAccountSnapshot(client, true);
}

async function logoutAccount(
  client: CodexAccountClient,
): Promise<CodexAccountSnapshot> {
  await client.logout();
  return readAccountSnapshot(client, false);
}

async function readAccountSnapshot(
  client: CodexAccountClient,
  refreshToken: boolean,
): Promise<CodexAccountSnapshot> {
  const account = await client.readAccount(refreshToken);
  const models = account.account
    ? normalizeAccountModels(await client.listModels())
    : [];
  return toSnapshot(account, client.version, models);
}

function toSnapshot(
  result: CodexAppServerAccountResult,
  appServerVersion: string,
  models: CodexAccountModel[],
): CodexAccountSnapshot {
  const account = result.account;
  if (!account) {
    return {
      authenticated: false,
      accountKind: null,
      email: null,
      planType: null,
      requiresOpenaiAuth: result.requiresOpenaiAuth,
      appServerVersion,
      models,
    };
  }
  if (account.type === "chatgpt") {
    return {
      authenticated: true,
      accountKind: "chatgpt",
      email: account.email,
      planType: account.planType,
      requiresOpenaiAuth: result.requiresOpenaiAuth,
      appServerVersion,
      models,
    };
  }
  return {
    authenticated: true,
    accountKind: account.type === "apiKey" ? "api-key" : "amazon-bedrock",
    email: null,
    planType: null,
    requiresOpenaiAuth: result.requiresOpenaiAuth,
    appServerVersion,
    models,
  };
}

function normalizeAccountModels(
  models: readonly CodexAppServerModel[],
): CodexAccountModel[] {
  return models.flatMap((model) => {
    if (model.hidden) return [];
    const efforts = model.supportedReasoningEfforts.filter(
      isCodexReasoningEffort,
    );
    const defaultEffort =
      isCodexReasoningEffort(model.defaultReasoningEffort) &&
      efforts.includes(model.defaultReasoningEffort)
        ? model.defaultReasoningEffort
        : efforts[0];
    if (!defaultEffort || efforts.length === 0) return [];
    return [
      {
        id: model.id,
        displayName: model.displayName,
        supportedReasoningEfforts: efforts,
        defaultReasoningEffort: defaultEffort,
        isDefault: model.isDefault,
      },
    ];
  });
}

function isCodexReasoningEffort(value: string): value is CodexReasoningEffort {
  return CODEX_REASONING_EFFORTS.some((effort) => effort === value);
}

function assertOfficialLoginUrl(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch (error) {
    throw new Error("Codex App Server 로그인 URL이 올바르지 않습니다.", {
      cause: error,
    });
  }
  if (
    parsed.protocol !== "https:" ||
    !isAllowedOpenAiHostname(parsed.hostname)
  ) {
    throw new Error(
      "Codex App Server가 허용되지 않은 로그인 URL을 반환했습니다.",
    );
  }
}

function isAllowedOpenAiHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return ["openai.com", "chatgpt.com"].some(
    (root) => normalized === root || normalized.endsWith(`.${root}`),
  );
}
