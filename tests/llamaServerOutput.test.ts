import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";

type ProgressEvent = Record<string, unknown>;
type OutputTransport = {
  dispose: () => void;
  recent: { stdout: string; stderr: string };
  record: (stream: "stdout" | "stderr", chunk: unknown) => void;
  stopStartupForwarding: () => void;
};
type ParentOutput = {
  write: (chunk: string, callback?: (error?: Error | null) => void) => unknown;
  on?: (event: "error", listener: (error: unknown) => void) => unknown;
  off?: (event: "error", listener: (error: unknown) => void) => unknown;
  removeListener?: (
    event: "error",
    listener: (error: unknown) => void,
  ) => unknown;
};
type ServerLogOutput = ParentOutput & {
  end?: (callback?: (error?: Error | null) => void) => unknown;
};
type ServerLogTarget = {
  stream: ServerLogOutput | null;
  header: string[];
  creationError?: unknown;
};

const { createServerOutputTransport } =
  require("../src/main/runtime/transport/llama-server-output.cjs") as {
    createServerOutputTransport: (
      options: {
        label: string;
        modelFile: string;
        onProgress: (event: ProgressEvent) => void;
      },
      serverLogTarget: ServerLogTarget | null,
      parentOutput: {
        stdout: ParentOutput;
        stderr: ParentOutput;
      },
    ) => OutputTransport;
  };
const { startServer, stopServer } =
  require("../src/main/runtime/transport/llama-server-process.cjs") as {
    startServer: (options: Record<string, unknown>) => Promise<{
      baseUrl: string;
      child: null;
      startedByScript: boolean;
    }>;
    stopServer: (server: null) => Promise<void>;
  };

