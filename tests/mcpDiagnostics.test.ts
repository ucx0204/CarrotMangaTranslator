import { afterEach, expect, it, vi } from "vitest";
import { diagnoseMcpEndpoint } from "../src/main/mcp/mcpDiagnostics";
import { MCP_MODERN_VERSION } from "../src/main/mcp/mcpProtocolEnvelope";
import {
  diagnosticAddresses,
  diagnosticFixture,
  jsonMetadata,
} from "./mcpDiagnostics.fixture";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const { origin, resource, resourceMetadata, authorizationMetadata } =
  diagnosticAddresses;

it.each([
  null,
  "not a URL",
  "http://127.0.0.1:38475/mcp",
  `${origin}/other`,
  `${resource}?token=PRIVATE`,
  `${resource}#PRIVATE`,
  "https://user:PRIVATE@carrot.tail-test.ts.net/mcp",
  "https://CARROT.tail-test.ts.net/mcp",
])(
  "refuses a noncanonical configured endpoint without any fetch: %s",
  async (url) => {
    const f = diagnosticFixture();
    const result = await diagnoseMcpEndpoint(url);
    expect(result.ok).toBe(false);
    expect(result.checks).toHaveLength(1);
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  },
);

it("checks the native OAuth documents once each and a credential-free MCP POST", async () => {
  const f = diagnosticFixture();
  const result = await diagnoseMcpEndpoint(resource);
  expect(result).toEqual({
    ok: true,
    checks: [
      { name: "OAuth 보호 리소스", passed: true, message: "확인 완료" },
      { name: "OAuth 인증 서버", passed: true, message: "확인 완료" },
      { name: "무인증 MCP POST 차단", passed: true, message: "확인 완료" },
    ],
  });
  expect(f.fetcher.mock.calls.map(([url]) => url)).toEqual([
    resourceMetadata,
    authorizationMetadata,
    resource,
  ]);
  for (const [, init] of f.fetcher.mock.calls) {
    if (!init)
      throw new Error("The diagnostic must supply explicit request options");
    expect(init.redirect).toBe("error");
    expect(init.credentials).toBe("omit");
    const headers = new Headers(init.headers);
    expect(headers.has("authorization")).toBe(false);
    expect(headers.has("cookie")).toBe(false);
  }
  const init = f.fetcher.mock.calls[2][1];
  if (!init)
    throw new Error("The diagnostic must supply explicit POST options");
  expect(init.method).toBe("POST");
  expect(new Headers(init.headers).get("mcp-protocol-version")).toBe(
    MCP_MODERN_VERSION,
  );
  expect(JSON.parse(String(init.body))).toMatchObject({
    method: "server/discover",
    params: {
      _meta: { "io.modelcontextprotocol/protocolVersion": MCP_MODERN_VERSION },
    },
  });
});

it("never follows resource metadata, endpoint or challenge URLs outside the configured authority", async () => {
  const foreign = "https://untrusted.example/PRIVATE";
  const f = diagnosticFixture((url, _init, body) => {
    if (url === resourceMetadata)
      return jsonMetadata({
        ...(body as object),
        authorization_servers: [foreign],
      });
    if (url === authorizationMetadata)
      return jsonMetadata({
        ...(body as object),
        issuer: foreign,
        token_endpoint: foreign,
      });
    return new Response("PRIVATE", {
      status: 401,
      headers: { "WWW-Authenticate": `Bearer resource_metadata="${foreign}"` },
    });
  });
  const result = await diagnoseMcpEndpoint(resource);
  expect(result.ok).toBe(false);
  expect(result.checks.every((check) => !check.passed)).toBe(true);
  expect(f.fetcher.mock.calls.map(([url]) => url)).toEqual([
    resourceMetadata,
    authorizationMetadata,
    resource,
  ]);
  expect(JSON.stringify(result)).not.toMatch(/untrusted|PRIVATE/);
});

it.each([
  ["issuer", `${origin}/`],
  ["registration_endpoint", undefined],
  ["token_endpoint", `${origin}/oauth/%74oken`],
  ["response_types_supported", []],
  ["grant_types_supported", ["authorization_code"]],
  ["code_challenge_methods_supported", ["plain"]],
  ["token_endpoint_auth_methods_supported", ["unsupported"]],
])(
  "reports unsupported native authorization metadata: %s",
  async (key, value) => {
    diagnosticFixture((url, _init, body) =>
      url === authorizationMetadata
        ? jsonMetadata({ ...(body as object), [String(key)]: value })
        : undefined,
    );
    const result = await diagnoseMcpEndpoint(resource);
    expect(result.ok).toBe(false);
    expect(result.checks.map((check) => check.passed)).toEqual([
      true,
      false,
      true,
    ]);
  },
);

it.each([
  { resource: `${origin}/mcp/` },
  { authorization_servers: [origin, "https://extra.example"] },
  { scopes_supported: [] },
  { bearer_methods_supported: ["query"] },
])("rejects inconsistent protected-resource metadata %#", async (change) => {
  diagnosticFixture((url, _init, body) =>
    url === resourceMetadata
      ? jsonMetadata({ ...(body as object), ...change })
      : undefined,
  );
  const result = await diagnoseMcpEndpoint(resource);
  expect(result.checks.map((check) => check.passed)).toEqual([
    false,
    true,
    true,
  ]);
});

it.each([
  [200, `Bearer resource_metadata="${resourceMetadata}"`],
  [405, `Bearer resource_metadata="${resourceMetadata}"`],
  [401, "Bearer realm=carrot"],
  [401, `Basic resource_metadata="${resourceMetadata}"`],
  [401, `Bearer not-resource_metadata="${resourceMetadata}"`],
  [401, `Bearer realm=carrot, Basic resource_metadata="${resourceMetadata}"`],
  [401, `Bearer resource_metadata="${resourceMetadata}", Basic realm="carrot"`],
  [
    401,
    `Bearer resource_metadata="${resourceMetadata}", resource_metadata="${resourceMetadata}"`,
  ],
])(
  "requires actual 401 Bearer rejection and one exact challenge: %#",
  async (status, challenge) => {
    diagnosticFixture((url) =>
      url === resource
        ? new Response("PRIVATE", {
            status: Number(status),
            headers: { "WWW-Authenticate": String(challenge) },
          })
        : undefined,
    );
    const result = await diagnoseMcpEndpoint(resource);
    expect(result.checks.map((check) => check.passed)).toEqual([
      true,
      true,
      false,
    ]);
  },
);
