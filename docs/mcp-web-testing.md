# 웹 MCP 연결

현재 외부 연결은 **Tailscale Funnel**입니다. [앱에서 Tailscale MCP 연결하기](mcp-tailscale-testing.md)를 따르세요. 작업 브랜치는 `feat/mcp-app-bridge` 하나이며 코드가 이 브랜치에 통합되었습니다.

Cloudflare 임시 주소, `.tmp/mcp-web-password` 복사와 터미널 승인은 현재 사용자 경로가 아닙니다. `node scripts/mcp-web.cjs`는 기존 개발 앱을 여는 호환 진입점일 뿐입니다. 일반적으로 `npm.cmd run dev`로 앱을 열고 **설정 → AI 연결 / MCP**에서 서버 켜기·끄기, 권한, 연결 승인과 철회를 관리하세요.

기존 Cloudflare 연결에서는 Tailscale 주소로 최초 한 번 전환해야 합니다. 이후 같은 장치의 고정 주소와 유효한 승인은 재시작 후에도 유지됩니다. 앱 안의 **연결 진단**은 보관함·인증정보·모델 할당량 없이 연결 준비를 확인합니다.

예전 `mcp-web-smoke.mjs`의 암호 파일 기반 사용자 절차는 중단되었습니다. 프로토콜 회귀용 `mcp-web-probe.cjs`는 격리된 개발자 테스트 내부에서만 사용합니다. 실제 ChatGPT 계정 승인과 도구 호출은 별도 사용자 시험이며, 자동 HTTP 검사 성공만으로 계정 연결 성공을 주장하지 않습니다.
