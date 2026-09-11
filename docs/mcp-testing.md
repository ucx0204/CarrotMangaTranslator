# MCP 직접 테스트 안내

`feat/mcp-app-bridge` 브랜치의 읽기 전용 시험판입니다. 설치된 정식 앱에는 이 변경이 들어 있지 않습니다. PR #96은 초안이며 자동 병합/릴리스하지 않습니다.

**ChatGPT 웹에서 시험하려면 [웹 OAuth·Cloudflare 안내](mcp-web-testing.md)를 사용하세요.** 웹 실행기와 OAuth가 추가되었습니다. 아래는 기존 로컬 Bearer 연결을 위한 안내이며, 이 설정을 그대로 웹 ChatGPT의 인증 칸에 넣는 방식은 아닙니다.

## 시험 범위

작품·화·페이지 목록과 기능 조회가 가능합니다. 이미지 전송을 허용하면 `carrot_get_page_preview`가 추가됩니다. 결과는 원본 페이지의 축소 PNG이지 번역 완료 이미지가 아닙니다. 번역/OCR/원문 제거 실행, 이미지 식자, 용어집 수정, 번역 결과 저장과 ZIP 출력은 아직 MCP 도구에 연결되지 않았습니다.

## 1. 별도 시험 폴더 준비

Windows PowerShell에서 Git과 Node.js 22를 확인합니다.

```powershell
git --version
node --version
npm.cmd --version
```

처음이라면 새 폴더에 복제합니다. 기존 동일 이름 폴더를 지우거나 강제로 초기화하지 말고 다른 이름을 사용하세요.

```powershell
cd $HOME
git clone --branch feat/mcp-app-bridge --single-branch https://github.com/ucx0204/CarrotMangaTranslator.git CarrotMangaTranslator-MCP-Test
cd .\CarrotMangaTranslator-MCP-Test
npm.cmd ci
```

개발 앱의 데이터 루트는 이 복제 폴더입니다. 설치된 앱의 보관함과 별개이며 처음에는 빈 보관함이 정상입니다. 기존 개인 자료를 연결하거나 옮기지 말고 공개 가능한 이미지 한 장으로 시험하세요.

## 2. 실행

```powershell
node scripts/mcp-dev.cjs --images
```

이 명령은 기존 개발 실행기를 사용해 앱을 빌드하고 실행합니다. OCR/번역 모델은 호출하지 않습니다. 앱 창과 터미널을 유지하고 **새 원본 추가**에서 시험용 PNG/JPEG 한 장을 작품·화로 추가하세요. 번역 버튼은 누르지 않아도 됩니다.

이미지 전송이 필요 없으면 `--images`를 빼세요. 기본 주소는 `http://127.0.0.1:38475/mcp`, 토큰은 `.tmp/mcp-local-token`에 만들어 재사용합니다. 토큰은 비밀번호이며 공유/커밋하지 마세요. Windows 공유 폴더는 사용하지 마세요. 명시적인 `CARROT_MCP_TOKEN` 환경변수를 설정한 경우 파일 대신 그 값이 우선하므로 별도 터미널에도 동일하게 전달해야 합니다.

## 3. 별도 터미널에서 진단

```powershell
cd $HOME\CarrotMangaTranslator-MCP-Test
node scripts/mcp-smoke.mjs
node scripts/mcp-smoke.mjs --first-preview
```

첫 명령은 인증 거부, 초기화, 도구·기능·보관함 조회를 검사합니다. 두 번째 명령만 첫 페이지 이미지를 받습니다. 이미지 허용 시 도구 5개와 `imageTransfer=true`, 비허용 시 4개와 false가 정상입니다. `PASS invalid token rejected (401)`은 의도한 보안 검사 성공입니다.

`PASS PNG preview saved:` 뒤의 실제 파일 경로를 열어 이미지가 맞는지 확인하세요. 특정 페이지는 다음처럼 지정할 수 있습니다.

```powershell
node scripts/mcp-smoke.mjs --preview CHAPTER_ID PAGE_ID
```

ID는 조회 결과에서 얻습니다. 미리보기는 긴 변 최대 1600픽셀, PNG 최대 4MiB입니다. 가리기 검토가 활성화되어 있으면 현재 미리보기는 실패하도록 되어 있습니다. 로컬 승인 UI 연결 전에는 검토를 우회하지 않습니다. `--images`가 이 보호를 해제하지 않으며, 민감한 자료를 전송하려고 보호를 끄지 마세요.

## 4. Codex CLI 연결 (선택 사항)

Codex 할당량이 없으면 이 단계 대신 [ChatGPT 웹 안내](mcp-web-testing.md)를 사용하세요. 로컬 진단에는 AI 계정이나 API 키가 필요 없습니다.

