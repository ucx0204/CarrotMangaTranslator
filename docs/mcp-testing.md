# MCP 직접 테스트 안내

이 문서는 `feat/mcp-app-bridge` 브랜치의 **읽기 전용 시험판**을 위한 안내입니다. 설치된 정식 앱에는 아직 이 변경이 들어 있지 않습니다. PR #96은 초안이며 자동 병합하거나 릴리스하지 않습니다.

## 이번에 시험할 수 있는 범위

`carrot_get_capabilities`, `carrot_list_works`, `carrot_list_chapters`, `carrot_get_chapter`로 기존 앱 보관함을 읽습니다. 실행할 때 이미지 전송을 명시적으로 허용하면 `carrot_get_page_preview`도 등록됩니다. 미리보기는 원본 페이지의 축소 PNG이며 **번역 결과가 아닙니다**.

번역 실행, OCR 실행, 지우기, 이미지 식자, 용어집 수정, ZIP 출력은 아직 MCP 도구로 연결되지 않았습니다. 원본을 본 외부 비전 AI가 채팅에서 직접 읽거나 번역하는 것과, 앱의 번역 작업을 실행하고 저장하는 것은 다릅니다.

이 서버는 MCP 2025-11-25 및 이전 두 버전의 tools-only Streamable HTTP 프로필을 사용합니다. SSE, OAuth, sampling, MCP Apps UI는 제공하지 않습니다. ChatGPT 웹에 이 주소만 붙이면 된다고 가정하지 마세요. 이번 연결 시험은 로컬 진단 명령과 Bearer 인증을 지원하는 Codex 같은 클라이언트가 대상입니다.

## 1. 기존 앱과 분리해서 준비하기

Windows PowerShell 기준입니다. Git과 Node.js 22가 필요합니다. 먼저 확인하세요.

```powershell
git --version
node --version
npm --version
```

새 폴더에 브랜치를 받습니다. 이미 같은 이름의 폴더가 있다면 새 이름을 사용하고, 기존 폴더를 지우거나 강제로 초기화하지 마세요.

```powershell
cd $HOME
git clone --branch feat/mcp-app-bridge --single-branch https://github.com/ucx0204/CarrotMangaTranslator.git CarrotMangaTranslator-MCP-Test
cd .\CarrotMangaTranslator-MCP-Test
npm ci
```

개발 앱은 이 복제 폴더를 데이터 루트로 사용합니다. 설치된 앱의 보관함을 연결하거나 옮길 필요가 없습니다. 처음에는 빈 보관함이 정상입니다. **개인 자료가 없는 이미지 한 장으로 먼저 시험하세요.**

## 2. MCP를 켜고 개발 앱 실행하기

같은 PowerShell에서 실행합니다.

```powershell
node scripts/mcp-dev.cjs --images
```

기존 개발 실행기를 통해 빌드와 Electron 실행이 이루어집니다. 앱 창이 열린 뒤에도 이 터미널을 닫지 마세요. 이 명령은 OCR이나 번역 모델을 호출하지 않습니다. 초기 npm 의존성 설치와 개발 빌드 자체는 필요합니다.

`--images`는 연결된 클라이언트에 축소 원본을 제공하는 데 동의한다는 뜻입니다. 이미지 전송이 필요 없으면 다음처럼 실행하세요.

```powershell
node scripts/mcp-dev.cjs
```

기본 주소는 `http://127.0.0.1:38475/mcp`입니다. 인증 토큰은 `.tmp/mcp-local-token`에 자동으로 만들고 재실행 시 재사용합니다. 토큰 자체는 로그에 출력하지 않습니다. 이 파일은 비밀번호처럼 취급하고, 공유하거나 커밋하지 마세요. Windows에서는 파일 권한이 폴더의 접근 권한을 따르므로 공유 폴더에서 시험하지 마세요.

이미 `CARROT_MCP_TOKEN` 환경변수를 지정했다면 그 값을 우선 사용합니다. 이 경우 별도 터미널과 클라이언트에도 같은 환경변수를 전달해야 하며 자동 토큰 파일이 없을 수 있습니다. 특별한 이유가 없다면 환경변수를 직접 설정하지 않고 자동 준비 경로를 사용하세요.

앱의 **새 원본 추가**에서 시험용 PNG/JPEG 한 장을 가져와 작품과 화를 만드세요. 아직 번역 버튼을 누를 필요는 없습니다.

