import type { IncomingMessage } from "node:http";
import { expect, it } from "vitest";
import {
  validateMcpHost,
  validateMcpPost,
} from "../src/main/mcp/mcpHttpPolicy";

const config = { port: 1234, token: "t".repeat(43) };
const request = (
  headersDistinct: Record<string, string[] | undefined>,
  headers: Record<string, string> = {},
) => ({ headersDistinct, headers }) as IncomingMessage;
it("rejects duplicate or missing required headers before body parsing", () => {
  for (const headers of [
    {},
    { host: ["127.0.0.1:1234", "evil.example"] },
    { host: ["127.0.0.1:1234"], origin: ["a", "b"] },
  ]) {
    expect(() => validateMcpHost(request(headers), config)).toThrow(
      /Invalid HTTP headers/,
    );
  }
  const accept = { accept: "application/json, text/event-stream" };
  expect(() => validateMcpPost(request({}, accept))).toThrow(
    /Invalid HTTP headers/,
  );
  expect(() =>
    validateMcpPost(
      request({ "content-type": ["application/json", "text/plain"] }, accept),
    ),
  ).toThrow(/Invalid HTTP headers/);
  expect(() =>
    validateMcpPost(request({ "content-type": [] }, accept)),
  ).toThrow(/Invalid HTTP headers/);
  expect(() =>
    validateMcpPost(request({ "content-type": ["application/json"] })),
  ).toThrow(/Accept/);
});
