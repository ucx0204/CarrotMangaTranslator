import { createHash } from "node:crypto";
import { createReadStream, type ReadStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { McpArtifactStore } from "../src/main/mcp/mcpArtifactStore";
import { startMcpHttpServer } from "../src/main/mcp/mcpHttpServer";

vi.mock("node:fs", async (load) => {
  const actual = await load<typeof import("node:fs")>();
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) };
});
vi.mock("node:fs/promises", async (load) => {
  const actual = await load<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

async function httpFixture() {
  const origin = "https://workfile.test";
  const store = new McpArtifactStore(origin);
  const bytes = Buffer.from(
    "native workfile fixture\u0000with original assets",
  );
  let allowed = true;
  const revoked = new Error("workfile grant revoked");
  let report: (error: unknown) => void = () => {};
  const reported = new Promise<unknown>((resolve) => {
    report = resolve;
  });
  const reportError = vi.fn((error: unknown) => report(error));
  const output = await store.putWorkFile(
    (path) => writeFile(path, bytes),
    1024,
    async () => {
      if (!allowed) throw revoked;
    },
    new AbortController().signal,
    [
      {
        chapterId: "chapter",
        pageId: "page",
        revision: "page-v1:0000000000000000",
      },
    ],
    { workId: "work", chapterIds: ["chapter"], snapshot: "0".repeat(16) },
  );
  const server = await startMcpHttpServer({
    config: { port: 0, token: "t".repeat(43), publicOrigin: origin },
    artifacts: store,
    tools: [],
    reportError,
  });
  return {
    store,
    output,
    bytes,
    reported,
    reportError,
    revoked,
    path: new URL(output.url).pathname,
    send: (path: string, init: RequestInit = {}) =>
      fetch(`${new URL(server.url).origin}${path}`, {
        ...init,
        redirect: "manual",
      }),
    revoke: () => {
      allowed = false;
    },
    close: async () => {
      store.stop();
      await server.close();
      await store.close();
    },
  };
}

/** Control only the disk reader; routing, HTTP headers, pipeline and store remain real. */
function controlledRead(input: PassThrough) {
  let started: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const disk: ReadStream = Object.assign(input, {
    bytesRead: 0,
    path: "workfile-test-stream",
    pending: false,
    close(callback?: (error?: NodeJS.ErrnoException | null) => void) {
      input.destroy();
      callback?.();
    },
  });
  vi.mocked(createReadStream).mockImplementationOnce(() => {
    started();
    return disk;
  });
  return ready;
}

it("serves workfiles with exact download headers, uses streams for GET and reads no body for HEAD", async () => {
  const f = await httpFixture();
  try {
    vi.mocked(createReadStream).mockClear();
    vi.mocked(readFile).mockClear();
    const head = await f.send(f.path, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe(
      "application/vnd.carrot.mgtshare",
    );
    expect(head.headers.get("content-disposition")).toBe(
      'attachment; filename="carrot-work.mgtshare"',
    );
    expect(Number(head.headers.get("content-length"))).toBe(f.bytes.length);
    expect(head.headers.get("cache-control")).toBe("no-store");
    expect(head.headers.get("referrer-policy")).toBe("no-referrer");
    expect(head.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await head.text()).toBe("");
    expect(createReadStream).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
    const response = await f.send(f.path);
    expect(response.status).toBe(200);
    const downloaded = Buffer.from(await response.arrayBuffer());
    expect(downloaded).toEqual(f.bytes);
    expect(createHash("sha256").update(downloaded).digest("hex")).toBe(
      f.output.sha256,
    );
    expect(createReadStream).toHaveBeenCalledOnce();
    expect(readFile).not.toHaveBeenCalled();
    await f.store.assertAvailable(f.output.url);
    expect(readFile).not.toHaveBeenCalled();
    expect(f.reportError).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it("binds the workfile suffix to its capability and denies malformed URLs and revoked access", async () => {
  const f = await httpFixture();
  try {
    for (const path of [
      f.path.replace("work.mgtshare", "pages.zip"),
      f.path.replace("work.mgtshare", "page.psd"),
      f.path.replace("work.mgtshare", "carrot-work.mgtshare"),
      `${f.path}?download=1`,
      `${f.path}/extra`,
    ])
      expect((await f.send(path)).status).toBe(404);
    expect((await f.send(f.path, { method: "POST" })).status).toBe(405);
    f.revoke();
    for (const method of ["GET", "HEAD"])
      expect((await f.send(f.path, { method })).status).toBe(404);
    expect(f.reportError).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it("aborts a partially streamed workfile when the disk reader fails without appending JSON", async () => {
  const f = await httpFixture();
  const input = new PassThrough();
  try {
    const ready = controlledRead(input);
    const pending = f.send(f.path);
    await ready;
    input.write(f.bytes.subarray(0, 1));
    const response = await pending;
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/vnd.carrot.mgtshare",
    );
    const rejected = expect(response.arrayBuffer()).rejects.toThrow();
    const failure = Object.assign(new Error("workfile disk failure"), {
      code: "EIO",
    });
    input.destroy(failure);
    await rejected;
    expect(await f.reported).toBe(failure);
    expect(input.destroyed).toBe(true);
  } finally {
    input.destroy();
    await f.close();
  }
});

it("rechecks workfile access during streaming and stops after a grant is revoked", async () => {
  const f = await httpFixture();
  const input = new PassThrough();
  try {
    const ready = controlledRead(input);
    const pending = f.send(f.path);
    await ready;
    input.write(f.bytes.subarray(0, 1));
    const response = await pending;
    expect(response.status).toBe(200);
    const rejected = expect(response.arrayBuffer()).rejects.toThrow();
    f.revoke();
    input.end(f.bytes.subarray(1));
    await rejected;
    expect(await f.reported).toBe(f.revoked);
    expect(input.destroyed).toBe(true);
  } finally {
    input.destroy();
    await f.close();
  }
});