## 3. AI 없이 연결부터 확인하기

**PowerShell 창을 하나 더 열고**, 같은 복제 폴더로 이동합니다.

```powershell
cd $HOME\CarrotMangaTranslator-MCP-Test
node scripts/mcp-smoke.mjs
```

진단은 잘못된 토큰 차단, MCP 초기화, 도구 목록, 기능 조회, 작품·화·페이지 조회를 검사합니다. 다음과 같은 `PASS` 문구가 나와야 합니다. 숫자는 보관함 내용에 따라 다릅니다.

```text
PASS invalid token rejected (401)
PASS MCP initialize / notification (2025-11-25)
PASS tools/list (5 tools)
PASS capabilities (imageTransfer=true)
PASS library read (1 works)
PASS chapters read (1 chapters in first work)
PASS pages read (1 pages in first chapter)
PASS smoke test complete (read-only; no OCR or translation executed)
```

이미지 옵션 없이 실행했다면 도구는 4개이고 `imageTransfer=false`가 정상입니다. 빈 보관함도 조회 자체는 성공합니다. 화와 페이지까지 시험하려면 시험용 원본을 하나 추가하세요.

## 4. 실제 이미지 응답 확인하기

앱을 `--images`로 실행했고 시험용 화에 페이지가 있다면 다음을 실행합니다.

```powershell
node scripts/mcp-smoke.mjs --first-preview
```

첫 작품의 첫 화에서 첫 페이지를 가져옵니다. 출력된 `PASS PNG preview saved:` 뒤의 경로에 있는 PNG를 열어 확인하세요. 파일은 `.tmp/mcp-preview-<고유값>.png`에 저장됩니다. 기본 진단은 이미지를 내려받지 않으며 이 옵션을 주었을 때만 내려받습니다.

특정 페이지를 지정할 수도 있습니다. ID는 보관함 조회 도구에서 얻은 값을 사용합니다.

```powershell
node scripts/mcp-smoke.mjs --preview CHAPTER_ID PAGE_ID
```

현재 미리보기는 긴 변 최대 1600픽셀, PNG 최대 4MiB입니다. 긴 원고를 세밀하게 읽는 확대 조각 기능이나 완성 출력물 내보내기는 이번 범위가 아닙니다.

### 가리기를 켜 둔 경우

앱의 외부 전송 전 가리기 검토가 켜져 있다면, 현재 MCP 미리보기는 **실패하도록** 되어 있습니다. 기존 검토를 우회하거나 저장된 마스크를 자동 승인으로 취급하지 않습니다. MCP에서 로컬 가리기 검토를 요청하고 승인받는 연결은 후속 작업입니다.

이 실패는 보호 동작이며 `--images`가 그 보호를 해제하지 않습니다. 개인 자료를 보내기 위해 가리기를 끄지 마세요. 별도로 만든 시험용 보관함에서 공개 가능한 이미지로만 전송 시험을 진행하세요.

## 5. Codex CLI에 연결하기

먼저 위 로컬 진단이 통과하는지 확인하세요. MCP 조회와 진단에는 AI 계정이나 API 키가 필요하지 않습니다. Codex에게 실제로 말로 작업을 시킬 때는 Codex의 로그인 또는 모델 이용 권한이 필요합니다. 앱 내부의 Codex 로그인과 CLI 로그인은 별도일 수 있습니다.

`$HOME\.codex\config.toml`을 열고 다음 항목을 추가합니다. 기존 설정을 덮어쓰지 말고, 이미 `carrot_test` 항목이 있다면 그 항목만 수정하세요.

```toml
[mcp_servers.carrot_test]
url = "http://127.0.0.1:38475/mcp"
bearer_token_env_var = "CARROT_MCP_TOKEN"
startup_timeout_sec = 20
tool_timeout_sec = 45
```

진단을 실행했던 **두 번째 PowerShell**에서 토큰을 환경변수로 읽고 Codex를 실행합니다. 이 명령은 토큰을 화면에 출력하지 않습니다.

```powershell
$env:CARROT_MCP_TOKEN = (Get-Content -Raw .\.tmp\mcp-local-token).Trim()
codex
```

전역 `codex` 명령이 없다면 저장소에 설치된 Codex CLI를 사용합니다.

```powershell
npx --no-install codex
```

