import { createReadStream, type ReadStream } from "node:fs";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { exportHttpFixture } from "./mcpExportHttp.fixture";
import { handleMcpArtifact } from "../src/main/mcp/mcpArtifactHttp";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) };
});

/** Controlled filesystem boundary; the HTTP handler, pipeline and store are real. */
function diskBoundary(input: PassThrough): ReadStream {
  return Object.assign(input, {
    bytesRead: 0,
    path: "fixture-read-stream",
    pending: false,
    close(callback?: (error?: NodeJS.ErrnoException | null) => void) {
      input.destroy();
      callback?.();
    },
  });
}

async function zipFile(f: Awaited<ReturnType<typeof exportHttpFixture>>) {
  const source = await f.store.put(Buffer.from("fixture PNG"), async () => {});
  return f.store.zip(
    [{ url: source.url, filename: "0001.png" }],
    {},
    async () => {},
    new AbortController().signal,
  );
}

it("does not write headers when the client already closed during file validation", async () => {
  const f = await exportHttpFixture();
  const socket = new Socket();
  try {
    const source = await f.store.put(Buffer.from("fixture PNG"), async () => {});
    const request = new IncomingMessage(socket);
    request.method = "GET";
    request.url = new URL(source.url).pathname;
    const response = new ServerResponse(request);
    response.destroy();
    expect(await handleMcpArtifact(f.store, request, response)).toBe(true);
    expect(response.headersSent).toBe(false);
  } finally {
    socket.destroy();
    await f.close();
  }
});

it("stops a partially transferred ZIP when its reader fails without appending JSON", async () => {
  const f = await exportHttpFixture();
  const input = new PassThrough();
  try {
    const file = await zipFile(f);
    vi.mocked(createReadStream).mockClear();
    vi.mocked(createReadStream).mockReturnValueOnce(diskBoundary(input));
    const pending = f.send(new URL(file.url).pathname);
    await vi.waitFor(() => expect(createReadStream).toHaveBeenCalledOnce());
    input.write(Buffer.from("P"));
    const response = await pending;
    expect(response.status).toBe(200);
    const body = response.arrayBuffer();
    const rejected = expect(body).rejects.toThrow();
    const failure = Object.assign(new Error("fixture stream read failure"), {
      code: "EIO",
    });
    input.destroy(failure);
    await rejected;
    await vi.waitFor(() => expect(f.reportError).toHaveBeenCalledWith(failure));
    expect(input.destroyed).toBe(true);
  } finally {
    input.destroy();
    await f.close();
  }
});

it("cleans up an abandoned ZIP download without treating client cancellation as an app failure", async () => {
  const f = await exportHttpFixture();
  const input = new PassThrough();
  try {
    const file = await zipFile(f);
    vi.mocked(createReadStream).mockClear();
    vi.mocked(createReadStream).mockReturnValueOnce(diskBoundary(input));
    const pending = f.send(new URL(file.url).pathname);
    await vi.waitFor(() => expect(createReadStream).toHaveBeenCalledOnce());
    input.write(Buffer.from("P"));
    const response = await pending;
    if (!response.body) throw new Error("The ZIP response must have a body.");
    const reader = response.body.getReader();
    expect((await reader.read()).value).toEqual(new Uint8Array([80]));
    await reader.cancel();
    // Allow the socket close to reach the server before releasing the paused disk boundary.
    await delay(30);
    input.end();
    await vi.waitFor(() => expect(input.destroyed).toBe(true));
    expect(f.reportError).not.toHaveBeenCalled();
  } finally {
    input.destroy();
    await f.close();
  }
});
