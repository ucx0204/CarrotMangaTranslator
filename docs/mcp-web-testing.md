# ChatGPT 웹에서 당근 MCP 연결하기

이 안내는 `feat/mcp-app-bridge`의 개인용 읽기 전용 시험판입니다. Codex 할당량이나 API 키 없이 **현재 ChatGPT 웹 대화의 모델**로 연결을 시험하기 위한 경로입니다. 앱의 Codex 엔진을 호출하는 경로가 아닙니다. ChatGPT 자체의 이용 한도, 개발자 모드 및 워크스페이스 권한은 별개입니다.

## 가능한 것과 아직 아닌 것

작품 검색, 화 목록, 페이지 정보, 원본 축소 PNG 미리보기를 제공합니다. 이미지가 연결된 모델에 전달되면 ChatGPT에게 원문 판독이나 채팅 안의 번역을 부탁할 수 있습니다. 앱에 번역 결과 저장, 앱 OCR/번역 실행, 제거, 효과음 생성, ZIP 출력은 아직 아닙니다. 원격 쓰기 도구는 없습니다.

현재는 개인용 개발자 MCP 연결입니다. 공식 플러그인 디렉터리에 공개 출시하거나 등록 심사를 완료했다는 뜻이 아닙니다. 별도 채팅 UI 위젯도 아직 없으며, 이미지의 표시 방식은 호스트에 따라 다릅니다.

## 1. 시험 폴더 업데이트

기존 시험 앱과 개발 터미널을 정상 종료합니다. 이전에 사용한 폴더의 PowerShell에서 실행합니다.

```powershell
cd $HOME\CarrotMangaTranslator-MCP-Test
git branch --show-current
git status --short
git pull --ff-only
npm.cmd ci
```

브랜치는 `feat/mcp-app-bridge`여야 합니다. 직접 수정한 파일이 있다면 보존하고, 강제 초기화하거나 보관함을 지우지 마세요. 설치된 정식 앱이 아니라 이 시험 폴더의 보관함을 사용합니다. 개인 자료가 없는 테스트 원고로 먼저 확인하세요.

## 2. cloudflared 준비

```powershell
cloudflared --version
```

명령이 없으면 Cloudflare 공식 다운로드 안내에서 Windows용 `cloudflared`를 설치하고 새 터미널을 여세요. PATH에 넣지 않았으면 실행 파일의 실제 위치를 지정할 수 있습니다.

```powershell
$env:CARROT_CLOUDFLARED_PATH = "C:\Tools\cloudflared.exe"
```

위 경로는 예시입니다. 실제 내려받은 파일 위치로 바꾸세요. 실행기는 바이너리를 몰래 다운로드하거나 시스템 서비스로 설치하지 않습니다. Cloudflare 계정·도메인 없이 Quick Tunnel을 사용하는 시험 경로입니다.

공식 다운로드: https://developers.cloudflare.com/tunnel/downloads/
Quick Tunnel: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/

## 3. 웹 연결 모드로 앱 실행

```powershell
node scripts/mcp-web.cjs --images
```

실행기는 Cloudflare 임시 터널을 시작하고, 발급된 정확한 HTTPS 호스트를 앱에 설정한 뒤 기존 개발 앱을 실행합니다. Vite 개발 화면이나 파일 서버가 아니라 인증된 MCP 포트만 연결합니다. 가리기 검토 규칙은 그대로 유지됩니다.

출력에서 다음 항목을 찾으세요.

```text
[mcp-web] ChatGPT server URL: https://실제발급주소.trycloudflare.com/mcp
...
[mcp-web] READY: public OAuth discovery responds. ...
```

`READY`는 실제 공개 주소의 OAuth 메타데이터가 응답했다는 뜻입니다. ChatGPT까지 연결됐다는 뜻은 아닙니다. 이 터미널과 앱을 유지하세요. 공개 URL이 응답하기 전에는 ChatGPT에 추가하지 마세요.

이미지를 보내지 않으려면 `--images` 없이 실행합니다. 이미지 허용은 읽기 권한과 함께 해당 시험 보관함의 페이지를 외부로 보낼 수 있게 하므로, 공개 가능한 자료에만 사용하세요.

실행기는 다음 파일을 만듭니다.

- `.tmp/mcp-web-connection.json`: 공개 연결 주소. 비밀 토큰은 포함하지 않습니다.
- `.tmp/mcp-web-password`: 이번 실행의 연결 암호. **비밀번호처럼 취급하세요.**