Codex에서 `/mcp`를 입력해 `carrot_test`와 도구 목록을 확인하세요. 이 서버는 정적 Bearer 인증이므로 `codex mcp login carrot_test`로 OAuth 로그인을 시도할 필요가 없습니다.

시험할 지시 예시:

> carrot_test MCP 도구로 보관함 작품과 화 목록을 보여줘. 파일시스템을 직접 읽지 말고 MCP 도구를 사용해.

> 첫 작품의 첫 화에서 첫 페이지 미리보기를 MCP로 가져와서 어떤 장면인지 설명해줘. 번역이나 OCR 작업을 실행했다고 하지 마.

> 보관함에서 제목에 당근이 들어가는 작품을 찾아줘.

실제 `carrot_list_works`, `carrot_get_chapter`, `carrot_get_page_preview` 등의 도구 호출이 보이는지 확인하세요. 이미지 표시와 비전 판독은 클라이언트/모델의 지원에 따라 다릅니다. PNG 진단이 성공하지만 채팅에 그림이 표시되지 않는 경우를 서버의 이미지 생성 실패와 혼동하지 마세요.

CLI나 IDE는 토큰을 읽은 환경에서 시작해야 합니다. 이미 열려 있던 IDE가 새 PowerShell의 환경변수를 자동으로 받지는 않습니다. 먼저 CLI로 시험하는 편이 단순합니다.

