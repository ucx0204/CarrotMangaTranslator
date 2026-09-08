import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it.each([false, true])(
  "drains a real Writable during disposal (pending write fails: %s)",
  async (fails) => {
    const modulePath = resolve(
      "src/main/runtime/transport/llama-server-output.cjs",
    );
    // A separate Node process detects an unhandled stream error without adding
    // a test-owned error listener that would conceal the production defect.
    const script = `
    const { Writable } = require('node:stream');
    const { createServerOutputTransport } = require(${JSON.stringify(modulePath)});
    const progress = [];
    const sink = new Writable({ write(chunk, encoding, callback) {
      setImmediate(() => callback(${fails ? "new Error('pending log write failed')" : "null"}));
    }});
    const transport = createServerOutputTransport(
      {label:'test', modelFile:'fixture.gguf', onProgress:e=>progress.push(e)},
      {stream:sink, header:[]},
      {stdout:{write(){}}, stderr:{write(){}}}
    );
    transport.record('stdout', 'before disposal');
    transport.dispose();
    transport.dispose();
    sink.once('close', () => setImmediate(() => {
      process.stdout.write(JSON.stringify({
        closed:sink.closed,
        listeners:sink.listenerCount('error'),
        failures:(transport.recent.stderr.match(/server-log-disabled/g)||[]).length
      }));
    }));
  `;
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      ["-e", script],
      { timeout: 5000 },
    );
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual({
      closed: true,
      listeners: 0,
      failures: fails ? 1 : 0,
    });
  },
);
