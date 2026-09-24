import { vi } from "vitest";
import { McpOAuthHttp } from "../src/main/mcp/mcpOAuthHttp";

const origin = "https://carrot.tail-test.ts.net";
const resource = `${origin}/mcp`;
const resourceMetadata = `${origin}/.well-known/oauth-protected-resource/mcp`;
const authorizationMetadata = `${origin}/.well-known/oauth-authorization-server`;
type Override = (
  url: string,
  init: RequestInit,
  body: unknown,
) => Response | Promise<Response> | undefined;

export function jsonMetadata(
  body: unknown,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json", ...headers },
  });
}
export function diagnosticFixture(override?: Override) {
  const oauth = new McpOAuthHttp(origin, "p".repeat(43));
  const provider = oauth.provider;
  const fetcher = vi.fn(
    async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      const body =
        url === resourceMetadata
          ? provider.resourceMetadata()
          : url === authorizationMetadata
            ? provider.authorizationMetadata()
            : undefined;
      const changed = override?.(url, init, body);
      if (changed) return changed;
      if (body) return jsonMetadata(body);
      if (url !== resource) throw new Error("Unexpected diagnostic target");
      return new Response("not authorized", {
        status: 401,
        headers: {
          "WWW-Authenticate": oauth.challenge(),
        },
      });
    },
  );
  vi.stubGlobal("fetch", fetcher);
  return { fetcher };
}

export const diagnosticAddresses = {
  origin,
  resource,
  resourceMetadata,
  authorizationMetadata,
};
