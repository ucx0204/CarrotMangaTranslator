import { errorMonitor, once } from "node:events";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  McpOutputDeliveryObserver,
  type McpOutputDeliveryTransfer,
} from "../src/main/mcp/mcpOutputDeliveryObserver";
import {
  observeMcpOutputResponse,
  observeMcpOutputSource,
} from "../src/main/mcp/mcpOutputDeliveryHttp";

export function deliveryDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
type Handler = (input: {
  request: IncomingMessage;
  response: ServerResponse;
  transfer: McpOutputDeliveryTransfer;
  pipe: (source: AsyncIterable<Buffer>) => Promise<void>;
}) => Promise<void> | void;

/** Real loopback response/close/error events; only the producing handler is substituted. */
export async function outputDeliveryHttpFixture(handler: Handler) {
  const observer = new McpOutputDeliveryObserver();
  observer.created({
    artifactKey: "owned-output",
    origin: "generated",
    expiresAt: Date.now() + 60_000,
  });
  const settled = deliveryDeferred();
  const sent = deliveryDeferred();
  const errors: Error[] = [];
  let finishCalls = 0;
  let externalFinishPreserved = false;
  let remainingMonitors = -1;
  const server = createServer((request, response) => {
    const method = request.method === "HEAD" ? "HEAD" : "GET";
    const transfer = observer.beginHttp("owned-output", method);
    const nativeFinish = () => {
      finishCalls++;
    };
    response.on("finish", nativeFinish);
    response.on("error", (error: Error) => errors.push(error));
    observeMcpOutputResponse(response, transfer);
    response.once("close", () => {
      externalFinishPreserved = response
        .listeners("finish")
        .includes(nativeFinish);
      remainingMonitors = response.listenerCount(errorMonitor);
      settled.resolve();
    });
    const pipe = async (chunks: AsyncIterable<Buffer>) => {
      const source = Readable.from(chunks);
      source.on("error", (error: Error) => errors.push(error));
      const cleanup = observeMcpOutputSource(source, transfer);
      try {
        await pipeline(source, response);
      } finally {
        cleanup();
      }
    };
    void Promise.resolve()
      .then(() => handler({ request, response, transfer, pipe }))
      .catch((error: unknown) =>
        response.destroy(
          error instanceof Error ? error : new Error("Producer failed"),
        ),
      )
      .finally(sent.resolve);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Expected loopback address");
  return {
    url: `http://127.0.0.1:${address.port}/output`,
    observer,
    settled: settled.promise,
    sent: sent.promise,
    errors,
    inspect: () => observer.inspect({ artifactKey: "owned-output" }),
    listeners: () => ({
      finishCalls,
      externalFinishPreserved,
      remainingMonitors,
    }),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      observer.close();
    },
  };
}
