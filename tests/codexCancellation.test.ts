import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { AppPaths } from "../src/main/appPaths";
import {
  CodexAppServerClient,
  type CodexAppServerClientStartRuntime,
} from "../src/main/codexAppServerClient";

const roots: string[] = [];
const clients: CodexAppServerClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.dispose(true)));
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

// External App Server protocol boundary: deliberately withhold remote acknowledgements.
function fixture(stall = "completion") {
  const root = mkdtempSync(join(tmpdir(), "manga-cancel-"));
  roots.push(root);
  const audit = join(root, "audit.json");
  writeFileSync(audit, "[]");
  const server = join(root, "server.cjs");
  writeFileSync(
    server,
    `
const fs=require('node:fs'),rl=require('node:readline').createInterface({input:process.stdin});
const messages=[];rl.on('line',line=>{const m=JSON.parse(line);messages.push(m);fs.writeFileSync(${JSON.stringify(audit)},JSON.stringify(messages));
if(m.method===${JSON.stringify(stall)}||['turn/interrupt','thread/delete'].includes(m.method))return;
const result=m.method==='thread/start'?{thread:{id:'thread-cancel'}}:m.method==='turn/start'?{turn:{id:'turn-cancel'}}:m.method==='account/read'?{requiresOpenaiAuth:true,account:{type:'chatgpt',email:'test@example.com',planType:'plus'}}:{};
if(m.id!==undefined)process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');});
`,
  );
  const paths = {
    dataRoot: root,
    codexHomeDir: root,
    codexWorkspaceDir: root,
    isPackaged: false,
    resourcesDir: root,
  } as AppPaths;
  const runtime: CodexAppServerClientStartRuntime = {
    resolveBinary: () => ({
      executablePath: process.execPath,
      packageVersion: "test",
      source: "packaged",
      packageName: "@openai/codex-win32-x64",
      triple: "x86_64-pc-windows-msvc",
      executableName: "codex.exe",
    }),
    spawnAppServer: () =>
      spawn(process.execPath, [server], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      }),
  };
  const messages = (): Array<{ method: string; params?: unknown }> =>
    JSON.parse(readFileSync(audit, "utf8"));
  return { paths, runtime, messages, root };
}

it.each(["initialize", "thread/start", "turn/start", "completion"])(
  "immediately aborts its owned process while waiting for %s",
  async (stall) => {
    const f = fixture(stall),
      controller = new AbortController();
    const work = (async () => {
      const client = await CodexAppServerClient.start(
        { paths: f.paths, appVersion: "test", signal: controller.signal },
        f.runtime,
      );
      clients.push(client);
      return client.runEphemeralTurn({
        model: "gpt-6-astra",
        effort: "low",
        instructions: "test",
        cwd: f.root,
        input: [{ type: "text", text: "test" }],
        signal: controller.signal,
      });
    })();
    const rejected = expect(work).rejects.toThrow();
    await expect
      .poll(() =>
        f
          .messages()
          .some(
            (m) => m.method === (stall === "completion" ? "turn/start" : stall),
          ),
      )
      .toBe(true);
    const started = performance.now();
    controller.abort();
    await rejected;
    expect(performance.now() - started).toBeLessThan(500);
  },
);

it("interrupts the correct turn without waiting for acknowledgement or closing a shared client", async () => {
  const f = fixture(),
    controller = new AbortController();
  const client = await CodexAppServerClient.start(
    { paths: f.paths, appVersion: "test" },
    f.runtime,
  );
  clients.push(client);
  const work = client.runEphemeralTurn({
    model: "gpt-6-astra",
    effort: "low",
    instructions: "test",
    cwd: f.root,
    input: [{ type: "text", text: "test" }],
    signal: controller.signal,
  });
  const rejected = expect(work).rejects.toThrow();
  await expect
    .poll(() => f.messages().some((m) => m.method === "turn/start"))
    .toBe(true);
  const started = performance.now();
  controller.abort();
  await rejected;
  expect(performance.now() - started).toBeLessThan(500);
  await expect
    .poll(() => f.messages().find((m) => m.method === "turn/interrupt")?.params)
    .toEqual({ threadId: "thread-cancel", turnId: "turn-cancel" });
  expect((await client.readAccount()).account?.type).toBe("chatgpt");
});
