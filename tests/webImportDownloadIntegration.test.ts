import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  downloadDiscoveredWebImages,
  type WebImportFetchSession,
} from "../src/main/webImportDownload";

describe("web import download fixture", () => {
  let server: Server;
  let baseUrl: string;
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "web-import-download-"));
    server = createFixtureServer();
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Fixture did not bind.");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  });

  it("streams supported images, removes hash duplicates, and reports exclusions", async () => {
    const seenReferrers: string[] = [];
    const fixtureSession: WebImportFetchSession = {
      fetch: vi.fn(async (url: string, init?: RequestInit) => {
        const source = new URL(url);
        const headers = new Headers(init?.headers);
        seenReferrers.push(headers.get("referer") ?? "");
        const response = await fetch(`${baseUrl}${source.pathname}`, {
          headers,
          signal: init?.signal,
        });
        return new Response(response.body, {
          headers: response.headers,
          status: response.status,
        });
      }),
    };
    const progress = vi.fn();

    const result = await downloadDiscoveredWebImages({
      candidates: [
        discovered("https://cdn.example/1.jpg", 0),
        discovered("https://cdn.example/duplicate.jpg", 1),
        discovered("https://cdn.example/2.png", 2),
        discovered("https://cdn.example/unsupported.gif", 3),
        discovered("https://cdn.example/broken.jpg", 4),
      ],
      deadlineAt: Date.now() + 10_000,
      directory,
      dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
      pageUrl: "https://page.example/chapter/1",
      session: fixtureSession,
      signal: new AbortController().signal,
      onProgress: progress,
    });

    expect(
      result.candidates.map((candidate) => candidate.sourceFormat),
    ).toEqual(["jpeg", "png"]);
    expect(result.skipped).toEqual({
      unsupported: 1,
      failed: 1,
      duplicate: 1,
      blocked: 0,
    });
    expect(result.truncated).toBe(false);
    expect(seenReferrers).toEqual(
      Array.from({ length: 5 }, () => "https://page.example/"),
    );
    expect(progress).toHaveBeenLastCalledWith(5, 5);
  });
});

function discovered(url: string, discoveryIndex: number) {
  return { url, y: discoveryIndex, x: 0, discoveryIndex };
}

function createFixtureServer(): Server {
  const jpeg = makeJpegHeader(12, 18);
  const png = makePngHeader(20, 30);
  return createServer((request, response) => {
    switch (request.url) {
      case "/1.jpg":
      case "/duplicate.jpg":
        response.writeHead(200, { "Content-Type": "image/jpeg" });
        response.end(jpeg);
        return;
      case "/2.png":
        response.writeHead(200, { "Content-Type": "image/png" });
        response.end(png);
        return;
      case "/unsupported.gif":
        response.writeHead(200, { "Content-Type": "image/gif" });
        response.end(Buffer.from("GIF89a", "ascii"));
        return;
      case "/broken.jpg":
        response.writeHead(200, { "Content-Type": "image/jpeg" });
        response.end(Buffer.from("not-an-image", "ascii"));
        return;
      default:
        response.writeHead(404);
        response.end();
    }
  });
}

function makePngHeader(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function makeJpegHeader(width: number, height: number): Buffer {
  const payload = Buffer.alloc(9);
  payload[0] = 8;
  payload.writeUInt16BE(height, 1);
  payload.writeUInt16BE(width, 3);
  payload[5] = 1;
  payload[6] = 1;
  payload[7] = 0x11;
  const segment = Buffer.alloc(4 + payload.length);
  segment.set([0xff, 0xc0], 0);
  segment.writeUInt16BE(payload.length + 2, 2);
  payload.copy(segment, 4);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment,
    Buffer.from([0xff, 0xd9]),
  ]);
}