`$HOME\.codex\config.toml`의 기존 내용을 보존하고 아래 항목을 추가합니다. 같은 이름이 있으면 그 항목만 수정하세요.

```toml
[mcp_servers.carrot_test]
url = "http://127.0.0.1:38475/mcp"
bearer_token_env_var = "CARROT_MCP_TOKEN"
startup_timeout_sec = 20
tool_timeout_sec = 45
```

두 번째 PowerShell에서 실행합니다. 토큰은 화면에 출력하지 않습니다.

```powershell
$env:CARROT_MCP_TOKEN = (Get-Content -Raw .\.tmp\mcp-local-token).Trim()
npx.cmd --no-install codex
```

전역 Codex를 사용한다면 마지막 명령 대신 `codex`를 실행할 수 있습니다. `/mcp`로 연결을 확인하고 아래처럼 요청하세요.

> carrot_test MCP로 보관함 작품·화 목록을 조회하고 첫 페이지 미리보기를 가져와줘. 파일시스템을 직접 읽지 말고 MCP 도구를 사용해.

실제 도구 호출이 표시되는지 확인합니다. 비전 판독과 이미지 표시는 클라이언트/모델 지원에 따라 다릅니다. 이미 열려 있던 IDE는 이 터미널의 환경변수를 자동으로 받지 않으므로 CLI부터 시험하세요. 이 로컬 프로필에는 `codex mcp login`이 필요하지 않습니다.

공식 설정: https://developers.openai.com/codex/mcp/

## 오류와 종료

| 증상                   | 확인                                                           |
| ---------------------- | -------------------------------------------------------------- |
| fetch failed/연결 거부 | 앱 초기화와 MCP 실행 터미널, 포트 상태                         |
| 토큰 파일 ENOENT       | 같은 폴더의 mcp-dev를 먼저 실행했는지, 환경 토큰 사용 여부     |
| 401                    | 앱과 클라이언트가 같은 토큰인지                                |
| 403                    | 정확한 Host/Origin 설정인지; 전달 헤더로 우회하지 않기         |
| 404                    | URL 끝이 정확히 `/mcp`인지; 쿼리 토큰 사용 금지                |
| 브라우저에서 401/405   | 주소창 방문은 MCP POST가 아니므로 진단 명령 사용               |
| 이미지 도구 없음       | `--images`로 앱 재시작 후 클라이언트 새로 연결                 |
| 미리보기만 실패        | 가리기 검토/파일 변경/이미지 제한과 앱 로컬 로그               |
| 작품 0개               | 시험용 개발 보관함에 원본을 추가했는지                         |
| 포트 사용 중           | 이전 시험 앱을 정상 종료; 포트를 바꾸면 모든 클라이언트도 수정 |

앱을 정상 종료합니다. 토큰 교체는 앱을 종료한 뒤 `.tmp/mcp-local-token` 파일만 삭제하고 재시작하세요. 실행 중 파일만 삭제해도 메모리의 토큰은 즉시 폐기되지 않습니다. 보관함·원본 폴더는 삭제하지 마세요.

업데이트는 앱을 종료하고 `git status --short`, `git pull --ff-only`, `npm.cmd ci` 순서로 합니다. 직접 수정한 파일은 별도로 보존하고 강제 초기화하지 마세요. 문제 공유 시 커밋, Node 버전, 실패 단계와 상태 코드를 보내고 토큰/암호/개인 이미지/민감한 제목은 제외하세요.

## 개발자 검사

```powershell
node node_modules/vitest/vitest.mjs run tests/mcp
npm.cmd run typecheck
npm.cmd run typecheck:electron
npm.cmd run typecheck:js
npm.cmd run build
node node_modules/electron/cli.js scripts/mcp-electron-smoke.cjs
```

현재 native smoke는 독립 임시 데이터 루트에 합성 이미지를 실제 앱 가져오기 경로로 등록해 OAuth/원본 미리보기/가리기 차단/종료를 검사합니다. 실제 사용자 보관함은 사용하지 않습니다. 전용 `CARROT_MCP_SMOKE_TUNNEL=1`에서만 합성 자료 서버의 실제 외부 HTTPS 검사도 실행합니다. GUI 수동 검수나 로그인된 실제 ChatGPT 세션을 대신하지 않습니다.

macOS 셸에서는 `export CARROT_MCP_TOKEN="$(cat .tmp/mcp-local-token)"` 형식을 사용하세요. 기존 앱의 Apple Silicon/macOS 지원 조건이 적용됩니다. 앱 패키징은 Windows x64/macOS arm64 대상이며 Linux 빌드 가드를 해제하지 않습니다.
