import type { McpDiagnostics } from "../../shared/mcpDesktopTypes";
import {
  HttpRequestDeadlineError,
  HttpResponseTooLargeError,
  readBoundedResponseText,
} from "../httpResponseBudget";
import { MCP_MODERN_VERSION } from "./mcpProtocolEnvelope";
import { runMcpDiagnosticProbe as probe } from "./mcpDiagnosticProbe";

const METADATA_BYTES = 16_384;
class DiagnosticFailure extends Error {}

/** Checks public discovery and unauthenticated POST rejection. No login or tool is run. */
export async function diagnoseMcpEndpoint(
  url: string | null,
): Promise<McpDiagnostics> {
  const origin = configuredOrigin(url);
  if (!origin)
    return {
      ok: false,
      checks: [
        {
          name: "주소",
          passed: false,
          message: url
            ? "앱에서 제공한 HTTPS /mcp 고정 주소를 확인하세요."
            : "MCP를 먼저 켜세요.",
        },
      ],
    };
  const resource = `${origin}/mcp`;
  const metadata = `${origin}/.well-known/oauth-protected-resource/mcp`;
  const checks = [
    await check("OAuth 보호 리소스", () =>
      inspectJson(metadata, (value) => checkResource(value, resource, origin)),
    ),
    await check("OAuth 인증 서버", () =>
      inspectJson(`${origin}/.well-known/oauth-authorization-server`, (value) =>
        checkAuthorizationServer(value, origin),
      ),
    ),
    await check("무인증 MCP POST 차단", () =>
      checkUnauthorized(resource, metadata),
    ),
  ];
  return { ok: checks.every((item) => item.passed), checks };
}

function configuredOrigin(url: string | null): string | undefined {
  if (!url) return undefined;
  try {
    const value = new URL(url);
    return value.protocol === "https:" && url === `${value.origin}/mcp`
      ? value.origin
      : undefined;
  } catch (_error) {
    return undefined;
  }
}

async function inspectJson(
  url: string,
  inspect: (value: Record<string, unknown>) => void,
): Promise<void> {
  await probe(
    url,
    { headers: { Accept: "application/json" } },
    async (response, signal) => {
      if (!response.ok) throw new DiagnosticFailure(`HTTP ${response.status}`);
      if (
        response.headers
          .get("content-type")
          ?.split(";")[0]
          .trim()
          .toLowerCase() !== "application/json"
      )
        throw new DiagnosticFailure(
          "OAuth 메타데이터의 JSON 응답 형식이 아닙니다.",
        );
      const content = await readBoundedResponseText(response, {
        label: "MCP OAuth 메타데이터",
        maximumBytes: METADATA_BYTES,
        signal,
      });
      let value: unknown;
      try {
        value = JSON.parse(content);
      } catch (_error) {
        throw new DiagnosticFailure(
          "OAuth 메타데이터가 유효한 JSON이 아닙니다.",
        );
      }
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new DiagnosticFailure("OAuth 메타데이터 객체가 필요합니다.");
      inspect(value as Record<string, unknown>);
    },
  );
}

function checkResource(
  value: Record<string, unknown>,
  resource: string,
  origin: string,
): void {
  const servers = value.authorization_servers;
  if (
    value.resource !== resource ||
    !Array.isArray(servers) ||
    servers.length !== 1 ||
    servers[0] !== origin
  )
    throw new DiagnosticFailure(
      "보호 리소스와 인증 서버 주소가 앱의 고정 주소와 일치하지 않습니다.",
    );
  if (
    !includes(value.scopes_supported, "carrot.read") ||
    !includes(value.bearer_methods_supported, "header")
  )
    throw new DiagnosticFailure(
      "보호 리소스의 읽기 권한 또는 Bearer 전송 방식이 일치하지 않습니다.",
    );
}

function checkAuthorizationServer(
  value: Record<string, unknown>,
  origin: string,
): void {
  const fields = {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    revocation_endpoint: `${origin}/oauth/revoke`,
  };
  if (
    !Object.entries(fields).every(([key, expected]) => value[key] === expected)
  )
    throw new DiagnosticFailure(
      "OAuth issuer 또는 인증 경로가 앱의 고정 주소와 일치하지 않습니다.",
    );
  if (
    !includes(value.response_types_supported, "code") ||
    !includes(value.grant_types_supported, "authorization_code") ||
    !includes(value.grant_types_supported, "refresh_token") ||
    !includes(value.code_challenge_methods_supported, "S256")
  )
    throw new DiagnosticFailure(
      "OAuth 코드·갱신·PKCE S256 지원을 확인하지 못했습니다.",
    );
  if (
    !["none", "client_secret_post", "client_secret_basic"].some((method) =>
      includes(value.token_endpoint_auth_methods_supported, method),
    )
  )
    throw new DiagnosticFailure(
      "지원하는 OAuth 클라이언트 인증 방식이 없습니다.",
    );
}

function includes(value: unknown, item: string): boolean {
  return Array.isArray(value) && value.includes(item);
}

async function checkUnauthorized(
  resource: string,
  metadata: string,
): Promise<void> {
  await probe(
    resource,
    {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        "MCP-Protocol-Version": MCP_MODERN_VERSION,
        "Mcp-Method": "server/discover",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "carrot-connection-check",
        method: "server/discover",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": MCP_MODERN_VERSION,
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    },
    async (response) => {
      const challenge = response.headers.get("www-authenticate") ?? "";
      // Match the complete challenge produced by McpOAuthHttp, not a parameter
      // substring that could belong to another authentication scheme.
      const reference =
        /^Bearer resource_metadata="([^"]+)"(?:, scope="[^"]*")?$/.exec(
          challenge,
        );
      if (response.status !== 401 || reference?.[1] !== metadata)
        throw new DiagnosticFailure(
          "예상한 401 Bearer 거부와 정확한 OAuth 메타데이터 주소를 확인하지 못했습니다.",
        );
    },
  );
}

async function check(name: string, action: () => Promise<void>) {
  try {
    await action();
    return { name, passed: true, message: "확인 완료" };
  } catch (error) {
    return { name, passed: false, message: diagnosticMessage(error) };
  }
}

function diagnosticMessage(error: unknown): string {
  if (error instanceof DiagnosticFailure) return error.message;
  if (error instanceof HttpResponseTooLargeError)
    return "OAuth 메타데이터가 16KiB 상한을 넘었습니다.";
  if (error instanceof HttpRequestDeadlineError)
    return "8초 안에 응답 확인을 마치지 못했습니다.";
  return "응답 확인에 실패했습니다. 앱·Tailscale 상태와 네트워크를 확인하세요.";
}
