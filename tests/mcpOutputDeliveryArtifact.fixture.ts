import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpArtifactStore } from "../src/main/mcp/mcpArtifactStore";
import type { McpArtifactRetention } from "../src/main/mcp/mcpArtifactTypes";
import { McpOutputDeliveryObserver } from "../src/main/mcp/mcpOutputDeliveryObserver";
import { startMcpHttpServer } from "../src/main/mcp/mcpHttpServer";

export const deliveryBinding = {
  chapterId: "chapter",
  pageId: "page",
  revision: "page-v1:0000000000000000",
};
export async function deliveryArtifactFixture(retain?: McpArtifactRetention) {
  const origin = "https://delivery.test";
  const observer = new McpOutputDeliveryObserver();
  const store = new McpArtifactStore(origin, Date.now, retain, observer);
  let allowed = true;
  const revoked = new Error("Synthetic grant revoked");
  const assertAccess = async () => {
    if (!allowed) throw revoked;
  };
  let report: (error: unknown) => void = () => {};
  const reported = new Promise<unknown>((resolve) => {
    report = resolve;
  });
  const errors: unknown[] = [];
  const server = await startMcpHttpServer({
    config: { port: 0, token: "t".repeat(43), publicOrigin: origin },
    artifacts: store,
    tools: [],
    reportError: (error) => {
      errors.push(error);
      report(error);
    },
  });
  return {
    store,
    observer,
    assertAccess,
    revoked,
    reported,
    errors,
    revoke: () => {
      allowed = false;
    },
    send: (url: string, init: RequestInit = {}) =>
      fetch(`${new URL(server.url).origin}${new URL(url).pathname}`, {
        ...init,
        redirect: "manual",
      }),
    workFile: (bytes: Buffer) =>
      store.putWorkFile(
        (file) => writeFile(file, bytes),
        bytes.length,
        assertAccess,
        new AbortController().signal,
        [deliveryBinding],
        { workId: "work", chapterIds: ["chapter"], snapshot: "0".repeat(16) },
      ),
    close: async () => {
      store.stop();
      await server.close();
      await store.close();
    },
  };
}

export async function deliveryTemporaryFile(bytes: Buffer) {
  const directory = await mkdtemp(join(tmpdir(), "carrot-delivery-test-"));
  const file = join(directory, "retained.bin");
  await writeFile(file, bytes);
  return { file, close: () => rm(directory, { recursive: true, force: true }) };
}

/** Server finish is independent of the client's Content-Length body read. */
export function deliveryResponseFinished(url: string) {
  const pathname = new URL(url).pathname;
  let resolve!: (response: ServerResponse) => void;
  const finished = new Promise<ServerResponse>((complete) => {
    resolve = complete;
  });
  const observed = (message: unknown) => {
    const event = message as {
      request: IncomingMessage;
      response: ServerResponse;
    };
    if (event.request.url !== pathname || event.request.method !== "GET")
      return;
    unsubscribe("http.server.response.finish", observed);
    resolve(event.response);
  };
  subscribe("http.server.response.finish", observed);
  return {
    finished,
    close: () => unsubscribe("http.server.response.finish", observed),
  };
}
