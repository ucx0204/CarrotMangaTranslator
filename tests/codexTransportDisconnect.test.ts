import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it } from "vitest";
import { CodexAppServerTransport } from "../src/main/codexAppServerTransport";

// OS process/pipe boundary; the actual RPC transport handles all failures.
function childFixture() {
  const child = Object.assign(new ChildProcess(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null,
    killed: false,
    kill: () => {
      child.killed = true;
      child.exitCode = 0;
      child.emit("exit", 0, null);
      return true;
    },
  });
  return child as ChildProcessWithoutNullStreams;
}

describe("Codex pipe disconnections", () => {
  it.each(["stdin", "stdout", "stderr"] as const)(
    "rejects requests and turn waiters on %s failure without escaping through Electron",
    async (channel) => {
      const child = childFixture();
      const transport = new CodexAppServerTransport(child, "test");
      const results = Promise.allSettled([
        transport.request("initialize"),
        transport.waitForNotification(() => false, 30_000),
      ]);
      const error = Object.assign(new Error("read ENOTCONN"), {
        code: "ENOTCONN",
      });
      expect(() => child[channel].emit("error", error)).not.toThrow();
      for (const result of await results) {
        expect(result.status).toBe("rejected");
        if (result.status === "rejected")
          expect(result.reason.cause).toBe(error);
      }
      await expect(transport.request("account/read")).rejects.toThrow(
        "ENOTCONN",
      );
      await transport.dispose(true);
      expect(child.killed).toBe(true);
      for (const stream of [child.stdin, child.stdout, child.stderr])
        expect(() => stream.emit("error", error)).not.toThrow();
    },
  );
  it("turns a failed approval reply into a connection failure", async () => {
    const child = childFixture();
    const transport = new CodexAppServerTransport(child, "test");
    const result = Promise.allSettled([transport.request("initialize")]);
    child.stdin.destroy();
    expect(() =>
      child.stdout.emit(
        "data",
        Buffer.from(
          JSON.stringify({ id: "approval", method: "execCommandApproval" }) +
            "\n",
        ),
      ),
    ).not.toThrow();
    expect((await result)[0]).toMatchObject({ status: "rejected" });
    await transport.dispose(true);
  });
});
