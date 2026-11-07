import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import type { AppPaths } from "../src/main/appPaths";
import {
  CodexAppServerClient,
  type CodexAppServerClientStartRuntime,
} from "../src/main/codexAppServerClient";
import { asRecord } from "../src/main/codexAppServerProtocol";
import { CodexChatRuntime } from "../src/main/chat/codexChatRuntime";

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: () => process.cwd(),
    getLocale: () => "ko",
  },
}));
const executable = resolve(
  "node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe",
);

it.runIf(process.platform === "win32" && existsSync(executable))(
  "deletes a persisted thread with the real bundled Codex while preserving another thread and user files",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "carrot-codex-deletion-"));
    const paths = {
      dataRoot: root,
      codexHomeDir: join(root, "codex"),
    } as AppPaths;
    const runtime: CodexAppServerClientStartRuntime = {
      resolveBinary: () => ({
        executablePath: executable,
        packageVersion: "0.167.0",
        source: "packaged",
        packageName: "@openai/codex-win32-x64",
        triple: "x86_64-pc-windows-msvc",
        executableName: "codex.exe",
      }),
      spawnAppServer: (binary, args, options) =>
        spawn(binary, [...args], {
          ...options,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        }),
    };
    const preserved = [
      "original.png",
      "library/page.png",
      "outputs/page.png",
      "codex/preferences-sentinel",
    ];
    let client: CodexAppServerClient | undefined;
    try {
      for (const name of preserved) {
        await mkdir(join(root, name, ".."), { recursive: true });
        await writeFile(join(root, name), `preserve:${name}`);
      }
      client = await CodexAppServerClient.start(
        { paths, appVersion: "test", capability: "typesetting-preview" },
        runtime,
      );
      const connection = client.connection;
      const create = async () => {
        const response = asRecord(
          await connection.request("thread/start", {
            cwd: root,
            ephemeral: false,
            approvalPolicy: "never",
            sandbox: "read-only",
            serviceName: "carrot_global_chat",
          }),
        );
        const thread = asRecord(response?.thread);
        if (typeof thread?.id !== "string" || typeof thread.path !== "string")
          throw new Error("Missing persisted thread");
        // Persist local history without running a model or using an account.
        await connection.request("thread/inject_items", {
          threadId: thread.id,
          items: [
            {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "cleanup fixture" }],
            },
          ],
        });
        return { id: thread.id, path: thread.path };
      };
      const selected = await create(),
        other = await create();
      await client.dispose();
      client = undefined;
      expect((await stat(selected.path)).isFile()).toBe(true);
      const otherBytes = await readFile(other.path);
      await CodexChatRuntime.deleteThread(paths, "test", selected.id, runtime);
      await expect(stat(selected.path)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await readFile(other.path)).toEqual(otherBytes);
      await CodexChatRuntime.deleteThread(paths, "test", selected.id, runtime);
      for (const name of preserved)
        expect(await readFile(join(root, name), "utf8")).toBe(
          `preserve:${name}`,
        );
    } finally {
      await client?.dispose();
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
    }
  },
  30_000,
);
