import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonLinesWorkerClient } from "../src/main/runtimeSupport/jsonLinesWorkerClient";

// stdout에 ANSI CUDA 경고 라인을 섞어 내보낸 뒤 정상 JSON 응답을 주는 워커.
const NOISE_THEN_RESPONSE_SCRIPT = `
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    let req;
    try { req = JSON.parse(line); } catch (e) { continue; }
    process.stdout.write("\\u001b[31m[CUDA] no-op driver warning\\u001b[0m noise\\n");
    process.stdout.write(JSON.stringify({ id: req.id, ok: true }) + "\\n");
  }
});
`;

// { 로 시작하지만 malformed JSON인 라인을 내보내는 워커 (진짜 프로토콜 오류).
const MALFORMED_SCRIPT = `
process.stdin.setEncoding("utf8");
process.stdin.on("data", () => {
  process.stdout.write("{bad json\\n");
});
`;

function makeWorkerDir(script: string): { dir: string; scriptPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "jlwc-"));
  const scriptPath = join(dir, "worker.js");
  writeFileSync(scriptPath, script);
  return { dir, scriptPath };
}

function makeClient(scriptPath: string) {
  return new JsonLinesWorkerClient<{ type: string }>({
    executable: process.execPath,
    args: [scriptPath],
    env: process.env,
    workerName: "Test 워커",
    requestTimeoutMs: 5000,
    buildExitError: (code, stderr) => new Error(`exit ${code} ${stderr}`),
    buildNotRunningError: (stderr) => new Error(`not running ${stderr}`),
    sanitizeStderr: (text) => text,
    onStderr: () => {},
  });
}

describe("JsonLinesWorkerClient", () => {
  it("survives non-JSON stdout noise (CUDA warnings with ANSI) and still resolves the response", async () => {
    const { dir, scriptPath } = makeWorkerDir(NOISE_THEN_RESPONSE_SCRIPT);
    const client = makeClient(scriptPath);
    try {
      const handle = client.startRequest({ type: "ping" });
      const response = await handle.response;
      expect(response.ok).toBe(true);
      expect(response.id).toBe(handle.id);
    } finally {
      await client.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails the protocol when a { -prefixed line is malformed JSON", async () => {
    const { dir, scriptPath } = makeWorkerDir(MALFORMED_SCRIPT);
    const client = makeClient(scriptPath);
    try {
      const handle = client.startRequest({ type: "ping" });
      await expect(handle.response).rejects.toThrow(/응답 프로토콜 오류/);
    } finally {
      await client.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("surfaces the executable path and hint when spawn fails", async () => {
    const client = new JsonLinesWorkerClient<{ type: string }>({
      executable: "/does/not/exist/mgt-flux-klein.exe",
      args: ["--cuda-runtime-dir", "/missing"],
      env: process.env,
      workerName: "Flux 인페인팅 런타임",
      buildExitError: (code, stderr) => new Error(`exit ${code} ${stderr}`),
      buildNotRunningError: (stderr) => new Error(`not running ${stderr}`),
      sanitizeStderr: (text) => text,
      onStderr: () => {},
    });
    try {
      const handle = client.startRequest({ type: "ping" });
      await expect(handle.response).rejects.toThrow(
        /실행 파일을 시작하지 못했습니다.*\/does\/not\/exist\/mgt-flux-klein\.exe/,
      );
    } finally {
      await client.dispose();
    }
  });
});