연결 암호는 기존 `.tmp/mcp-local-token`과 다릅니다. 두 파일 모두 공유하거나 커밋하지 마세요. Windows에서는 폴더의 접근 권한을 따르므로 공유 폴더를 사용하지 마세요. 암호는 매번 새로 만들고 OAuth 토큰은 메모리에만 유지합니다.

## 4. 모델 없이 웹 인증부터 진단

두 번째 PowerShell을 같은 폴더에서 열고 실행합니다.

```powershell
node scripts/mcp-web-smoke.mjs
```

진단은 공개 HTTPS 경로에서 다음 흐름을 실행합니다.

```text
PASS public OAuth discovery and unauthenticated access rejection
PASS consent cookie, connection password and PKCE code exchange
PASS refresh-token rotation
PASS authenticated MCP handshake, 5 tools, capabilities and library read
PASS diagnostic grant revoked; app data was not modified
PASS web connection diagnostic complete; no Codex or model API was used
```

이미지 비허용 상태에서는 도구가 4개입니다. 진단용 OAuth 권한은 검사 후 폐기되며, 앞으로 연결할 ChatGPT 권한을 지우지는 않습니다. 원본 이미지를 다운받거나 OCR·번역 모델을 실행하지 않습니다. 이 진단은 ChatGPT 웹 UI 자체를 자동 조작하는 검사는 아닙니다.

## 5. ChatGPT 웹에서 플러그인/MCP 추가

OpenAI 개발 문서 기준으로 설정의 **Security and login → Developer mode**를 켜고, **Plugins 화면의 +**에서 MCP 연결을 추가합니다. UI 배포나 워크스페이스에 따라 **Settings → Apps → Advanced settings → Developer mode**, **Apps → Create**로 표시될 수도 있습니다. 메뉴가 없다면 계정/워크스페이스의 개발자 모드 권한을 확인하세요. 모델을 바꾸거나 Codex에 로그인하는 것으로 이 권한이 생기지는 않습니다.

연결 입력값:

| 항목                      | 입력                                              |
| ------------------------- | ------------------------------------------------- |
| 이름                      | 당근망가번역기 테스트                             |
| 설명                      | 로컬 당근 앱의 보관함 조회와 원본 페이지 미리보기 |
| 연결 방식                 | 공개 HTTPS MCP / Streamable HTTP                  |
| 서버 URL                  | 터미널에 나온 실제 주소 전체, 끝의 `/mcp` 포함    |
| 인증                      | OAuth                                             |
| 등록 방식 선택이 있으면   | Dynamic Client Registration / DCR                 |
| Client ID / Client Secret | 직접 넣지 말고 비워 두기                          |

서버는 OAuth discovery, DCR, PKCE S256, 갱신 토큰을 제공합니다. CIMD는 광고하지 않습니다. '인증 없음'을 선택하거나, 연결 암호를 Client Secret 칸에 넣지 마세요. 원격 MCP 도구 호출에는 항상 인증이 필요합니다.

### 승인 페이지에서 암호 입력

추가/도구 스캔/연결 과정에서 당근 연결 승인 페이지가 열립니다. 주소가 **직접 실행한 터미널의 HTTPS 호스트와 같은지** 확인합니다. 요청 권한은 보관함 읽기이며 이미지 허용 여부는 실행기의 `--images` 설정에 따릅니다.

두 번째 PowerShell에서 암호를 클립보드에 복사합니다. 화면에 출력하지 않는 명령입니다.

```powershell
(Get-Content -Raw .\.tmp\mcp-web-password).Trim() | Set-Clipboard
```

이 암호를 **당근 승인 페이지의 '로컬 연결 암호'**에만 붙여넣고 연결 승인을 누릅니다. ChatGPT 대화 입력창, GitHub, 타인의 승인 페이지에는 보내지 마세요. OpenAI 로그인 비밀번호나 API 키가 아닙니다.

정상적으로 돌아오면 도구 스캔/생성을 완료합니다. 브라우저 쿠키가 차단되었거나 승인 페이지가 만료됐으면 연결을 처음부터 다시 시작하세요. OAuth 클라이언트마다 등록된 콜백과 정확히 일치해야 하며, 이 시험판은 문서화된 ChatGPT 콜백만 허용합니다.

공식 연결 절차: https://developers.openai.com/plugins/deploy/connect-chatgpt
인증 규격: https://developers.openai.com/plugins/build/auth
메뉴/권한 안내: https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt

## 6. 새 채팅에서 사용

새 일반 채팅을 열고 도구/플러그인 메뉴에서 방금 만든 당근 연결을 추가합니다. 먼저 다음 요청을 시험하세요.

> 당근망가번역기 MCP의 기능을 확인하고 보관함 작품과 화 목록을 보여줘. 추측하거나 파일시스템을 직접 읽지 말고 실제 MCP 도구를 사용해.

