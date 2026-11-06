# Grok Build 앱 채팅 연결

현재 공식 Grok Build CLI 1.0.77을 첫 연결 시 내려받아 앱 채팅에서 사용한다.
설정의 AI 앱 연결(MCP) → 앱 채팅 · Grok 계정에서 로그인하며 채팅의 도우미 선택에서
Grok을 고른다. 직접 OCR/번역 엔진이나 이미지 생성 provider를 새로 등록한 것은 아니다.
앱 채팅은 기존 당근 MCP 도구로 보관함 조회, 번역, 편집을 요청할 수 있다.

## 공식 경로와 설치

- [공식 ACP 안내](https://docs.x.ai/build/cli/headless-scripting)의 `grok agent stdio`를 사용한다.
- [공식 소스](https://github.com/xai-org/grok-build)와 공식 `@xai-official/grok` 플랫폼 패키지를 사용한다.
- Windows x64 및 macOS arm64 npm archive의 byte size/SHA-256은
  `src/main/runtimeSupport/cliRuntimePlan.ts`가 권위다. 사전 검증에서 registry SHA-512도 대조했다.
- 첫 연결 시 archive 검증 → 안전한 tar 추출 → 공식 Brotli binary 해제 → 버전/파일 검사 →
  원자적 게시를 수행한다. upstream THIRD_PARTY_NOTICES와 기타 파일을 보존한다.
- 로그인·세션은 data root의 `grok/`, 실행 파일은 `cli-runtimes/grok/`에 둔다.
  둘 다 Git 및 installer에 포함하지 않는다. 설정 조회/로그아웃은 미설치 상태에서 다운로드하지 않는다.
- 공식 `grok login --oauth`/`grok logout`을 호출한다. 앱은 토큰을 읽거나 Grok 웹 쿠키를 사용하지 않는다.
  계정 조회는 ACP initialize의 cached_token 광고만 확인하며 브라우저 인증을 시작하지 않는다.
- CLI 재배포 대신 사용자 기기에서 공식 배포본을 내려받는 구조다. 이것이 모든 향후 약관이나
  구독 조건을 보장하는 것은 아니며, CLI 업데이트 시 공식 약관과 배포 라이선스를 재확인한다.

## ACP 계약과 이미지

1.0.62는 initialize에서 `promptCapabilities.image: false`를 반환하지만, 실제
`session/prompt`의 표준 `{type:"image", mimeType, data}` 입력을 처리한다.
이미지를 제외하거나 UI 첨부를 비활성화하지 않는다. 잘못된 data URL은 명시적으로 실패한다.

직접 만든 PNG에만 기록한 `CARROT 58319`, 빨간 원, 파란 사각형을 실제 CLI가 인식했다.
production GrokChatRuntime에서도 이미지와 MCP 도구 결과 `ORANGE-7193`를 함께 답했고,
프로세스를 종료한 뒤 session/load로 이어받아 원래 이미지 문자를 다시 답했다.
공식 소스의 `session/acp_session_impl/prompt_build.rs` 및 `session/image_describe.rs`에
이미지 처리 경로가 있다. 다음 CLI 버전의 capability 표기만으로 지원을 제거하지 말고
반드시 실제 이미지 smoke를 재실행한다. 작은 도형/문자 테스트는 만화 OCR 품질 평가를 대신하지 않는다.

프로필에는 ask_user_question, search_tool, use_tool만 포함한다. 당근 MCP는 세션 생성/복원
요청에 HTTP bearer header로 전달하며 프로필 파일에 토큰을 저장하지 않는다. 권한 요청에서
현재 세션의 `carrot__` 도구만 허용하고 다른 도구 및 파일/터미널 역방향 요청은 거부한다.
질문은 기존 앱 질문 UI로 전달한다. reasoning chunk는 앱 대화에 저장하지 않는다.

## 검증과 유지보수

### 2026-11-06 런타임 갱신

Grok 1.0.77, Codex 0.167.0, Claude Code 2.1.318(Agent SDK 0.3.318)로
고정 버전을 갱신했다. Windows x64/macOS arm64의 공식 npm archive 6개를
다운로드해 registry SHA-512, 실제 byte size/SHA-256, 내부 package version과
실행 파일 경로를 검증했다. 다운로드 URL과 검증 값의 권위는 `cliRuntimePlan.ts`다.

Windows의 빈 임시 data root에서 production installer의 원격 설치, `--version`,
재다운로드 없는 재사용을 확인했다. production adapter로 Codex App Server
initialize/account read, Claude SDK initialize/models, Grok ACP initialize가
통과했다. 관련 테스트 10개 파일/104개와 빌드가 통과했다. 검증 로그와 manifest는
`.tmp/cli-update-20261106/`에 보존한다. 이번 검증은 설치와 연결 초기화이며
실제 모델 응답·이미지·MCP 도구 호출과 macOS CLI 실행은 재검증하지 않았다.
Grok 이미지 smoke는 기존 검증용 계정이 미로그인 상태라 모델 요청 전에 중단됐다.

### 2026-10-27 런타임 갱신

Grok 1.0.70, Codex 0.164.0, Claude Code 2.1.311(Agent SDK 0.3.311)로
고정 버전을 갱신했다. Windows x64/macOS arm64의 공식 npm archive 6개를
다운로드해 registry SHA-512, 실제 byte size/SHA-256, 내부 package version을
검증했다. 다운로드 URL과 검증 값의 권위는 `cliRuntimePlan.ts`다.

Windows의 빈 임시 data root에서 세 런타임의 production installer로 실제 원격
설치, `--version`, 재다운로드 없는 재사용을 확인했다. production adapter로
Codex App Server initialize/account read, Claude SDK initialize/models,
Grok ACP initialize가 통과했다. 관련 테스트 8개 파일/106개와 타입 검사·빌드가
통과했다. 검증 로그와 manifest는 `.tmp/cli-update-20261027/`에 보존한다.
이번 범위는 설치와 연결 초기화이며 실제 모델 응답·이미지·MCP 도구 호출과
macOS 실행은 재검증하지 않았다. 아래는 최초 통합 당시의 검증 기록이다.

- `tests/grokRuntime.test.ts`: ACP 분할 응답, 오류/시간 초과/종료, 이미지 전달,
  모델·추론 선택, 세션 복원, MCP 권한, 질문/취소, 텍스트·도구 순서.
- `tests/grokAccountLifecycle.test.ts`: 공식 로그인, 다운로드 진행률, 조회 병합,
  실패/취소, 프로필 제한 및 기존 계정 작업 registry 연결.
- `tests/managedCliRuntime.test.ts`: Grok Brotli 실행 파일 설치, 무결성 계약 및 재사용.
- `tests/grokAppChatUi.test.tsx`: Grok 선택/로그인/진행률, 실제 이미지 첨부와 imageIds 전달.
- 실제 최종 실행 기록: `.tmp/grok-integration-audit/production-final-smoke.log`.
  이미지와 MCP, 모델/추론 설정, 재연결 후 기억, `/compact`가 모두 통과했다.
- 개발 앱을 정상 재시작해 Grok 4.7을 선택하고 실제 첨부 버튼으로 테스트 PNG를 보냈다.
  이미지의 `CARROT 58319`와 두 도형을 읽었으며 `carrot_get_server_info`를 호출해
  앱 버전 3.4.2를 답했다. 보관함 자료를 조회하거나 변경하지 않은 검증이다.
  실제 성공 화면: `C:/tmp/grok-app-live-image-mcp.png`.
- 최종 `MGT_VITEST_MAX_WORKERS=4 npm run check`: 10,998 passed / 9 skipped,
  커버리지 기준, 타입/린트/구조 검사, 빌드 및 후속 smoke 모두 통과.
  앞선 12-worker 실행의 파일 복원 시간 초과는 4-worker 전체 실행에서 통과했으며
  테스트 시간 제한이나 커버리지 기준을 낮추지 않았다.
- Windows thin unpacked package와 `verify-packaged-runtime.cjs` 통과
  (329 files, 885.1 MiB). 패키지의 Electron/production 모듈로 빈 data root에
  Grok 1.0.62를 공식 URL에서 설치하고 ACP 초기화 및 재다운로드 없는 재사용을 확인했다.
  기록: `.tmp/grok-integration-audit/packaged-grok-smoke.log`.
  macOS arm64는 배포 archive 무결성/설정 검증만 수행했으며 실제 실행은 이 PC에서 하지 않았다.
- Claude Code가 UI를 작성하고 production 컴포넌트의 넓은/좁은 캡처를 생성했다.
  `C:/tmp/grok-app-claude-chat-image-composer-wide.png`,
  `C:/tmp/grok-app-claude-chat-image-composer-narrow.png` 등.

새 계정 계약을 기존 IPC 권위에 직접 등록해 ipcContractCore 소비자 26, ipcContracts import 17,
trustedIpc 소비자 31, settingsIpc import 15를 개별 기록했다. 전역 예산은 변경하지 않는다.
문제 발생 시 Grok 선택을 사용하지 않고 기존 Claude/Codex로 전환한다. 사용자 로그인·대화·보관함
데이터를 삭제하는 롤백이나 게시 자산 덮어쓰기를 수행하지 않는다.
