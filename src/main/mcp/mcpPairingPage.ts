import { randomBytes } from "node:crypto";
import { escapeMcpHtml } from "./mcpOAuthPage";

/** All script is static. Only an escaped opaque transaction id enters the form. */
export function mcpPairingPage(consent: {
  transaction: string;
  clientName: string;
  resource: string;
  scope: string;
  code: string;
}) {
  const nonce = randomBytes(24).toString("base64");
  return {
    nonce,
    html: `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>당근 MCP 연결 승인</title></head>
<body><main><h1>당근 앱에서 연결을 승인하세요</h1>
<p>앱의 <strong>설정 → AI 연결 / MCP</strong>에서 아래 확인 코드와 요청 권한이 같은지 확인한 뒤 승인하세요. 암호를 복사할 필요가 없습니다.</p>
<p>확인 코드: <strong>${escapeMcpHtml(consent.code)}</strong></p>
<dl><dt>클라이언트가 표시한 이름</dt><dd>${escapeMcpHtml(consent.clientName)}</dd>
<dt>서버</dt><dd>${escapeMcpHtml(consent.resource)}</dd>
<dt>요청 권한</dt><dd>${escapeMcpHtml(consent.scope)}</dd></dl>
<p>읽기는 현재 앱 보관함 전체에 적용됩니다. carrot.images는 원본 이미지 전송, carrot.edit는 기존 번역문 수정 권한입니다. 클라이언트 이름만 믿고 승인하지 마세요.</p>
<p>승인 기록은 앱을 재시작해도 유지되며 앱에서 철회할 수 있습니다. 접근 토큰은 별도로 만료·갱신됩니다.</p>
<p id="status" role="status">앱의 승인을 확인하고 있습니다…</p>
<form method="post" action="/oauth/complete" id="complete">
<input type="hidden" name="transaction" value="${escapeMcpHtml(consent.transaction)}">
<button type="submit">승인 결과 확인</button></form>
<noscript>앱에서 승인한 뒤 ‘승인 결과 확인’을 누르세요.</noscript></main>
<script nonce="${nonce}">
const form = document.getElementById('complete');
const status = document.getElementById('status');
let attempts = 0;
async function poll() {
  if (++attempts > 150) { status.textContent = '연결이 만료되었습니다. ChatGPT에서 다시 연결하세요.'; return; }
  try {
    const response = await fetch('/oauth/poll', { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(new FormData(form)), redirect: 'error' });
    if (!response.ok) { status.textContent = '승인 확인이 중단되었습니다. 앱 상태를 확인하고 다시 연결하세요.'; return; }
    const result = await response.json();
    if (result.status === 'approved' || result.status === 'denied') { form.requestSubmit(); return; }
  } catch (_) { status.textContent = '앱 연결을 다시 확인하고 있습니다…'; }
  setTimeout(poll, 2000);
}
poll();
</script></body></html>`,
  };
}
