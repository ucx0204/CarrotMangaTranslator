# 로컬 MCP 개발자 진단

**일반 사용과 ChatGPT 웹 연결은 [Tailscale 앱 내 연결 안내](mcp-tailscale-testing.md)를 따르세요.** 작업 브랜치는 `feat/mcp-app-bridge` 하나입니다. `npm.cmd run dev`로 앱을 열고 설정에서 MCP를 관리하는 것이 현재 사용자 경로입니다. Cloudflare는 사용하지 않습니다.

이 문서는 기존 **로컬 Bearer 읽기 전용 개발 프로필**만 설명합니다. 앱에서 관리하는 영구 OAuth·편집 연결과 다른 프로필이며 동시에 같은 포트로 실행하지 않습니다. 설치된 정식 릴리스에 이 브랜치의 변경이 포함되어 있다고 가정하지 마세요.

## 실행과 진단

기존 시험 폴더에서 앱을 종료하고 코드를 갱신합니다. 직접 수정한 파일·보관함·원본·출력물을 삭제하거나 강제 초기화하지 않습니다.

```powershell
cd $HOME\CarrotMangaTranslator-MCP-Test
git status --short
git switch feat/mcp-app-bridge
git pull --ff-only
npm.cmd ci
node scripts/mcp-dev.cjs --images
```

기본 주소는 `http://127.0.0.1:38475/mcp`입니다. `.tmp/mcp-local-token`은 이 개발 프로필의 로컬 토큰이며 비밀번호처럼 보호해야 합니다. 앱 관리 OAuth 저장소를 이 파일로 대체하지 않습니다. `--images`를 빼면 이미지 도구는 제공하지 않습니다.

앱이 실행된 상태에서 두 번째 PowerShell 창을 열고 같은 폴더에서 진단합니다.

```powershell
node scripts/mcp-smoke.mjs
node scripts/mcp-smoke.mjs --first-preview
```

첫 명령은 인증·초기화·도구·보관함 조회를 검사하고, 두 번째 명령만 첫 페이지 미리보기를 받습니다. `PASS invalid token rejected (401)`은 의도한 보안 검사 성공입니다. 빈 개발 보관함이라면 공개 가능한 시험 이미지를 앱에서 추가하세요.

`PASS PNG preview saved:` 뒤에 나온 실제 경로의 파일을 열어 확인합니다. 미리보기는 긴 변 최대 1600픽셀, PNG 최대 4MiB이며 원본의 축소 이미지이지 완성 번역 결과물이 아닙니다. 이미지 허용은 기존 가리기 검토 보호를 해제하지 않습니다.

## 로컬 클라이언트 연결

로컬 HTTP MCP를 지원하는 클라이언트에 위 주소와 Bearer 토큰을 설정할 수 있습니다. 예를 들어 Codex 설정 파일의 기존 내용을 보존하고 아래 서버 항목을 추가합니다.

```toml
[mcp_servers.carrot_test]
url = "http://127.0.0.1:38475/mcp"
bearer_token_env_var = "CARROT_MCP_TOKEN"
startup_timeout_sec = 20
tool_timeout_sec = 45
```

클라이언트를 시작하는 터미널에서만 토큰을 읽습니다. 토큰 값 자체를 대화나 로그에 출력하지 않습니다.

```powershell
$env:CARROT_MCP_TOKEN = (Get-Content -Raw .\.tmp\mcp-local-token).Trim()
npx.cmd --no-install codex
```

Codex의 모델 이용 한도와 로컬 MCP 진단은 별개입니다. Codex를 사용하지 않는 경우 이 단계는 필요 없고, 앱 내 Tailscale 연결로 웹 ChatGPT에서 시험할 수 있습니다. Codex 공식 설정은 [MCP 문서](https://developers.openai.com/codex/mcp/)를 참고하세요.

## 종료·오류

연결 거부는 앱 실행과 포트를, 정상 요청의 401은 토큰 일치를 확인합니다. 이미지 도구가 없다면 `--images`와 클라이언트 재연결을 확인하세요. 브라우저 주소창 방문의 401/405는 인증된 MCP POST가 아니므로 위 진단으로 판정합니다.

앱을 정상 종료합니다. 이 개발 프로필의 토큰을 교체하려면 종료 후 `.tmp/mcp-local-token`만 삭제하고 다시 실행합니다. 실행 중 토큰 파일 삭제는 즉시 권한 철회가 아닙니다. **앱 관리 OAuth 연결은 설정의 ‘연결 권한 철회’를 사용**하며, MCP 끄기·재시작만으로 승인 기록을 삭제하지 않습니다.

최신 기능 범위·회귀 검사·Windows 빌드·실제 암호화 저장 검사·화면 캡처 결과는 [통합 기록](mcp-integration-status.md)에 있습니다. 외부 합성 시험의 현재 선택 환경변수는 `CARROT_MCP_SMOKE_TAILSCALE=1`이며, 설치·로그인된 Tailscale 계정을 사용자가 준비해야 합니다. 과거 Cloudflare 임시 터널 환경변수와 암호 파일 기반 웹 진단 안내는 폐기되었습니다.
