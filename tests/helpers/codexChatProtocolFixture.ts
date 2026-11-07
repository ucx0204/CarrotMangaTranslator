import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import type { AppPaths } from "../../src/main/appPaths";
import { CodexChatRuntime } from "../../src/main/chat/codexChatRuntime";
import type { CodexAppServerClientStartRuntime } from "../../src/main/codexAppServerClient";

export async function codexChatProtocolFixture(mode = "normal") {
  const root = await mkdtemp(join(tmpdir(), "carrot-chat-protocol-"));
  const script = join(root, "server.cjs"),
    audit = join(root, "audit.jsonl");
  await writeFile(script, fixtureSource);
  let argumentsUsed: readonly string[] = [];
  const events = { notification: vi.fn(), failed: vi.fn(), question: vi.fn() };
  const deletionRuntime: CodexAppServerClientStartRuntime = {
    resolveBinary: () => ({
      executablePath: "codex",
      packageVersion: "0.167.0",
      source: "packaged" as const,
      packageName: "@openai/codex-win32-x64",
      triple: "x86_64-pc-windows-msvc",
      executableName: "codex.exe",
    }),
    spawnAppServer: (
      _path: string,
      _args: readonly string[],
      options: { cwd: string; env: NodeJS.ProcessEnv },
    ) =>
      spawn(process.execPath, [script], {
        ...options,
        env: { ...options.env, CHAT_TEST_AUDIT: audit, CHAT_TEST_MODE: mode },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      }),
  };
  const runtime = await CodexChatRuntime.start(
    paths(root),
    "test",
    { url: "http://127.0.0.1:12345/mcp", token: "private-test-token" },
    events,
    {
      resolveBinary: () => ({
        executablePath: "codex",
        packageVersion: "0.167.0",
        source: "packaged",
        packageName: "@openai/codex-win32-x64",
        triple: "x86_64-pc-windows-msvc",
        executableName: "codex.exe",
      }),
      spawnAppServer: (_path, args, options) => {
        argumentsUsed = args;
        return spawn(process.execPath, [script], {
          ...options,
          env: { ...options.env, CHAT_TEST_AUDIT: audit, CHAT_TEST_MODE: mode },
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
      },
    },
  );
  return {
    runtime,
    events,
    deleteThread: (id: string) =>
      CodexChatRuntime.deleteThread(paths(root), "test", id, deletionRuntime),
    args: () => argumentsUsed,
    audit: async () =>
      (await readFile(audit, "utf8"))
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              method: string;
              params: Record<string, unknown>;
            },
        ),
    close: async () => {
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
function paths(root: string): AppPaths {
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
    logFile: join(root, "app.log"),
    runtimeDir: join(root, "runtime"),
    toolsDir: join(root, "tools"),
    ocrRuntimeDir: join(root, "ocr"),
    llamaRuntimeDir: join(root, "llama"),
    llamaServerPath: join(root, "llama-server"),
    codexHomeDir: join(root, "codex"),
    codexWorkspaceDir: join(root, "workspace"),
  };
}
const fixtureSource = `
const fs = require('node:fs'), mode = process.env.CHAT_TEST_MODE;
const emit = value => process.stdout.write(JSON.stringify(value)+'\\n');
let turn = 0;
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line); fs.appendFileSync(process.env.CHAT_TEST_AUDIT,JSON.stringify(m)+'\\n');
 if(m.id === undefined) return;
 const reply = result => emit({id:m.id,result});
 const notification = (method,params) => emit({method,params:{threadId:'persistent',...params}});
 if(m.method==='initialize') return reply({userAgent:'codex/0.167.0'});
 if(m.method==='thread/delete') {
  if(mode==='missing'||mode==='delete-failure') return emit({id:m.id,error:{code:-32600,message:mode==='missing'?'no rollout found for thread id '+m.params.threadId:'disk permission denied'}});
  return reply({});
 }
 if(m.method==='account/read') return reply({account:{type:'chatgpt',email:'test@example.com',planType:'plus'},requiresOpenaiAuth:true});
 if(m.method==='thread/start'||m.method==='thread/resume') return reply({thread:{id:'persistent'}});
 if(m.method==='turn/start') {
  const id='turn-'+(++turn);
  if(mode==='completed-before-ack') notification('turn/completed',{turn:{id,status:'completed'}});
  return setTimeout(()=>reply({turn:{id,status:mode==='completed-before-ack'?'completed':'inProgress'}}),mode==='slow-start'?100:0);
 }
 if(m.method==='turn/steer') {
  if(mode==='ended'||mode==='uncertain') return emit({id:m.id,error:{code:-1,message:mode==='ended'?'no active turn':'connection status unknown'}});
  return reply({turnId:'turn-'+turn});
 }
 if(m.method==='turn/interrupt') {notification('turn/completed',{turn:{id:'turn-'+turn,status:'interrupted'}});return reply({});}
 if(m.method==='thread/compact/start') {notification('thread/compacted',{});return reply({});}
 reply({});
});
`;