이미지 전송을 켰다면:

> 첫 작품의 첫 화에서 첫 페이지 미리보기를 당근 MCP로 가져와서 원문을 직접 읽고 한국어로 번역해줘. 앱에는 아직 저장하지 말고 이 채팅에만 보여줘.

`carrot_get_capabilities`, `carrot_list_works`, `carrot_list_chapters`, `carrot_get_chapter`, `carrot_get_page_preview` 호출을 확인합니다. 기능 조회의 `oauth=true`, `translation=false`는 정상입니다. ChatGPT의 직접 판독을 앱 OCR이나 앱 번역 실행으로 오해하지 마세요.

MCP 원본 미리보기는 최대 1600픽셀 축소 PNG이고 앱에 저장된 가리기 검토가 필요하면 전송을 차단합니다. 작은 글자를 못 읽거나 채팅 UI가 그림을 펼치지 않는 문제는 인증 성공 여부와 별도로 구분하세요. 확대 조각, 가리기 승인 UI 연동과 번역 저장은 후속 단계입니다.

## 7. 종료와 다시 연결

앱을 정상 종료하거나 실행 터미널에서 Ctrl+C로 개발 실행을 종료합니다. 실행기가 소유한 터널도 종료됩니다. 강제 종료/시스템 장애 후에는 작업 관리자에서 남은 개발 앱/`cloudflared` 프로세스를 확인하세요. 다른 용도로 실행 중인 터널을 일괄 종료하지 마세요.

새 실행은 새 임시 URL과 새 연결 암호를 만듭니다. OAuth 세션도 초기화되므로 **이전 ChatGPT 연결 주소를 새 주소로 바꾸고 다시 인증하거나 연결을 새로 만드세요.** 기존 임시 주소를 영구 URL처럼 사용하지 마세요. 접근 토큰은 최대 1시간, 갱신 가능한 승인 범위는 최대 24시간이며 앱 재시작 시 더 일찍 폐기됩니다.

## 문제 해결

| 증상                                | 확인                                                                                                      |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------- |
| cloudflared를 찾지 못함             | 설치/PATH 또는 `CARROT_CLOUDFLARED_PATH` 실제 실행 파일 위치                                              |
| 포트 사용 중                        | 이전 로컬 시험 앱을 먼저 정상 종료                                                                        |
| Quick Tunnel 주소가 안 나옴         | 네트워크/방화벽/프록시, 기존 `.cloudflared/config.yml` 영향 확인. 실행기는 기존 설정 파일을 수정하지 않음 |
| READY가 안 나옴                     | 앱 빌드/초기화 오류, 터널 DNS 및 외부 접속 상태 확인                                                      |
| OAuth 진단 FAIL                     | 마지막 PASS 단계, 실행 중인 앱과 `.tmp` 파일이 같은 실행에서 나온 것인지 확인                             |
| ChatGPT에서 인증 없음으로 연결 실패 | OAuth / DCR로 새 연결 생성                                                                                |
| Client ID/secret 입력 요구          | 등록 방식이 DCR인지 확인. 연결 암호를 이 칸에 넣지 않기                                                   |
| 승인 암호 오류                      | 현재 실행이 만든 `mcp-web-password`를 다시 복사하고 승인 흐름을 처음부터 시작                             |
| callback 오류                       | 실제 ChatGPT 관리 화면의 callback URL과 경로를 확인. 임의 도메인 허용으로 우회하지 않기                   |
| OAuth 재연결 요구                   | 앱 재시작/세션 만료/임시 URL 변경 여부 확인                                                               |
| 미리보기만 실패                     | 가리기 검토, 페이지 크기/파일 상태 확인. 보호 기능을 끄고 개인 자료를 보내지 않기                         |

오류 공유 시 커밋(`git rev-parse --short HEAD`), 실패 단계, 상태 코드만 먼저 공유하세요. 암호 파일, 토큰, OAuth 승인 URL의 `code`/`state`, 실제 개인 이미지는 공유하지 마세요.

## 개발·검증 범위

OAuth는 이 앱 인스턴스에만 적용되는 개인용 개발 인증입니다. 다중 사용자 계정 시스템, OIDC, 기업 도메인 정책, 영구 세션 저장, 공개 제품용 보안 심사를 대신하지 않습니다. 코드 테스트, 실제 HTTP 검사, 실제 Electron 검사, 실제 Cloudflare HTTPS 검사, 사용자의 실제 ChatGPT UI 연결을 별도 검증 항목으로 기록합니다. 하나의 통과를 다른 항목의 통과로 표시하지 않습니다.