공식 설정 근거: [Codex MCP 문서](https://developers.openai.com/codex/mcp/).

## 6. 선택 사항: Cloudflare 임시 터널로 시험하기

**로컬 진단이 통과한 뒤에만 진행하세요.** 터널은 인터넷에서 로컬 서버로 가는 경로를 만듭니다. 인증 토큰이 필요한 점은 바뀌지 않으며, 이 단계가 ChatGPT 웹 OAuth 연결을 제공하는 것은 아닙니다.

Cloudflare 공식 안내에 따라 `cloudflared`를 설치한 뒤, 터널 전용 터미널에서 실행합니다.

```powershell
cloudflared tunnel --url http://127.0.0.1:38475
```

출력되는 `https://...trycloudflare.com` 주소를 복사합니다. 이 창을 유지하세요. 앱 실행 터미널에서는 개발 앱을 정상 종료한 뒤, **실제로 발급된 주소**를 환경변수에 넣고 재실행합니다. 아래 `YOUR-TUNNEL`은 반드시 바꿔야 합니다.

```powershell
$env:CARROT_MCP_PUBLIC_ORIGIN = "https://YOUR-TUNNEL.trycloudflare.com"
node scripts/mcp-dev.cjs --images
```

`CARROT_MCP_PUBLIC_ORIGIN`에는 `/mcp`를 붙이지 않습니다. 서버는 이 정확한 호스트만 허용합니다. 임의의 전달 헤더를 신뢰하거나 `*.trycloudflare.com` 전체를 허용하지 않습니다.

진단 터미널에서 같은 터널의 `/mcp` 주소를 지정합니다.

```powershell
$env:CARROT_MCP_URL = "https://YOUR-TUNNEL.trycloudflare.com/mcp"
node scripts/mcp-smoke.mjs --first-preview
```

여기까지 성공하면 공용 HTTPS 경로를 통한 인증·도구·이미지 전송을 직접 확인한 것입니다. 원격 클라이언트에는 공용 `/mcp` 주소와 같은 Bearer 토큰을 설정합니다. 토큰을 URL의 쿼리나 채팅창에 넣지 마세요.

임시 터널 주소는 재실행할 때 바뀔 수 있습니다. 그때는 앱의 `CARROT_MCP_PUBLIC_ORIGIN`과 클라이언트 URL도 함께 바꾸고 앱을 다시 시작해야 합니다. Quick Tunnel은 SSE를 지원하지 않아 이번 서버는 JSON 응답만 사용합니다. 방화벽, 프록시, 기존 cloudflared 설정에 따른 실패도 있을 수 있습니다.

공식 근거: [Quick Tunnel 안내와 제한](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/), [MCP 2025-11-25 HTTP 전송 규격](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).

## 7. 자주 만나는 오류

| 증상                              | 확인할 것                                                                                                                  |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `fetch failed`, 연결 거부         | 개발 앱과 실행 터미널이 살아 있는지, 앱 초기화가 끝났는지, 포트가 맞는지 확인하세요.                                       |
| 토큰 파일 `ENOENT`                | 먼저 같은 복제 폴더의 `mcp-dev.cjs`를 실행하세요. 직접 토큰 환경변수를 사용했다면 두 번째 터미널에도 같은 값을 설정하세요. |
| 401                               | 앱과 클라이언트의 토큰이 다릅니다. 다른 복제 폴더의 토큰을 읽지 않았는지 확인하세요.                                       |
| 403                               | 공용 호스트/Origin이 허용되지 않았습니다. 실제 터널 주소를 앱 실행 전에 설정하고 재시작하세요.                             |
| 404                               | URL 끝이 정확히 `/mcp`인지 확인하세요. 토큰 쿼리는 허용하지 않습니다.                                                      |
| 브라우저에서 401 또는 405         | 주소 표시줄 방문은 인증된 MCP POST 요청이 아닙니다. 진단 명령으로 시험하세요.                                              |
| `Unknown tool` / 이미지 도구 없음 | 앱을 `--images`로 재실행하고 클라이언트 연결도 다시 시작하세요.                                                            |
| 미리보기 `isError`                | 가리기 검토, 파일 변경, 이미지 크기 제한 등을 앱 로컬 로그에서 확인하세요. 보호를 우회하지 마세요.                         |
| 작품이 0개                        | 시험용 개발 보관함이 비어 있으면 정상입니다. 정식 앱의 기존 보관함과 별개입니다.                                           |
| 포트 사용 중                      | 기존 시험 앱을 종료하세요. 포트를 바꾸면 앱, 진단, 클라이언트, 터널 설정도 일치시켜야 합니다.                              |
| `npm.ps1` 실행 정책 오류          | 정책을 전역으로 낮추지 말고 `npm.cmd ci`를 사용하거나 명령 프롬프트에서 실행하세요.                                        |

오류를 공유할 때는 `git rev-parse --short HEAD`, `node --version`, 실패한 단계와 토큰을 뺀 오류 메시지를 보내세요. `.tmp/mcp-local-token`과 실제 개인 이미지, 보관함의 민감한 제목은 보내지 마세요.

## 8. 종료·권한 회수·업데이트

개발 앱을 정상 종료하고 개발 터미널도 종료합니다. 터널은 터널 전용 터미널에서 `Ctrl+C`로 종료합니다. 서버가 꺼지면 더 이상 MCP로 접근할 수 없습니다.

토큰을 새로 만들려면 **앱을 먼저 종료한 뒤** `.tmp/mcp-local-token` 파일만 삭제하고 실행기를 다시 시작하세요. 실행 중에 파일만 지워도 메모리에 있는 기존 토큰이 즉시 폐기되지는 않습니다. 원격 클라이언트의 토큰도 새 값으로 갱신해야 합니다.

같은 시험 폴더의 다음 커밋을 받으려면 앱을 종료한 상태에서 실행합니다.

```powershell
git status --short
git pull --ff-only
npm ci
node scripts/mcp-dev.cjs --images
```

직접 수정한 파일이 있다면 강제 초기화하지 말고 먼저 별도로 보존하세요. 보관함과 원본 폴더는 정리 대상으로 지우지 마세요.

## 개발자 검증 명령

```powershell
node node_modules/vitest/vitest.mjs run tests/mcp
npm run typecheck
npm run typecheck:electron
npm run typecheck:js
npm run build
node node_modules/electron/cli.js scripts/mcp-electron-smoke.cjs
```

Electron 검사는 `.tmp/mcp-native-*`에 컴파일된 코드만 복사한 임시 데이터 루트를 만들고 기존 가져오기 서비스로 합성 이미지 한 장을 등록합니다. 실제 사용자 보관함을 복사하거나 변경하지 않습니다. Linux CI에서는 같은 검사를 `xvfb-run -a`로 감쌉니다. 이는 실제 MCP 런타임과 이미지 처리 검증이지 전체 앱 UI, 실제 Codex 모델, 실제 Cloudflare 터널의 종합 검증은 아닙니다.

macOS에서는 설치/실행 및 진단 명령은 같습니다. 셸 환경변수는 `export CARROT_MCP_TOKEN="$(cat .tmp/mcp-local-token)"` 형식을 사용합니다. 기존 앱의 Apple Silicon/macOS 요구사항을 따르며 개발 실행기가 필요한 네이티브 도구 준비를 요청할 수 있습니다.
