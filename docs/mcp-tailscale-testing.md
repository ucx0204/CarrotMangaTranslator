# Tailscale MCP 직접 테스트

작업 브랜치는 **`feat/mcp-app-bridge` 하나**입니다. PR #96은 초안이며 정식 릴리스를 새로 게시하지 않았습니다. 외부 연결은 **Tailscale Funnel만** 사용합니다. Cloudflare 설치·실행과 기존 암호 클립보드 절차는 필요하지 않습니다.

## 코드 업데이트

이전에 사용한 시험용 당근 앱과 개발 실행을 종료합니다. 같은 시험 폴더에서 작업합니다. 보관함·원본·출력물을 지우거나 강제 초기화하지 마세요.

```powershell
cd $HOME\CarrotMangaTranslator-MCP-Test
git status --short
git switch feat/mcp-app-bridge
git pull --ff-only
npm.cmd ci
npm.cmd run dev
```

직접 수정한 파일 때문에 Git이 거부하면 강제 실행하지 않습니다. 이전 ZIP의 별도 브랜치 생성·패치 적용 안내는 폐기되었습니다. 현재 코드는 원래 MCP 브랜치에 통합되어 있으므로 추가 브랜치나 bundle 적용이 필요 없습니다.

## 최초 Tailscale 준비

Tailscale을 PC에 설치하고 본인 계정으로 로그인합니다. 해당 tailnet의 HTTPS·Funnel 허용은 최초 한 번 사용자가 완료해야 합니다. 당근은 Tailscale 계정 비밀번호를 받거나 다른 공유 경로를 자동 초기화하지 않습니다. 기본 설치 경로가 아니라면 `CARROT_TAILSCALE_PATH`에 실행 파일의 절대 경로를 지정할 수 있습니다.

동일한 Tailscale 장치·tailnet 이름을 유지하는 동안 같은 HTTPS 주소를 사용합니다. 이름 변경이나 장치 재등록은 주소를 바꿀 수 있습니다. 기존 Cloudflare 플러그인을 사용했다면 **Tailscale 주소로 최초 한 번 새로 연결**해야 하며, 이전 주소의 권한을 새 서버 식별자로 자동 이전하지 않습니다.

## 앱에서 연결

1. **설정 → AI 연결 / MCP**를 엽니다. 처음에는 공개 가능한 시험 원고를 사용하세요.
2. 필요하면 **원본 페이지 이미지 전송 허용**, **기존 블록의 번역문 수정 허용**을 켭니다. 이미지·편집·자동 실행은 기본적으로 꺼져 있습니다. 편집을 시험할 때는 최초 OAuth 승인 전에 편집 허용을 켜는 편이 간단합니다.
3. **MCP 켜기**를 누릅니다. 설치·로그인 안내가 나오면 Tailscale에서 완료합니다. **Tailscale에서 Funnel 허용** 버튼이 나타나면 본인 계정에서 허용한 후 다시 켭니다.
4. **연결 진단**으로 공개 HTTPS 주소와 OAuth 메타데이터, 무인증 접근 차단을 확인합니다. 진단은 모델·Codex 할당량을 사용하지 않고 보관함이나 암호를 전송하지 않습니다.
5. **새 연결 허용 · 5분**을 누르고 **고정 주소 복사**로 `/mcp`가 포함된 주소를 복사합니다.
6. ChatGPT의 사용자 지정 MCP/플러그인 생성 화면에 주소를 넣고 **OAuth / Dynamic Client Registration**을 사용합니다. **Client ID·Client Secret은 비워 둡니다.**
7. 브라우저의 확인 코드와 앱에 표시되는 요청의 코드·권한을 대조하고 **앱에서 같은 코드 확인 · 승인**을 누릅니다. 클라이언트 이름은 요청자가 입력한 표시값이지 신원 보증은 아닙니다.
8. 브라우저가 ChatGPT로 돌아오면 새 대화에서 이 연결을 선택합니다. 자동 확인이 멈춘 경우 브라우저의 **승인 결과 확인**을 누릅니다. 암호 파일이나 API 키를 채팅에 붙여넣지 않습니다.

현재 이 승인 범위는 실행 중인 보관함 전체입니다. 작품별 권한 제한은 아직 구현하지 않았습니다. 이미지 전송은 별도 scope와 기존 가리기 보호를 모두 지켜야 합니다. 가리기 검토가 필요한 이미지는 원격 도구로 우회할 수 없습니다.

## 조회와 기존 번역문 수정

먼저 작품·화 목록과 이미지 미리보기의 실제 도구 호출을 확인합니다. 편집 시험은 **기존 앱에서 OCR/번역 블록이 이미 만들어진 페이지**를 사용합니다. 미저장 편집을 저장하고 충돌할 수 있는 앱 작업을 종료하세요.

