import type { McpDiagnostics } from "../../shared/mcpDesktopTypes";
/** No credentials or library contents leave the app during this diagnostic. */
export async function diagnoseMcpEndpoint(
  url: string | null,
): Promise<McpDiagnostics> {
  if (!url)
    return {
      ok: false,
      checks: [{ name: "주소", passed: false, message: "MCP를 먼저 켜세요." }],
    };
  const checks: McpDiagnostics["checks"] = [];
  for (let i = 0; i < 3; i++) {
    checks.push(
      await check(`HTTPS / OAuth ${i + 1}`, () => checkMetadata(url)),
    );
  }
  checks.push(
    await check("무인증 접근 차단", async () => {
      const response = await fetch(url, {
        redirect: "error",
        signal: AbortSignal.timeout(8000),
      });
      const passed =
        response.status === 401 &&
        response.headers
          .get("www-authenticate")
          ?.includes("resource_metadata=") === true;
      await response.body?.cancel();
      if (!passed) throw new Error("예상한 401 인증 거부 응답이 아닙니다.");
    }),
  );
  return { ok: checks.every((item) => item.passed), checks };
}
async function checkMetadata(url: string): Promise<void> {
  const origin = new URL(url).origin;
  const response = await fetch(
    `${origin}/.well-known/oauth-protected-resource/mcp`,
    {
      redirect: "error",
      signal: AbortSignal.timeout(8000),
    },
  );
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const text = await response.text();
  if (text.length > 16_384) throw new Error("Unexpected metadata size");
  const data = JSON.parse(text);
  if (data.resource !== url || data.authorization_servers?.[0] !== origin)
    throw new Error("OAuth 주소가 일치하지 않습니다.");
}
async function check(name: string, action: () => Promise<void>) {
  try {
    await action();
    return { name, passed: true, message: "확인 완료" };
  } catch (error) {
    return {
      name,
      passed: false,
      message: error instanceof Error ? error.message : "응답 확인 실패",
    };
  }
}
