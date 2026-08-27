import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppPaths } from "../src/main/appPaths";
import {
  CODEX_APP_SERVER_ARGUMENTS,
  CodexAppServerClient,
  type CodexAppServerClientStartRuntime,
} from "../src/main/codexAppServerClient";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("CodexAppServerClient", () => {
  it("uses the official protocol for login, model discovery, and an isolated ephemeral turn", async () => {
    const root = mkdtempSync(join(tmpdir(), "mgt-codex-client-test-"));
    temporaryDirectories.push(root);
    const fixturePath = join(root, "fake-app-server.cjs");
    const auditPath = join(root, "audit.json");
    writeFileSync(fixturePath, fakeAppServerSource(), "utf8");
    const paths = createAppPaths(root);
    let capturedArgs: readonly string[] = [];
    let capturedEnvironment: NodeJS.ProcessEnv = {};
    const runtime: CodexAppServerClientStartRuntime = {
      resolveBinary: () => ({
        executablePath: "fake-codex",
        packageVersion: "0.150.1",
        source: "packaged",
        packageName: "@openai/codex-win32-x64",
        triple: "x86_64-pc-windows-msvc",
        executableName: "codex.exe",
      }),
      spawnAppServer: (_executablePath, args, options) => {
        capturedArgs = args;
        capturedEnvironment = options.env;
        return spawn(process.execPath, [fixturePath], {
          cwd: options.cwd,
          env: { ...options.env, FAKE_CODEX_AUDIT_PATH: auditPath },
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
      },
    };
    const previousOpenAiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "must-not-reach-child";
    const client = await CodexAppServerClient.start(
      { paths, appVersion: "1.20.2-test" },
      runtime,
    );
    restoreEnvironmentValue("OPENAI_API_KEY", previousOpenAiKey);

    try {
      await expect(client.readAccount(false)).resolves.toEqual({
        account: {
          type: "chatgpt",
          email: "reader@example.com",
          planType: "plus",
        },
        requiresOpenaiAuth: true,
      });
      const login = await client.startChatGptLogin();
      expect(login).toEqual({
        loginId: "login-1",
        authUrl: "https://auth.openai.com/oauth/authorize",
      });
      await expect(client.waitForLogin(login.loginId)).resolves.toBeUndefined();
      await expect(client.listModels()).resolves.toEqual([
        {
          id: "gpt-test",
          displayName: "GPT Test",
          hidden: false,
          supportedReasoningEfforts: ["low", "high"],
          defaultReasoningEffort: "low",
          isDefault: true,
        },
      ]);
      const workspaceDir = paths.codexWorkspaceDir;
      if (!workspaceDir) throw new Error("Expected a Codex workspace path");
      await expect(
        client.runEphemeralTurn({
          model: "gpt-test",
          effort: "high",
          instructions: "Return JSON only.",
          input: [
            { type: "text", text: "translate" },
            { type: "image", url: "data:image/png;base64,AA==" },
          ],
          cwd: workspaceDir,
          outputSchema: {
            type: "object",
            properties: { translated: { type: "string" } },
          },
        }),
      ).resolves.toEqual({
        text: '{"translated":"ok"}',
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "message-final",
      });
    } finally {
      await client.dispose();
    }

    expect(capturedArgs).toEqual(CODEX_APP_SERVER_ARGUMENTS);
    expect(capturedArgs).toEqual(
      expect.arrayContaining([
        'cli_auth_credentials_store="file"',
        'history.persistence="none"',
        "project_doc_max_bytes=0",
        "browser_use",
        "shell_tool",
      ]),
    );
    expect(capturedEnvironment.CODEX_HOME).toBe(paths.codexHomeDir);
    expect(capturedEnvironment.OPENAI_API_KEY).toBeUndefined();

    const messages = JSON.parse(readFileSync(auditPath, "utf8")) as Array<
      Record<string, unknown>
    >;
    expect(messages.every((message) => !("jsonrpc" in message))).toBe(true);
    expect(findRequest(messages, "initialize")).toMatchObject({
      params: {
        clientInfo: {
          name: "carrot_manga_translator",
          version: "1.20.2-test",
        },
      },
    });
    expect(findRequest(messages, "thread/start")).toMatchObject({
      params: {
        approvalPolicy: "never",
        sandbox: "read-only",
        ephemeral: true,
        config: {
          project_doc_max_bytes: 0,
          include_environment_context: false,
          features: {
            apps: false,
            plugins: false,
            shell_tool: false,
            unified_exec: false,
          },
        },
      },
    });
    expect(findRequest(messages, "turn/start")).toMatchObject({
      params: {
        threadId: "thread-1",
        effort: "high",
        input: [
          { type: "text", text: "translate", text_elements: [] },
          { type: "image", url: "data:image/png;base64,AA==" },
        ],
      },
    });
    expect(findRequest(messages, "thread/delete")).toMatchObject({
      params: { threadId: "thread-1" },
    });
  });
});

function createAppPaths(root: string): AppPaths {
  return {
    isPackaged: true,
    repoRoot: root,
    executableDir: root,
    resourcesDir: root,
    dataRoot: root,
    settingsPath: join(root, "settings.json"),
    libraryDir: join(root, "library"),
    fontsDir: join(root, "fonts"),
    logsDir: join(root, "logs"),
    logFile: join(root, "logs", "app.log"),
    runtimeDir: join(root, "runtime"),
    toolsDir: join(root, "tools"),
    ocrRuntimeDir: join(root, "ocr-runtime"),
    llamaRuntimeDir: join(root, "llama"),
    llamaServerPath: join(root, "llama", "llama-server"),
    codexHomeDir: join(root, "codex-home"),
    codexWorkspaceDir: join(root, "workspace"),
  };
}

function findRequest(
  messages: Array<Record<string, unknown>>,
  method: string,
): Record<string, unknown> | undefined {
  return messages.find((message) => message.method === method);
}

function restoreEnvironmentValue(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function fakeAppServerSource(): string {
  return String.raw`
const { writeFileSync } = require("node:fs");
const { createInterface } = require("node:readline");
const messages = [];
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const fail = (id, message) => send({ id, error: { code: -32000, message } });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  messages.push(message);
  const params = message.params || {};
  switch (message.method) {
    case "initialize":
      send({ id: message.id, result: { serverInfo: { name: "fake" } } });
      break;
    case "initialized":
      break;
    case "account/read":
      send({
        id: message.id,
        result: {
          account: { type: "chatgpt", email: "reader@example.com", planType: "plus" },
          requiresOpenaiAuth: true,
        },
      });
      break;
    case "account/login/start":
      send({
        method: "account/login/completed",
        params: { loginId: "login-1", success: true, error: null },
      });
      send({
        id: message.id,
        result: {
          type: "chatgpt",
          loginId: "login-1",
          authUrl: "https://auth.openai.com/oauth/authorize",
        },
      });
      break;
    case "model/list":
      send({
        id: message.id,
        result: {
          data: [{
            id: "gpt-test",
            displayName: "GPT Test",
            hidden: false,
            supportedReasoningEfforts: [
              { reasoningEffort: "low" },
              { reasoningEffort: "high" },
            ],
            defaultReasoningEffort: "low",
            isDefault: true,
          }],
          nextCursor: null,
        },
      });
      break;
    case "thread/start":
      if (
        params.approvalPolicy !== "never" ||
        params.sandbox !== "read-only" ||
        params.ephemeral !== true ||
        params.config?.project_doc_max_bytes !== 0
      ) {
        fail(message.id, "thread was not isolated");
        break;
      }
      send({ id: message.id, result: { thread: { id: "thread-1" } } });
      break;
    case "turn/start":
      if (
        params.input?.[0]?.text_elements?.length !== 0 ||
        params.outputSchema?.properties?.translated?.type !== "string"
      ) {
        fail(message.id, "turn input was not translated");
        break;
      }
      send({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: {
            id: "turn-1",
            status: "completed",
            items: [
              { type: "agentMessage", id: "commentary", text: "working", phase: "commentary" },
              { type: "agentMessage", id: "message-final", text: "{\"translated\":\"ok\"}", phase: "final_answer" },
            ],
          },
        },
      });
      send({ id: message.id, result: { turn: { id: "turn-1" } } });
      break;
    case "thread/delete":
      send({ id: message.id, result: {} });
      break;
    default:
      if (message.id !== undefined) fail(message.id, "unsupported " + message.method);
  }
});
lines.on("close", () => {
  writeFileSync(process.env.FAKE_CODEX_AUDIT_PATH, JSON.stringify(messages));
});
`;
}
