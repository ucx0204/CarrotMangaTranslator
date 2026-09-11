import type { IncomingMessage, ServerResponse } from "node:http";
import type { McpPairingService } from "../application/mcpPairingService";
import type { McpPairingRequest } from "../../shared/mcpDesktopTypes";
import { McpOAuthError, uniqueOAuthParams } from "./mcpOAuthPolicy";

const COOKIE = "__Host-carrot-link";
/** No browser endpoint can approve a connection. Only a cookie-bound request can collect its result. */
export class McpPairingHttp {
  constructor(readonly service: McpPairingService) {}
  async handle(
    url: URL,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<boolean> {
    if (url.pathname === "/oauth/approve")
      throw new McpOAuthError(
        "access_denied",
        "Approve this connection in the Carrot app, not with a password.",
        403,
      );
    if (
      url.pathname !== "/oauth/authorize" &&
      url.pathname !== "/oauth/pairing"
    )
      return false;
    if (request.method !== "GET")
      throw new McpOAuthError("invalid_request", "Method not allowed.", 405);
    if (url.pathname === "/oauth/authorize") {
      const pending = this.service.begin(uniqueOAuthParams(url.searchParams));
      response.setHeader(
        "Set-Cookie",
        `${COOKIE}=${pending.cookie}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=300`,
      );
      this.wait(response, pending);
    } else {
      const input = uniqueOAuthParams(url.searchParams);
      const cookies = (request.headers.cookie ?? "")
        .split(";")
        .map((part) => part.trim())
        .filter((part) => part.startsWith(`${COOKIE}=`));
      if (cookies.length !== 1)
        throw new McpOAuthError(
          "access_denied",
          "A matching browser cookie is required.",
          403,
        );
      const result = await this.service.poll(
        input.id ?? "",
        cookies[0].slice(COOKIE.length + 1),
      );
      if (result.redirect) {
        response.setHeader(
          "Set-Cookie",
          `${COOKIE}=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
        );
        response.writeHead(303, { Location: result.redirect });
        response.end();
      } else this.wait(response, result.request);
    }
    return true;
  }
  private wait(response: ServerResponse, pending: McpPairingRequest): void {
    response.setHeader("Refresh", `3; url=/oauth/pairing?id=${pending.id}`);
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>당근 MCP 연결 승인</title></head><body><main>
<h1>당근 앱에서 연결을 승인하세요</h1><p>앱의 설정 → AI 연결 / MCP에서 아래 확인 코드가 같은 요청을 선택하세요.</p>
<h2>${pending.code}</h2><p>앱에서 요청 클라이언트와 권한을 확인한 뒤 승인 또는 거절하세요. 이 코드는 비밀번호가 아닙니다.</p>
<p>암호나 API 키를 이 페이지 또는 ChatGPT 대화에 붙여넣을 필요가 없습니다. 승인하면 자동으로 돌아갑니다. 요청은 5분 후 만료됩니다.</p>
</main></body></html>`);
  }
}
