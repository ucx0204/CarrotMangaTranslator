type Consent = { transaction: string; clientName: string; scope: string; resource: string };

/** No remote assets, scripts, cookies in URLs, or user data appear in this page. */
export function mcpOAuthConsentPage(consent: Consent): string {
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>당근 MCP 연결 승인</title></head>
<body><main>
<h1>당근망가번역기 · ChatGPT 연결</h1>
<p>이 연결은 <strong>현재 실행한 시험용 앱의 보관함 전체를 읽을 수 있습니다.</strong> 이미지 전송을 켰다면 원본 축소 이미지도 요청할 수 있습니다. 번역 실행이나 수정 권한은 없습니다.</p>
<dl><dt>요청 클라이언트</dt><dd>${escapeHtml(consent.clientName)}</dd><dt>연결할 서버</dt><dd>${escapeHtml(consent.resource)}</dd><dt>권한</dt><dd>${escapeHtml(consent.scope)}</dd></dl>
<p>직접 실행한 터미널에 표시된 서버 주소와 위 주소가 같은지 확인하세요. 연결 암호는 로컬 <code>.tmp/mcp-web-password</code> 파일에서 복사합니다. <strong>ChatGPT 대화나 다른 사이트에는 암호를 보내지 마세요.</strong></p>
<p>승인하면 이 실행 중인 앱에 최대 24시간 동안 접근할 수 있습니다. 앱 종료·재시작으로 권한이 폐기됩니다. Cloudflare를 통해 전송되므로 공개 가능한 시험 자료만 사용하세요.</p>
<form method="post" action="/oauth/approve">
<input type="hidden" name="transaction" value="${escapeHtml(consent.transaction)}">
<p><label for="password">로컬 연결 암호</label><br><input id="password" type="password" name="pairing_secret" minlength="43" maxlength="128" required autocomplete="off" spellcheck="false" size="44"></p>
<button type="submit" name="decision" value="approve">읽기 권한으로 연결 승인</button>
<button type="submit" name="decision" value="deny" formnovalidate>취소</button>
</form></main></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