> 당근 MCP로 시험 작품의 블록이 있는 페이지를 찾아 원문·번역문·블록 ID를 읽어줘. 아직 수정하지 마.

> 방금 읽은 페이지에서 지정한 대사의 번역문만 ‘안녕하세요.’로 고쳐서 당근 앱에 저장해줘. 위치·글꼴·원문은 바꾸지 말고 최신 revision을 사용해.

`carrot_get_page_blocks`와 `carrot_update_translations` 호출 및 앱 화면 반영을 확인합니다. 이 도구는 현재 AI가 작성한 번역문을 기존 블록에 저장하며 Codex나 별도 유료 모델을 실행하지 않습니다. OAuth 승인에 `carrot.edit`가 없으면 새 승인이 필요합니다. 앱 옵션만 바꿔 기존 승인 권한을 몰래 확장하지 않습니다.

오래된 revision으로 다른 내용을 저장하려 하면 충돌로 반환하는 것이 정상입니다. 같은 문장이 이미 적용된 재시도는 `already_applied`로 끝납니다. 저장 결과의 이전 번역문과 최신 revision으로 명시적으로 되돌릴 수 있지만, 이후 사용자 편집을 덮어쓰면 안 됩니다.

**신규 블록 생성·OCR만 실행·원문 제거만 실행·실제 렌더링·PNG 출력은 [한 페이지 완성 테스트](mcp-page-testing.md)에 추가했습니다.** 새 블록과 로컬 처리에는 별도 `carrot.process` 승인이 필요합니다. 앱 번역 모델 실행, 효과음 이미지 생성과 한 화 ZIP은 아직 후속 기능입니다. 원본 미리보기와 완성 렌더링을 구분하세요.

## 유지·끄기·철회 확인

**MCP 끄기 → 다시 켜기 → 앱 완전 종료·재시작**을 차례로 시험합니다. 고정 주소와 유효한 승인 정보는 유지되어야 하며 플러그인을 매번 삭제하고 등록하지 않아야 합니다. 끈 상태에서는 도구 호출이 실패해야 합니다.

승인된 클라이언트와 권한은 운영체제 암호화된 `mcp-private/authorization.enc`에 보존합니다. 접근 토큰은 최대 1시간, 회전하는 갱신 토큰은 마지막 발급 후 90일 만료입니다. 장기 미사용·철회·주소 변경에는 재승인이 필요할 수 있습니다. 암호화 불가나 파일 손상 시 평문 저장·무인증 접속으로 전환하지 않습니다.

**연결 권한 철회** 후 이전 인증이 거부되고 재시작 후에도 철회 상태가 유지되는지 확인하세요. MCP 끄기는 승인 삭제가 아니며, 철회는 해당 연결의 접근·갱신 권한 폐기입니다.

Tailscale의 HTTPS 443이 다른 공유 경로에 사용 중이면 당근이 중단합니다. 앱은 `tailscale funnel reset`이나 시스템 Tailscale 전체 종료를 실행하지 않습니다. 종료가 실패하면 차단된 로컬 포트를 유지해 다른 프로세스가 공개 경로를 물려받지 못하게 하므로, 오류를 확인한 뒤 **MCP 끄기**로 정리를 재시도합니다.

## 개발자 검사와 검증 범위

```powershell
node node_modules/vitest/vitest.mjs run tests/mcp tests/libraryBatchPageSave.test.ts tests/pageRevision.test.ts tests/chapterSync.test.ts tests/liveChapterRefreshCoordinator.test.ts
npm.cmd run build
node node_modules/electron/cli.js scripts/mcp-electron-smoke.cjs
node scripts/mcp-ui-qa.cjs
```

기본 native smoke는 실제 보관함 대신 합성 원고·격리된 데이터 루트를 사용하며, Windows OS 암호화 저장·복원·갱신·오프라인 철회도 검사합니다. UI QA는 실제 production 컴포넌트와 스타일을 불러와 넓은 창·좁은 창·승인·오류 상태를 캡처합니다. 실제 Tailscale 계정이나 로그인된 ChatGPT 세션을 사용한 검사는 별도입니다.

기존 앱과 MCP를 종료한 상태에서 `CARROT_MCP_SMOKE_TAILSCALE=1`을 명시하면 설치·로그인된 Tailscale로 합성 보관함을 일시 공개하는 선택 검사가 가능합니다. 이는 별도 계정 설정이 필요하며 자동 통과한 것으로 간주하지 않습니다. 현재 결과와 정확한 커밋은 [통합 상태](mcp-integration-status.md) 및 PR #96을 확인하세요.

공식 안내: [Tailscale Funnel](https://tailscale.com/docs/features/tailscale-funnel), [Funnel CLI](https://tailscale.com/docs/reference/tailscale-cli/funnel), [ChatGPT 연결](https://developers.openai.com/plugins/deploy/connect-chatgpt), [OAuth/DCR](https://developers.openai.com/plugins/build/auth).