describe("llama server output transport", () => {
  it("treats an absent server process as already stopped", async () => {
    await expect(stopServer(null)).resolves.toBeUndefined();
  });

  it("reuses an explicitly authorized reachable server without relaunching", async () => {
    const server = createServer((_request, response) => {
      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
      response.end('{"data":[]}');
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("test server did not expose a TCP port");
    }
    const previousReuse = process.env.MGT_ALLOW_LLAMA_SERVER_REUSE;
    process.env.MGT_ALLOW_LLAMA_SERVER_REUSE = "1";
    try {
      await expect(
        startServer({ port: address.port, reuseServer: true }),
      ).resolves.toEqual({
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        child: null,
        startedByScript: false,
      });
    } finally {
      if (previousReuse === undefined) {
        delete process.env.MGT_ALLOW_LLAMA_SERVER_REUSE;
      } else {
        process.env.MGT_ALLOW_LLAMA_SERVER_REUSE = previousReuse;
      }
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("keeps diagnostics after readiness without mirroring inference output", () => {
    const progress: ProgressEvent[] = [];
    const serverLog: string[] = [];
    const parentStdout: string[] = [];
    const parentStderr: string[] = [];
    const transport = createServerOutputTransport(
      {
        label: "translation",
        modelFile: "gemma.gguf",
        onProgress: (event) => progress.push(event),
      },
      makeServerLogTarget(serverLog),
      {
        stdout: { write: (chunk) => parentStdout.push(chunk) },
        stderr: { write: (chunk) => parentStderr.push(chunk) },
      },
    );

    transport.record("stdout", "loading model\n");
    transport.stopStartupForwarding();
    transport.record("stderr", "steady-state inference token stream\n");

    expect(parentStdout).toEqual([
      "[llama:translation:stdout] loading model\n",
    ]);
    expect(parentStderr).toEqual([]);
    expect(progress).toHaveLength(1);
    expect(progress[0]).toMatchObject({
      phase: "booting",
      installLogLine: "loading model",
    });
    expect(serverLog).toEqual([
      "[stdout] loading model\n",
      "[stderr] steady-state inference token stream\n",
    ]);
    expect(transport.recent.stdout).toContain("loading model");
    expect(transport.recent.stderr).toContain(
      "steady-state inference token stream",
    );
  });

  it("disables a parent stream once after EPIPE while startup diagnostics continue", () => {
    const progress: ProgressEvent[] = [];
    const serverLog: string[] = [];
    const stdout = new FakeOutputStream();
    const stderr = new FakeOutputStream();
    const transport = createServerOutputTransport(
      {
        label: "translation",
        modelFile: "gemma.gguf",
        onProgress: (event) => progress.push(event),
      },
      makeServerLogTarget(serverLog),
      { stdout, stderr },
    );

    transport.record("stdout", "first startup line\n");
    const failure = Object.assign(new Error("broken pipe"), { code: "EPIPE" });
    stdout.failLastWrite(failure);
    stdout.emit("error", failure);
    transport.record("stdout", "second startup line\n");
    transport.record("stderr", "stderr still visible\n");

    expect(stdout.writes).toEqual([
      "[llama:translation:stdout] first startup line\n",
    ]);
    expect(stderr.writes).toEqual([
      "[llama:translation:stderr] stderr still visible\n",
    ]);
    expect(progress).toHaveLength(3);
    expect(serverLog.join("")).toContain("[stdout] second startup line");
    expect(serverLog.join("").match(/parent-stdout-disabled/g)).toHaveLength(1);
    expect(serverLog.join("")).toContain("EPIPE");
    expect(transport.recent.stdout).toContain("second startup line");
    expect(transport.recent.stderr).toContain("parent-stdout-disabled");
  });

  it("contains synchronous parent write failures without stopping recording", () => {
    const progress: ProgressEvent[] = [];
    const serverLog: string[] = [];
    const stdout = new FakeOutputStream();
    stdout.nextFailure = new Error("stdout already closed");
    const transport = createServerOutputTransport(
      {
        label: "translation",
        modelFile: "gemma.gguf",
        onProgress: (event) => progress.push(event),
      },
      makeServerLogTarget(serverLog),
      { stdout, stderr: new FakeOutputStream() },
    );

    expect(() =>
      transport.record("stdout", "startup survives\n"),
    ).not.toThrow();
    expect(() =>
      transport.record("stdout", "recording survives\n"),
    ).not.toThrow();

    expect(stdout.writes).toEqual([]);
    expect(progress).toHaveLength(2);
    expect(serverLog.join("")).toContain("[stdout] startup survives");
    expect(serverLog.join("")).toContain("[stdout] recording survives");
    expect(serverLog.join("").match(/parent-stdout-disabled/g)).toHaveLength(1);
    expect(transport.recent.stdout).toContain("recording survives");
  });

  it("removes both parent error listeners with idempotent disposal", () => {
    const stdout = new FakeOutputStream();
    const stderr = new FakeOutputStream();
    const serverLog: string[] = [];
    const transport = createServerOutputTransport(
      {
        label: "translation",
        modelFile: "gemma.gguf",
        onProgress: () => undefined,
      },
      makeServerLogTarget(serverLog),
      { stdout, stderr },
    );

    expect(stdout.listenerCount("error")).toBe(1);
    expect(stderr.listenerCount("error")).toBe(1);
    transport.dispose();
    transport.dispose();

    expect(stdout.listenerCount("error")).toBe(0);
    expect(stderr.listenerCount("error")).toBe(0);
    expect(serverLog).toEqual([]);
  });

  it("does not accumulate listeners across repeated server lifecycles", () => {
    const stdout = new FakeOutputStream();
    const stderr = new FakeOutputStream();

    for (let index = 0; index < 25; index += 1) {
      const transport = createServerOutputTransport(
        {
          label: `translation-${index}`,
          modelFile: "gemma.gguf",
          onProgress: () => undefined,
        },
        makeServerLogTarget([]),
        { stdout, stderr },
      );
      expect(stdout.listenerCount("error")).toBe(1);
      expect(stderr.listenerCount("error")).toBe(1);
      transport.dispose();
      expect(stdout.listenerCount("error")).toBe(0);
      expect(stderr.listenerCount("error")).toBe(0);
    }
  });

  it("isolates an asynchronous server-log open failure from all live outputs", () => {
    const progress: ProgressEvent[] = [];
    const parentStdout: string[] = [];
    const file = new FakeServerLogStream();
    const transport = createServerOutputTransport(
      {
        label: "translation",
        modelFile: "gemma.gguf",
        onProgress: (event) => progress.push(event),
      },
      { stream: file, header: [] },
      {
        stdout: { write: (chunk) => parentStdout.push(chunk) },
        stderr: { write: () => undefined },
      },
    );

    expect(file.listenerCount("error")).toBe(1);
    file.emit(
      "error",
      Object.assign(new Error("open failed"), { code: "EIO" }),
    );
    transport.record("stdout", "server output survives\n");

    expect(file.writes).toEqual([]);
    expect(parentStdout).toEqual([
      "[llama:translation:stdout] server output survives\n",
    ]);
    expect(progress).toHaveLength(1);
    expect(transport.recent.stdout).toContain("server output survives");
    expect(transport.recent.stderr.match(/server-log-disabled/g)).toHaveLength(
      1,
    );
    transport.dispose();
    expect(file.listenerCount("error")).toBe(0);
    expect(file.endCalls).toBe(1);
  });

  it("disables a server-log sink after an asynchronous write error", () => {
    const progress: ProgressEvent[] = [];
    const file = new FakeServerLogStream();
    const transport = createServerOutputTransport(
      {
        label: "translation",
        modelFile: "gemma.gguf",
        onProgress: (event) => progress.push(event),
      },
      { stream: file, header: [] },
      {
        stdout: { write: () => undefined },
        stderr: { write: () => undefined },
      },
    );

    transport.record("stdout", "first output\n");
    file.failLastWrite(new Error("disk became unavailable"));
    transport.record("stdout", "second output\n");

    expect(file.writes).toEqual(["[stdout] first output\n"]);
    expect(progress).toHaveLength(2);
    expect(transport.recent.stdout).toContain("second output");
    expect(transport.recent.stderr.match(/server-log-disabled/g)).toHaveLength(
      1,
    );
    transport.dispose();
    expect(file.listenerCount("error")).toBe(0);
  });

  it("contains synchronous server-log writes and keeps recording", () => {
    const progress: ProgressEvent[] = [];
    const file = new FakeServerLogStream();
    file.nextFailure = new Error("synchronous disk failure");
    const transport = createServerOutputTransport(
      {
        label: "translation",
        modelFile: "gemma.gguf",
        onProgress: (event) => progress.push(event),
      },
      { stream: file, header: [] },
      {
        stdout: { write: () => undefined },
        stderr: { write: () => undefined },
      },
    );

    expect(() => transport.record("stderr", "first stderr\n")).not.toThrow();
    expect(() => transport.record("stderr", "second stderr\n")).not.toThrow();

    expect(file.writes).toEqual([]);
    expect(progress).toHaveLength(2);
    expect(transport.recent.stderr).toContain("second stderr");
    expect(transport.recent.stderr.match(/server-log-disabled/g)).toHaveLength(
      1,
    );
    transport.dispose();
    expect(file.listenerCount("error")).toBe(0);
  });
});

function makeServerLogTarget(lines: string[]): ServerLogTarget {
  return {
    stream: { write: (chunk) => lines.push(chunk) },
    header: [],
  };
}

class FakeOutputStream extends EventEmitter implements ParentOutput {
  readonly writes: string[] = [];
  nextFailure: Error | null = null;
  private lastCallback: ((error?: Error | null) => void) | null = null;

  write(chunk: string, callback?: (error?: Error | null) => void): boolean {
    if (this.nextFailure) {
      const failure = this.nextFailure;
      this.nextFailure = null;
      throw failure;
    }
    this.writes.push(chunk);
    this.lastCallback = callback ?? null;
    return true;
  }

  failLastWrite(error: Error): void {
    this.lastCallback?.(error);
  }
}

class FakeServerLogStream extends FakeOutputStream implements ServerLogOutput {
  endCalls = 0;

  end(callback?: (error?: Error | null) => void): void {
    this.endCalls += 1;
    callback?.();
  }
}
