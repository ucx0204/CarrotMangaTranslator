# 코드 경계와 품질 규칙

## 2026-11-06 시작 로그의 앱·빌드 식별

`app.log`와 `bootstrap.log`의 시작 기록에 Electron의 앱 버전, 플랫폼·아키텍처,
Electron·Node 버전과 설치본의 커밋·미커밋 변경 여부를 기록한다. Windows/macOS 공용
패키징 설정이 Git 정보를 package metadata에 넣으며 실행 시 Git을 호출하지 않는다.
기존 `buildChannel`의 package reader를 재사용하고, 구버전·개발 실행·메타데이터 오류는
식별 정보 `null`로 구분한다. 이 직접 재사용의 실측 import 상한만 bootstrap 13,
index 35로 기록하며 전역 상한은 유지한다. `runtimeCapabilities` 테스트가 패키징
metadata 왕복과 누락·손상 데이터를 검증한다.

## 2026-10-25 채팅 복구 이력 자동 순환

`mcpRetentionStorage`는 일반 페이지 변경 이력의 1 GiB/4,096개 목표를 저장 거부
조건으로 사용하지 않는다. `mcpRetentionPolicy`는 기존 artifact lease와 프로필별
활성 세션 관찰, 저장된 workflow/composite 참조를 이용해 사용 중 기록을 보호한다.
일반 `change` payload만 오래된 순서로 순환하며 출력·삭제 원본 복구·다른 종류의
기록은 기존 만료/폐기 계약을 유지한다. 보호된 데이터는 목표 초과를 허용한다.
새 페이지, 새 복구본, 이전 이력 퇴역과 소형 영수증, 목록은 기존 library transaction의
단일 커밋점에서 함께 게시된다. 기존 원본·현재 작업·출력 파일은 정리하지 않는다.

`mcpRetentionIndex`는 v1을 읽고 첫 쓰기에 암호화된 v2 목록으로 전환한다. 각 페이지는
최대 256항목이며 기존 8 MiB 파일 한도를 유지한다. 별도의 JSON 저장·잠금·복구 권위를
만들지 않는다. 정책, 호환성과 검증 근거는 [복구 이력 정책](mcp-retention-rotation.md)에 기록한다.
분할 목록이 기존 durable JSON writer를 직접 재사용하므로 `libraryTransactionStorage`의
실측 소비 상한만 27에서 28로 변경한다. 전역 상한과 기존 커버리지 기준은 유지한다.

## 2026-10-23 채팅 복원·중단·긴 이력

기존 v1 대화 JSON과 첨부 파일이 원본 권위다. `chatSnapshot`은 화면에 최근 80개 항목과
위치를 전달하는 별도 투영이며 저장소에 다시 쓰지 않는다. 이전 항목은 같은 IPC의 `before`
위치로 요청하고 최신 revision을 우선해 병합한다. 목록의 `chat/summaries`는 파일 크기와
수정 시각으로 검증하는 재생성 가능한 캐시다. 손상 기록은 오류가 있는 요약으로 남기며
다른 대화 조회·생성을 막거나 원본을 지우지 않는다. 첫 목록은 원본을 순차 읽고, 활성
대화의 main 상태는 여전히 전체 원본을 사용한다.

Codex 재개는 `excludeTurns`로 모델 세션을 보존하면서 불필요한 과거 본문 수신을 피한다.
JSONL reader는 문자열 변환 전에 한 줄을 64 MiB로 제한한다. 늦게 등록된 완료 대기를 위해
최근 이벤트도 총 64 MiB 이내로 보존하며, 진단 보고서는 2 MiB 이내다. 초과는 연결 오류로
격리한다. `chatDelivery`는 최종 저장 뒤 중단 세대를 재검사하고 확실한 미전송 첨부만
이어 보낸다. `chatRuntimeLifecycle`은 저장·provider 중단·앱 작업 취소의 실패를 분리하고
연결을 정리한다. 오래된 runtime 이벤트는 새 요청 상태를 바꿀 수 없다.

화면의 이어가기 버튼은 기존 대화에 작업 기록 확인을 요청하며 초안을 지우지 않는다.
압축과 이어가기는 완료된 편집·생성을 자동 재실행하지 않는다. 이미지는 화면 가까이에서
최대 두 개씩 320px 미리보기를 읽고 확대 시 원본을 읽는다. 긴 도구 묶음도 나누어 표시한다.
기존 공통 컨트롤과 5개 언어를 함께 사용한다. `chatReliability`, `chatSnapshotRace`,
`chatHistoryPreservation`, `chatImageLoading`, `boundedJsonLines` 및 기존 provider 테스트가
복원·중단·원본 보존 계약을 검증한다.

## 2026-10-22 글자 영역 배경 투명도

`shared/textBackground`가 배경 채움의 기본 불투명도 1과 이전 프리셋 호환을 소유한다.
편집기와 출력의 공용 `PageArtwork`에서 배경 레이어에만 적용하며 문자 불투명도와 분리한다.
저장·분리 패널·다중 선택·보관 블록·프리셋 계약을 기존 경로로 확장했다.
새 모듈의 최초 Windows focused coverage는 네 지표 모두 100%다. 측정 출처는
`C:/tmp/cov-text-bg-opacity/coverage-summary.json`, SHA-256은
`01f4fc01cf5584444fbdc994ad2178cdb1ab3006abc9c12e6b769d4c09bc386a`다.
기존 커버리지 기준은 유지하며 `textBackgroundOpacity.test.tsx`가 렌더·저장·프리셋 호환을 검증한다.
기본값·범위 해석을 복제하지 않고 공용 소유자를 직접 쓰는 소비자 1개로 `PageArtwork`의 직접
runtime import 상한은 17→18이다. 전역 상한은 변경하지 않는다.
글자별 배경은 기존 rich-text 서식에 `background-opacity`(0~1)를 더해 선택 범위를 보존한다.
`textRunVisualStyles`의 공용 배경색 계산을 일반 글자와 곡선 글자가 함께 사용하고,
`characterBackgroundOpacity.test.tsx`가 마크업·DOM 왕복, 선택 범위 및 편집기/출력 일치를 검증한다.
글자 영역 배경과 글자 배경은 같은 2열 컨트롤로 색상과 투명도를 나란히 표시한다.

## 2026-10-21 Hunyuan 영역 OCR

Hunyuan은 기존 OCR 선택/영역 전처리/작업 경계를 사용하며 별도의 네이티브 서버를 소유한다.
기존 영역 알고리즘은 이동하지 않고 Hayai와의 parity를 검증한다. 설정 타입은 settingsTypes에,
추천과 실행 해석은 shared/hunyuanOcr에 두어 순환 의존을 만들지 않는다.
일본어 판정의 기존 권위를 재사용하는 직접 소비자 1개로 translationLanguages의 측정 상한은
34→35, 기존 설정 composition의 도메인 normalizer 1개로 appSettingsNormalize의 직접
runtime import 상한은 16→17이다. 전역 상한과 커버리지 기준은 변경하지 않는다.
자산·수명·실측·복구 근거는 [Hunyuan 통합 기록](hunyuan-ocr-integration-20261021.md)에 남긴다.

## 2026-10-20 화 여러 개 삭제와 용어 파일 (이슈 #156)

여러 화 삭제는 `application/chapterBatchDeletionService`가 소유한다. 요청한 화가 모두 그
작품에 있는지 먼저 확인하고, 하나라도 없으면 아무것도 지우지 않는다. 이후 각 화를 기존
단건 경로(연결 출력물 journal + `deleteChapter` 화 단위 transaction)로 보관함 순서대로
지우며, 실패한 화는 그대로 두고 나머지를 계속한다. 작품 파일과 `style-guide.json`은 요청
범위에 들어가지 않는다. 용어 파일 내보내기/가져오기는 `shared/workGlossaryFile`(형식·검증)과
`shared/workGlossaryImportPlan`(병합 계획)이 소유하고, main은 기존 텍스트 파일 대화상자
IPC에서 열기/저장만 한다. 가져오기는 용어/기억 초안만 바꾸며 기존 항목을 지우지 않고,
저장은 기존 `saveWorkStyleGuide` 경로를 그대로 쓴다. 기존 권위를 직접 재사용한 데 따른
측정 상한은 ipcSchemaPrimitives 35, ipcContractCore 27, ipcContracts runtime 18,
ModalActionBar 29, libraryGateway 33, errorPresentation 31이며 범용 상한은 유지한다.
실제 격리 보관함 삭제, 부분 실패, 오래된 선택, 병합 정책과 렌더러 흐름 테스트가 검증한다.

## 2026-10-19 Grok Build 채팅

Grok 계정·채팅은 기존 IPC 검증, 계정 작업 registry, managed CLI 설치 및 당근 MCP
경계를 재사용한다. IPC composition의 개별 소비 상한과 공식 ACP 이미지·도구·복원
검증은 [Grok 연결 기록](grok-build-integration.md)에 남긴다. 전역 의존 예산과 기존
커버리지 기준은 낮추지 않는다. 새 13개 파일은 실제 Windows focused coverage에서
측정했다. 출처는 `.tmp/grok-integration-audit/coverage/coverage-summary.json`, 최초 측정
SHA-256은 `805fe9c2cb6d276fc7572622ba186f8afe6c845fa63e127208e27d491de70f9a`다.
공용 CLI 진행 표시와 정상 종료/강제 종료 후속 측정은
`.tmp/grok-integration-audit/coverage-final/coverage-summary.json`, SHA-256
`6d4ca6715a6648297922f76233bdb3db7d740e40692c8ae7b78f6eff4040555a`다.

## 2026-10-13 원문 언어 자동 기본값

효과음 응답 검증도 shared `translationLanguages`의 명시적 일본어 판정을 사용한다.
자동/다른 원문 언어에서 일본어 문자만 요구하지 않으며, 사용자가 일본어를 지정하면
기존 검증을 유지한다. 화 단위 글꼴 분석과 MCP 사전 검사는 shared
`fontChapterSourcePolicy`를 함께 사용해 자동 설정에서도 원문 지원 문자를 분석한다.
기존 `translationLanguages`의 runtimeImportedBy 상한 34는 유지한다.
원문/대상 언어 경계, 기존 설정 보존과 체크포인트 분리는 행동 테스트로 검증한다.
런타임 언어 프로필과 localization은 기존 node22 baseline artifact의 원래 수치로
커버리지 inventory에 추가했다. 기존 기준은 낮추지 않았다.
새 글꼴 원문 정책의 첫 커버리지는 네 지표 모두 100%이며 측정 출처와 SHA-256은
`docs/source-language-auto-audit.md`에 기록했다. 모델 자산과 픽셀 알고리즘은 변경하지 않는다.

## 2026-10-12 Gemma 생성 설정

Gemma Temperature·Top P·Top K의 기본값은 shared `gemmaSamplingSettings`가 소유한다.
설정 기본값·저장값 정규화·런타임 fallback·렌더러 초기화와 복원이 같은 계약을 직접
사용하므로 `appSettingsDefaults`의 직접 import 상한만 13에서 14로 조정한다.
기본값 복제나 재수출 우회는 만들지 않는다. 저장/IPC/환경변수 우선순위와 실제 요청의
샘플링 전달, grouping의 Temperature 0 및 추론 비활성화는 행동 테스트로 검증한다.
새 UI·공용 기본값 파일의 Windows 커버리지 기준은 기존 기준을 유지한 채 추가했다.
측정 출처는 `.tmp/gemma-sampling-coverage-20261012.json`이며 SHA-256은
`96a8397ca5881f7d50e1ff27c9533fc68f0be02cf7a28e8cf1d140fb66629a3c`다.

## 2026-10-03 반복 초기화 제거

모델·숨은 렌더러 재사용은 native 작업/단계의 명시적 workload 안으로 한정한다.
OCR 배치는 기존 페이지 예약·입력 인계와 원본/revision 검사를 사용하며, 저장과
receipt는 페이지별 권위를 유지한다. 직접 소비 증가에 따른 library 81,
McpEditError 246만 실측 예외로 기록하고 전역 예산을 유지한다.
새 두 모듈의 최초 Windows 커버리지 출처·SHA와 실제 GPU/renderer parity는
[반복 초기화 수정 기록](runtime-efficiency-fixes.md)에 남겼다.
기존 coverage floor·학습 자산·사용자 데이터는 변경하지 않는다.

## 2026-09-29 감사 후 공용 계약 재사용

일반 UI 컨트롤 188곳은 기존 `Button`의 bare 변형과 `Field`의 native `Input`/`Textarea`,
`CheckboxField`로 이동했다. bare 버튼은 자식·ref·기본 submit 의미를 유지하고, Input은
값 변환이나 wrapper 없이 네이티브 입력·IME·validity 계약을 보존한다. primitive CSS를
feature에서 직접 가져오던 세 의존은 제거했다. `FormatDefaultsPanel`의 직접 import
상한 13은 이 공개 primitive 소비를 위한 값이며 다른 모듈의 일반 상한은 유지한다.
후속 책임 분리로 `ConditionalBatchActionCard`/`ConditionalBatchConditionsCard`의 예외는
제거했다. 실제 하위 조립인 `ConditionalBatchActionSentence`, `ConditionalBatchSetFieldsEditor`,
`ConditionalBatchConditionEditor`는 각각 직접 import 13개, 공용 feature stylesheet
`ConditionalBatchEditor.module.css`는 직접 소비자 30개를 기록한다. 공용 계약과 primitive를
직접 사용하는 경계이며 새로운 barrel이나 forwarding wrapper를 만들지 않는다.
조건 편집과 가져오기 31개 상태의 DOM 동등성, 회귀 테스트 및 실제 넓은/좁은/확대
화면 검증은 `docs/audit-remediation-20260929.md`에 기록한다.

블록 추가 세 경로는 `ipcSchemaPrimitives`의 기존 500개 제한을 사용하므로 직접 소비 상한은
32다. 복제·라이브러리·직접 그리기의 최신 chapter updater에서 검사하며, 거부 시 선택·history·
dirty 상태를 바꾸지 않는 행동 테스트가 이를 보호한다. 장 전환은 `useEventCallback`으로
읽기 중 새로 생긴 마스크를 확인한다. 이 공용 hook의 직접 소비 상한 31은 새 콜백 구현이나
alias를 만들지 않기 위한 것이다. `openChapterLatestRequest`, `blockInsertionLimits`,
`workspaceBlockCreationLimits`, `nativeControlPrimitives` 및 각 feature의 기존 테스트가 검증한다.

페이지 작업의 소유권 전용 acquisition은 기존 handoff·activity gate·mutation 경계를 재사용한다.
읽기·검증이 필요한 기존 acquisition은 유지하며, 워크플로는 모든 handoff 후 첫 최신 snapshot에서
대상 전체를 확인한다. 각 페이지 처리 직전의 최신 읽기는 유지한다. 100페이지·1단계의 전체
chapter 읽기는 preflight 포함 203회에서 103회로 줄어든다. `activityConcurrency`와
`pageWorkflowService`가 대상 누락, 다른 페이지의 편집 가능성 및 읽기 횟수를 검사한다.

단축키의 공통 명령 실행은 기존 command registry를 사용한다. 단축키의 다시 누르면 닫기 동작은
진입점에 유지하고, 열기·실행 함수는 같은 `AppCommandId`의 권위를 따른다.

PNG worker의 client·entry·순수 raster kernel은 기존 `McpEditError` 계약을 직접 사용한다.
`mcpEditPolicy`의 실측 소비 상한은 이 세 파일 때문에 242에서 245가 된다. 워커 경계의
오류 직렬화·복원에도 기존 invalid-edit/revision-conflict 의미를 유지하며 별도 오류 권위나
import 우회 wrapper를 만들지 않는다. `mcpImageWorkerLifecycle`과
`mcpExternalImageRaster`가 종료·취소·정리 실패 및 픽셀·PNG·오류 parity를 검증한다.

이 문서는 새 기능과 리팩터링에서 지켜야 할 의존 방향, 공용 계약, 오류 처리, 테스트 기준을 정의한다. 실제 강제 규칙은 `.dependency-cruiser.cjs`, `eslint.config.mjs`, `scripts/check-*.cjs`가 담당한다.

## 의존 방향

자동 결과 동기화는 기존 library snapshot lease와 구조 읽기 예약으로 렌더 입력을
보존한다. 페이지 내용 쓰기 예약은 렌더 전체에 걸지 않으며, 캡처 뒤의 편집은 다음
동기화 항목으로 남긴다. 삭제는 같은 서비스에서 동기화를 취소·종료한 뒤
`linkedWorkspaceDeletion` 파일 어댑터로 위임한다. 이 연결 때문에 동기화 서비스의
직접 import 상한을 15, 기존 원자적 JSON 저장 함수의 소비 상한을 29로 기록한다.
별도 잠금이나 JSON 저장 구현은 만들지 않는다. 변경 범위와 측정 근거는
[`linked-workspace-responsiveness.md`](linked-workspace-responsiveness.md)에 남긴다.

일괄 편집의 작업 편집기는 숫자 입력을 공용 `NumberField`로 바꾸고 기본 글꼴의
식별자를 `blockFontCatalog`에서 직접 사용한다. 두 공개 계약을 재사용하기 위한
`ConditionalBatchActionCard`의 직접 import 상한만 15로 기록한다. 단위를 변환하는
표시 계약은 기존 `conditionalBatchUi`가 소유하며, 컨트롤 복제나 alias wrapper는 만들지 않는다.

```text
renderer app (composition root)
  └─> feature UI ──> feature model/use case ──> renderer gateway
           │                    │                       │
           └────────> shared domain contract <─────────┘

main IPC/job ──> application service ──> pure policy ──> port
     │                                                    ▲
     └─ composition only ─> filesystem/http/process/native adapter
```

- `shared`는 main, preload, renderer를 import하지 않는다.
- renderer는 main이나 preload 구현을 직접 import하지 않고 shared 계약과 preload bridge만 사용한다.
- renderer `hooks`는 React component가 소유한 타입을 import하지 않는다. 양쪽에서 쓰는 계약은 기능별 `*Types.ts`가 소유한다.
- main IPC와 job은 입력 검증, application service 호출, 외부 결과 변환만 담당한다. 작업 소유권, 취소, cleanup, rollback 순서는 `src/main/application`이 소유하고 port로 외부 효과를 받는다.
- application service는 Electron, IPC/job entrypoint, `libraryStore`, runtime 구현을 import하지 않는다. 이 방향은 `main-application-does-not-own-adapters-or-entrypoints` 규칙이 강제한다.
- main IPC와 job은 `libraryStore` 구현 대신 `src/main/library.ts` facade를 사용한다.
- main pipeline도 `libraryStore`를 직접 우회하지 않는다.
- `libraryStore`는 IPC, job, UI를 알지 못한다.
- CJS runtime 구현은 `assets`, `hardware`, `model`, `ocr`, `parsing`, `prompts`, `transport` 하위 도메인이 소유한다. 루트의 `simple-page-*` 파일은 기존 공개 API를 유지하는 작은 composition facade만 허용한다.
- 순환 의존과 위 규칙 위반은 `npm run arch:deps`에서 실패한다.

현재 이 경계를 대표하는 구현은 `WebImportApplicationService`와 `PageImageExportApplicationService`다. 기존 기능은 수정할 때 같은 방향으로 이동하되, 한 번에 폴더만 옮기지 않는다. 먼저 정상·빈 입력·오류·취소·동시 실행·cleanup 실패를 행동 테스트로 고정하고, 오케스트레이션만 추출한다.

Codex 전체 위임 경로는 제품에서 제거했다. 일반 OCR·번역·용어/스토리 기억이 텍스트를 확정한 뒤 `codexImageEditing` composition root가 선택한 영역의 제거·ImageGen·실제 렌더러 미리보기만 연결한다. 텍스트 엔진과 이미지 작업용 Codex 모델·추론 강도는 독립적이다. `wholePagePipeline`의 영역 후처리, `soundEffectTranslationJobRunner`의 번역 후 이미지 작업, `AppSessionView`의 가리기 검토, `SettingsModalView`의 이미지 설정 연결에만 각각 26/16/26/17의 import 상한 사유를 기록한다. 일반 모듈 상한은 유지한다. `runCodexTypesetting`은 기존 오프라인 검증용 계약으로만 남는다.

2026-10-09 글로벌 채팅은 위 일반 번역 파이프라인과 별도의 사용자 진입점이다.
`application/ChatService`의 지속 대화가 `chat/CodexChatRuntime`과 기존 native MCP를
사용하며 번역/편집/검수 엔진을 복제하지 않는다. 전역 저장, 내부/외부 MCP 공용
authority와 composition 예산의 변경 근거는
[글로벌 채팅 인계](global-chat-translation-20261009.md)에 기록한다.

부분 강조에는 기존 `richTextMarkup`의 안전한 문법을 그대로 사용한다. 식자 직렬화,
이미지 문자 생성의 실제 문구, 독립 재판독의 기대 문구, literal 폰트 견본이 같은 parser/serializer를
직접 사용하고, master의 조건부 일괄 식자도 같은 문법을 소비하므로 병합 후 이 공개 문법 모듈의 fan-in만 28로 명시한다. 문법을 복제하거나
상한을 감추기 위한 alias wrapper를 만들지 않는다. 알고리즘은 이동·변경하지 않으며
부분 크기/굵기/색상과 literal markup의 roundtrip 테스트로 소비 계약을 확인한다.

긴 원고의 Codex 요청 배칭은 기존 `geometry.ts`의 bbox 교차 계산을 사용한다.
원문과 실제 번역 위치의 native view 포함 여부를 같은 계산으로 확인하며, 이 모듈의
직접 소비 상한은 제거 참고 영역의 crop 교차 계산 소비자를 포함해 33으로 기록한다. 교차 계산을 복제하거나 기존 알고리즘을 이동하지 않는다.

## 렌더러 기능 경계

렌더러의 소유 기능은 번역, 가져오기, 보관함, 검수, 인페인팅, 설정, 공유, 조건부 일괄 편집, 효과음, 작업 센터다. 현재 큰 기능은 `components/<feature>`, `app/session`, 기능 전용 hook과 model에 걸쳐 있을 수 있지만 새 의존은 다음 규칙을 따른다.

- feature UI는 `components/ui`, `shared` 계약, renderer gateway, 같은 feature의 model/use case만 import한다.
- 다른 feature의 내부 component, hook, CSS Module을 직접 import하지 않는다. 두 기능이 정말 같은 계약을 쓰면 중립적인 하위 primitive나 shared domain contract로 먼저 승격한다.
- feature를 한꺼번에 재수출하는 barrel은 만들지 않는다. composition root는 필요한 public component를 소유 파일에서 직접 import한다.
- 동일 명령의 사이드바, 빈 화면, 명령 팔레트 진입점은 `AppCommandId`와 단일 command map을 공유한다. 진입 위치는 여러 곳이어도 실행 함수와 표시 이름의 권위는 하나다.
- 큰 화면은 UI, 상태 model, 순수 변환, 외부 effect를 분리한다. `ConditionalBatchRulePanel`과 `RichTranslationEditor`의 내부 모듈 구성이 기준 예시다.

UI 표면과 primitive 선택은 [`ui-design-rules.md`](ui-design-rules.md)를 따른다.

## 공용 계약과 SSOT

생성 레터링의 자모 기준은 `letteringTextStructure`가 확정 문구의 Unicode 음절을
분해해 제공한다. 기존 `richTextMarkup` parser로 표시 문구를 얻으며 해당 모듈의
직접 소비 상한만 38로 기록한다. 생성 지시와 MCP 수정용 메타데이터에 공유하고,
정답을 숨기는 이미지 재판독·자형 검사에는 전달하지 않는다. NFC/NFD·혼합 문자·
겹받침·서식 문구와 실제 MCP HTTP/미리보기 응답 테스트로 이 경계를 확인한다.

클립보드는 렌더러와 같은 `richTextMarkup` parser로 표시 문자열을 얻어 자동 확장된
텍스트 상자를 보존한다. 이 직접 소비자를 포함해 parser fan-in은 29다.
원문 글자 크기 측정·페이지 내 대체 측정과 말풍선 배치의 원래 계약을 유지하며,
복사 전후 실제 `resolveBlockTextLayout`의 글자 크기·줄 배치 parity test로 검증한다.
원문 크기 추정 및 말풍선 줄 배치 알고리즘은 이동하거나 변경하지 않는다.

블록 클립보드와 이미지 블록 라이브러리는 기존 `geometry`의 렌더 좌표 정규화와
픽셀 변환을 직접 사용한다. 두 소비자를 포함해 직접 소비 상한은 35다.
클립보드 입력 검증과 페이지 블록 수 제한도 `ipcSchemaPrimitives`의 기존 권위를
사용하므로 해당 직접 소비 상한은 27로 기록한다. 좌표 알고리즘은 이동·변경하지
않으며 서로 다른 페이지 크기의 이미지/텍스트 복사, 마스크 위치, 저장 후 재사용,
잘못된 클립보드와 블록 수 초과 시 무변경을 행동 테스트로 확인한다.
새 클립보드 파일 두 개의 coverage floor는 Windows 실측에서 추가했고 기존
floor와 historical artifact는 유지했다. 측정 기록은
`.tmp/block-clipboard-coverage-20260913.json`이며 SHA-256은
`a50026c256a96f323de98d0f3d0b6ea37705c4e7f46bcc7370c2e7b84a70cced`다.

인터넷 조사의 프롬프트·증거 필터·Gemma 보완은 `translationLanguages.ts`의 언어 계약을 직접 사용한다.
한국어 전용 판정을 복제하지 않도록 이 공용 계약의 직접 소비 상한만 26에서 29로 조정했다.
영어·간체·번체·한국어 및 기본 언어의 조사 제안 생성, 증거 검증, 적용 회귀 테스트로 소비 계약을 확인한다.

효과음 검토 초기화는 저장된 제외 기록만 복원한다. 기존 페이지 revision 검증과
typed library gateway를 그대로 사용하므로 두 공개 경계의 직접 소비 상한은 각각
26으로 기록한다. 수정한 영역과 완료 번역은 보존하며 원본 검출·revision 알고리즘은
변경하지 않는다. 복원은 화 단위 저장 트랜잭션을 사용하고 모델 작업을 시작하지 않는다.

- 타입은 `libraryTypes`, `jobTypes`, `textTypes`, `settingsTypes`처럼 소유 도메인에서 직접 import한다.
- 여러 도메인을 다시 내보내는 `shared/types` umbrella는 만들지 않는다. 실제 의존과 fan-out을 숨기기 때문이다.
- 새 helper, shape, schema를 만들기 전에 `src/shared`, 해당 기능의 `*Types.ts`, 기존 facade를 검색한다.
- 공용 계산은 한 구현과 행동 테스트를 둔다. 예: bbox 겹침 계산은 `shared/geometry.ts`가 소유한다.
- public facade와 UI component public API 외의 re-export는 만들지 않는다. 사용하지 않는 export는 제거한다.
- TS/TSX export 표면은 `npm run deadcode:exports`가 검사한다. 동적 `require()` 공개 계약인 runtime CJS는 행동·경계 테스트가 별도로 검증한다.

## 중복과 의도적 복제

- 코드 모양이 아니라 소유 도메인, 입력·출력, 오류·취소 정책, 변경 이유가 모두 같을 때만 통합한다.
- 격리된 CJS runtime과 Electron TypeScript처럼 서로 import할 수 없는 실행 환경은 복제를 허용할 수 있다. 이 경우 같은 fixture를 양쪽에 실행하는 parity test와 사유가 먼저 있어야 한다.
- 폰트 매칭 v2, Hayai geometry, work-context research의 모델·artifact·데이터 권위는 리팩터링 대상이 아니다. characterization/parity 없이 이동·재명명·공통화하지 않는다.
- 정확한 clone의 현재 분류와 감소 절차는 [`duplicate-code-inventory.md`](duplicate-code-inventory.md)가 소유하며, 새 clone은 `npm run check:duplicates`에서 실패한다.

## 오류 처리

ImageGen 실패 수집과 실패 호출 기록은 기존 `logger`의 로그 기록·민감정보 제거
계약을 직접 사용하므로 해당 진단 sink의 직접 소비 상한은 32다. 실패한 이미지
item 뒤에 오는 같은 thread/turn의 도구 출력·오류를 최대 1.5초 수집하고, 임시
thread 삭제 전에 앱 로그에 기록한다. 호출 경계는 작업 폴더에도 실패 식별자,
모델·이미지 크기·경과 시간과 정제된 진단을 저장한다. 입력 프롬프트와 이미지
데이터는 새 실패 기록의 요청 메타데이터에서 제외한다. 지연 오류, 다른 작업과의
격리, 인증정보 제거, 진단 시간 초과·취소·파일 쓰기 실패를 행동 테스트로 확인한다.
일반 응답에 없는 서버 거절 사유는 해당 호출 이후의 stderr에서 읽어 메시지와
오류 코드로 보존한다. 실제 입력 재현에서 HTTP 400 `moderation_blocked`를 수집했고,
같은 오류 출력의 오프라인 재생으로 사용자 오류 메시지까지 전달됨을 확인했다.
새 파일의 Windows 커버리지 측정은
`.tmp/imagegen-repro-f3c20bc3-20260913/coverage/coverage-summary.json`에 보존했다.
SHA-256은 `c612f572a4ea99eaa38e954739ce3b429c4457904604e2c9423abfdcbc3cee7d`이며
기존 커버리지 기준과 historical artifact는 유지한다.

- 저장소, IPC, 프로세스, 파일 시스템 같은 경계에서 오류를 번역하거나 기록한다. 내부 함수는 원인을 보존해 전파한다.
- `ENOENT`처럼 계약상 예상한 오류만 코드로 좁혀 처리한다. 권한, 잠금, I/O 오류를 “없음”이나 성공으로 바꾸지 않는다.
- cleanup과 본 작업이 모두 실패하면 한쪽을 가리지 말고 `AggregateError`처럼 두 원인을 모두 보존한다.
- 실행문 없이 의도적으로 다음 전략으로 넘어가는 `catch`에는 `error-policy-allow: 이유`를 기록한다. 실패를 `null`/`false` 같은 sentinel로 바꾸는 probe는 `catch (_error)`로 의도적 무시를 드러낸다.
- 빈 catch, 관찰되지 않는 `.catch(() => undefined)`, 암묵적인 sentinel fallback은 새 파일을 포함해 `npm run lint:error-handling`에서 실패한다.

## 복잡도와 리소스 수명

- 새 TS/TSX 함수는 80줄, 파일은 400줄, 중첩은 3단계, cyclomatic complexity는 12를 넘지 않는다.
- runtime CJS도 같은 규칙을 적용하며 허용된 초과 예산은 0이다. 위반은 ESLint error로 즉시 실패한다.
- 장시간 유지되는 native/GPU resource는 module-global callback으로 해제하지 않는다. lease는 자신이 획득한 entry에 묶고, 마지막 lease 이후에만 교체하거나 idle dispose한다.
- 초기화 순서에 의존하는 전역 상태 대신 composition root에서 adapter나 port를 주입한다.

## 테스트

- `PageExportRenderSession`의 공개 함수는 생성한 세션에 고정되어야 하며, 구조 분해나
  콜백 전달 후에도 렌더·조회·취소·종료가 같은 세션을 사용한다. 호출자가 `bind`를
  보완하는 방식에 의존하지 않는다. 실제 세션과 PSD 작성기를 연결한 테스트로 레이어,
  투명도, 텍스트와 cleanup을 검증하고, `check`의 page-artwork parity 단계에서도
  실제 Electron 렌더링으로 PSD를 저장한 뒤 다시 읽어 검증한다.
- 소스 문자열이나 함수 이름 존재가 아니라 입력에 대한 출력, side effect, 호출 순서, 실패 결과를 실행해 검증한다.
- mock은 Electron, 파일 시스템, 모델/OCR transport 같은 외부 경계에 둔다. 내부 parser, option builder, result builder는 실제 구현을 조립한다.
- 정상 경로보다 먼저 빈 입력, 경계값, 잘못된 값, 중복 호출, 동시 lease, timeout, rollback, 실패한 cleanup을 고정한다.
- 테스트를 통과시키기 위한 production fallback을 추가하지 않는다. 실패가 계약상 값이라면 타입과 이름으로 드러낸다.

## 변경 전 확인

```powershell
rg "만들려는이름|유사한개념" src tests
npm run arch:deps
npm run arch:budget
npm run lint:error-handling
npm run lint:budget
npm run deadcode:exports
npm run check
```

`arch:budget`의 fan-in은 런타임 의존을 기준으로 측정한다. type-only import는 초기화 결합을 만들지 않으므로 제외하지만, broad type barrel은 ESLint로 별도 금지한다.

### 동시 작업과 편집 권한

`shared/appActivityTypes.ts`가 자원·대상·읽기/쓰기 충돌 계약을 소유한다. 메인의
`AppActivityGate`는 소유 ID별 lease로 이를 적용하고, 작업과 관리 작업의 종료는 자신의
lease만 해제한다. 렌더러는 IPC 활동 상태를 기존 세션과 명령 구성에 연결한다.
별도 전역 feature selector나 우회 gateway를 두지 않는다.

페이지 예약은 구조를 보호하며 내용 쓰기 권한과 분리된다. `jobs/jobPageOwnership.ts`는
입력 마무리 응답과 선행 이미지 편집을 기다린 뒤 보관함 저장 경계에서 최신 페이지를
읽는다. `wholePageInputHandoff.ts`는 그 입력의 체크포인트 호환성을 다시 검사한다.
최종 이미지·블록·문맥 저장까지 페이지 권한을 유지한다. 원본 비교·탐색·마스크 초안은
내용 쓰기 권한을 요구하지 않는다.

새 의존성 예외는 `architecture-budget-baseline.json`의 파일별 사유로 한정한다.
revision·언어 판정·진단·이벤트 콜백은 기존 공통 계약을 재사용하고, IPC와 작업 구성은
해당 소유권 경계를 직접 연결한다. `activityConcurrency`, `pageEditHandoff`,
`wholePageHandoffParity` 테스트가 자원 분리·입력 보존·기존 출력 일치를 검증한다.

영역 효과음 이미지의 반전 처리는 RGB만 변환하고 알파를 유지한다. ImageGen의 명시적 sexual 거부는 영역 상태로 저장하며, 그룹의 다음 항목과 다음 페이지를 중단하지 않는다. 원문 제거도 블록 단위로 격리한다. 픽셀 반전·알파 보존, 정상/거부/취소 원문 제거, 그룹 계속 진행, 저장 및 편집/내보내기 표시 분리 테스트로 확인한다. 새 모듈 5개의 커버리지 기준은 Windows 전체 실행 실측을 추가했으며 기존 기준은 유지했다. 측정 기록은 `.tmp/region-image-processing-coverage-20260914.json`, SHA-256은 `b0ca7bedfb441f2927ec728672264bcaf9dbc5b6afe1c4f5cfc02a9c2a9a1bab`다.

효과음 이미지 복구는 확정한 번역문·영역을 먼저 저장하고 기존 run 디렉터리에 원자적
JSON checkpoint를 남긴다. 새 보관함 포맷이나 폰트/OCR 알고리즘은 도입하지 않는다.
추가 소비 경계는 storage 28, pageRevision 33, library facade 27로 기록한다.
SFX job composition은 검토·저장·복구 연결로 runtime import 19를 사용하며,
세션 view composition은 작품 문맥 소유권 판정으로 15를 사용한다. 범용 상한은 유지한다.
실제 파일 저장·재실행·부분 실패·취소 테스트와 기존 입력의 이미지/글꼴 parity로 보호한다.

편집 인계는 진행 중인 포인터/IME와 분리 편집 창의 마지막 명령까지 기다린 후 대상
페이지 저장을 완료한다. 다른 페이지와 설정 입력은 이 장벽에 참여하지 않는다.
SFX 이미지 이어하기는 Codex 인증과 대상 페이지만 사용하며 무관한 로컬 런타임을
종료하지 않는다. 일반 SFX 실행의 로컬 전처리 자원 검사는 유지한다.

이번 추가 모듈의 커버리지 기준은 `.tmp/activity-coverage-inventory-windows.json`
Windows 전체 실행 기록에서 최초 실측한 값이며, 기존 파일과 기존 추가 모듈의
기준을 낮추지 않았다. SHA-256은 `6e420cc800828edde2a0ef49d9df9af111a1839afa5017828824ce6e959e127c`다.
manifest의 node22 provenance는 기존 수용 기록의 출처로 유지하며, 이후 추가한
동시 편집·SFX 복구 모듈의 측정 출처는 이 기록이다.

이미지 저장 후 정리는 그 요청이 교체한 파일에만 적용한다. 디렉터리 전체를 훑어
다른 페이지가 생성 중인 파일을 제거하지 않는다. 실행 취소 기록은 보관함 artifact
lease로 이전/다음 이미지와 마스크를 보존하며 마지막 소유자가 해제한 뒤 수거한다.
오래된 UI 이미지 경로는 세션 소유자가 최신 chapter를 다시 읽고 기존 dirty-page
병합으로 복구한다. 같은 chapter의 복구 읽기만 합치며 페이지/화 이동 뒤 응답은
오류를 다시 띄우지 않는다. 범용 예산은 유지하고 이 연결에 필요한 gateway 27,
event callback 29, session composition 21, checkpoint 진단 logger 35만 기록한다.
네이티브 제외 픽셀 복사는 기존 이미지 가리기 모듈로 옮겼으며 RGBA copy parity와
실제 인페인팅 합성 테스트로 같은 픽셀 보존을 검증한다.

보관함 read/write 큐는 등록 시 `AsyncLocalStorage.bind`로 호출자의 async context를
포착한다. 앞선 읽기/쓰기 완료가 다음 요청을 배출하더라도 작업 소유권, 실행 설정,
transaction 문맥이 섞이지 않는다. 실제 재현에서는 큐에 기다린 SFX 저장이 앞선
수동 편집의 소유권을 받아 자기 페이지 저장을 거절당했다. 큐 순서·실패 후 다음
요청·소유권 없는 편집의 거절을 회귀 테스트로 검증한다.

생성 효과음의 보정 붓과 외곽선은 `generatedLettering`의 선택 필드로 저장한다.
기존 텍스트 서식과 원본 PNG는 바꾸지 않는다. 붓질과 그 영역의 마스크 복구를
하나의 블록 편집으로 기록하고, 이미지와 붓질을 합친 뒤 마스크와 외곽선을 적용한다.
페이지 가림과 원근/왜곡 변환은 기존 렌더 경계를 유지한다. 보정이 없는 기존 이미지는
원래 IMG 경로로 렌더한다. 화면과 PNG/PSD 출력은 같은 `PageArtwork`를 사용하며,
회전·왜곡·가림·보정 붓·외곽선을 포함한 실제 픽셀 parity fixture로 일치를 확인한다.

결과물 자동 동기화 취소는 숨은 창을 닫는 것뿐 아니라 세션의 AbortSignal로 이미지
읽기·페이지 로드·렌더 준비·캡처 대기를 종료한다. 타일 합성 프로세스는 종료 이벤트까지
기다린 뒤 임시 파일을 정리하며, 그 이후 기존 페이지 lease가 해제된다. 다른 세션의
잠금은 유지한다. FFmpeg 인수와 타일 알고리즘은 그대로 두고 프로세스 수명만 기존
`pageExportLifecycle`로 옮겼으며, 원본 픽셀 parity와 취소·오류·타임아웃 테스트로 검증한다.
이번에 처음 수정 범위에 들어온 `pageExportLifecycle.ts`의 보호 기준은 기존
`.tmp/production-cleanup-coverage-baseline-node22.json`의 원래 측정값을 등록했다.
역사 artifact, SHA-256, 다른 파일의 커버리지 기준은 변경하지 않았다.

문맥 분석은 기존 활동 계약으로 모델·입력 chapter·공유 문맥을 함께 예약한 뒤 실행한다.
IPC가 storage port를 주입하며 분석 알고리즘과 모델 독점은 유지한다. 이 직접 연결의
파일별 import 상한은 workContextIpc 14, 활동 계약 fan-in 26이다. 페이지 목록의
ResizeObserver는 기존 useEventCallback을 재사용하며 fan-in 30을 기록한다. 범용 상한과
보호 커버리지 기준은 유지하고 CSS literal 기준은 실제 제거한 항목만 낮췄다.

새 목록 window·header, 진행 이벤트 scheduler, 문맥 분석 소유권 모듈의 최초 커버리지는
Windows 전체 실행 기록 .tmp/ui-responsiveness-coverage-20260920.json (SHA-256 3d887e67b10f1578f2294e7882b05caaeef228842b40e7b1025d740812fa97f9)에서 등록했다.
usePageListState의 보호 기준은 기존 source artifact의 원래 값을 등록했으며
이전 모듈의 기준과 역사 provenance는 변경하지 않았다.

설정 저장 오류 요약은 기존 draft 검증 결과를 읽고 같은 SettingsModal 안에서
해당 탭으로 이동한다. 별도의 저장 검증 권위나 selector는 추가하지 않았다.
새 SettingsModalFooter/settingsSubmissionIssue의 최초 측정 출처는
`.tmp/ui-followup-coverage/coverage-summary.json`이며 SHA-256은
`669ad2554889b1c2b6f3eb52ee38311d46a217f61ae3da483419c037beadc49a`다.
이는 focused 테스트의 파일별 최초 기록이며 전체 coverage 통과 기록은 아니다.
기존 파일 floor는 원래 baseline에서 등록했고 기존 기준을 낮추지 않았다.

설정·가져오기 도움말은 기존 ControlTooltip을 재사용하며, 스크롤 영역에서는
선택적 FloatingControlTooltip이 기존 portal-tooltip layer에 표시한다. hover/focus,
Esc, blur, scroll/resize 해제와 viewport 안쪽 배치를 검증한다. 재사용에 따른
ControlTooltip의 파일별 fan-in은 37으로 기록하며 범용 상한은 유지한다.
새 portal 구현의 최초 커버리지는 `.tmp/ui-tooltip-coverage/coverage-summary.json`
(SHA-256 `4e7ab21464ffa447df020ab126db11ff27553731bee146209ade96abe2f95199`)의
파일별 측정값이다. 기존 ControlTooltip의 100% 보호 기준은 유지한다.

## 작업 환경 백업

환경 이관은 application service가 내보내기·사전 검사·복원 순서를 소유하고,
파일 및 Electron adapter가 효과를 실행한다. 기존 mutation suspension과 activity gate를
재사용하며 새 보관함 잠금은 만들지 않는다. IPC의 진행 중 저장도 배출한 뒤 스냅샷을 만든다.
체크포인트의 유효한 input revision만 기존 createPageRevision으로 재결합하며
원래 stale인 체크포인트를 유효하게 승격하지 않는다. 알고리즘은 이동하지 않는다.
원자적 JSON 저장 소비 상한 33, pageRevision 35, library facade 33,
IPC 등록 import 25, trusted IPC 소비 27은 이 기능의 직접 재사용에 한해 기록한다.
환경 왕복 및 교체 단계별 복구 테스트가 저장 동작을 고정한다.

백업 검사 결과는 공용 Modal로 즉시 표시하고 복원·닫기 버튼은 ModalActionBar에
고정한다. 긴 연결 경로 목록이 실행 버튼을 밀어내지 않도록 공용 primitive를
재사용하며 이 직접 소비에 한해 ModalActionBar의 fan-in 상한은 26으로 기록한다.
보관함 요약은 안내용이므로 내보내기 버튼의 활성화 조건에 포함하지 않는다.

개발 모드의 백업 복원 재시작은 Electron의 IPC로 기존 dev 실행 관리자에 요청한다.
관리자는 정상 종료한 Electron만 교체하고 Vite와 개발 인스턴스 잠금은 유지한다.
설치판과 감독되지 않는 실행은 기존 Electron relaunch 경로를 사용한다. 실제 격리된
Electron·Vite에서 재실행 전후 같은 URL의 화면 로드를 확인했다.
새 appRelaunch의 최초 커버리지는 `.tmp/dev-relaunch-coverage/coverage-summary.json`
(SHA-256 `49dad6fa98a7b15c936b93d1094a6b1b7f6796583315a1f7c91e13d6ef17b1da`)의 파일별 측정값이며
기존 모듈의 기준과 역사 provenance는 변경하지 않았다.

## MCP structure editing boundaries

Single-page structural plans reuse the existing page edit handoff, atomic blocks/order
transaction and renderer. Four measured direct-consumer ceilings are recorded: pageRevision
46, ipcSchemaPrimitives 28, geometry 40 and mcpEditPolicy 41. The extra consumers are
mcpStructurePolicy (capacity, geometry and typed errors), mcpStructureService (revision
and typed errors), and mcpStructureTools (typed boundary errors). Global ceilings,
revision/coordinate algorithms, existing coverage floors and authorization are unchanged.
The structure policy/service/lifecycle/HTTP suites cover preservation, stale revisions,
request-ID races, expiration, authorization and atomic persistence; native structure
checks exercise split/merge/delete with actual rendered-pixel restoration.

## MCP format batches

Format and text batches share the same page-batch lifecycle, fixed-target runner,
context read scope and authorized tool boundary. The existing field editor remains
responsible for font intent, weights and normalized display geometry. Only selected
app-calculated format snapshots can be committed; source/translation text, source
geometry, images and references are checked as immutable. Undo restores optional
field absence as well as values. Excluded generated image payloads are not retained.

Measured direct-consumer ceilings: blockFingerprint 27, mcpEditPolicy 49 and the
mcpAppTools composition root 17 imports. Global ceilings and protected algorithms
are unchanged. Existing text batch tests characterize the shared lifecycle; format
policy/HTTP/native tests verify exact restoration, partial failure and rendering.

## 2026-09-24 master 통합 측정

MCP 변경과 master의 페이지 워크플로·환경 백업·출력 삭제를 합친 트리에서 dependency-cruiser로 2,584개 모듈과 12,249개 의존성을 측정했고 의존 방향 위반은 없었다. 공용 해시·revision·잠금·저장 권위와 기존 IPC 구성 지점을 함께 사용하는 직접 의존성만 아래 실측 상한으로 합쳤다. 전역 상한은 runtime imports 12, runtime consumers 25를 유지하며, 기존 예외는 별도 알고리즘이나 우회 wrapper를 추가하지 않고 양쪽 사유를 보존한다.

| 모듈                                                     | 측정 종류         | 통합 상한 |
| -------------------------------------------------------- | ----------------- | --------: |
| `src/main/abortSignal.ts`                                | runtime consumers |        28 |
| `src/main/ipc/registerIpc.ts`                            | runtime imports   |        26 |
| `src/main/ipc/trustedIpc.ts`                             | runtime consumers |        28 |
| `src/main/library.ts`                                    | runtime consumers |        80 |
| `src/main/library/lock.ts`                               | runtime consumers |        53 |
| `src/main/libraryStore/libraryFiles.ts`                  | runtime consumers |        48 |
| `src/main/libraryStore/libraryTransaction.ts`            | runtime consumers |        34 |
| `src/main/libraryStore/libraryTransactionFiles.ts`       | runtime consumers |        27 |
| `src/main/libraryStore/storage.ts`                       | runtime consumers |        38 |
| `src/main/linkedWorkspace/linkedWorkspaceSyncService.ts` | runtime imports   |        18 |
| `src/main/settingsStore.ts`                              | runtime consumers |        30 |
| `src/renderer/src/api/libraryGateway.ts`                 | runtime consumers |        29 |
| `src/shared/appActivityTypes.ts`                         | runtime consumers |        38 |
| `src/shared/blockFingerprint.ts`                         | runtime consumers |       149 |
| `src/shared/ipcContracts.ts`                             | runtime imports   |        13 |
| `src/shared/pageRevision.ts`                             | runtime consumers |        83 |

커버리지 inventory는 기존 776개·추가 1,244개·삭제 11개로 실제 통합 diff와 일치한다. 양쪽에서 같은 파일의 수치가 달라진 경우 정확한 covered/total 비율이 높은 기준을 유지했고, renderer `gatherText.ts`의 삭제는 기존에 기록된 shared 이동으로 처리했다. 이동한 shared 파일의 네 metric 기준 모두 master의 이전 renderer 기준보다 높다. provenance의 node26 artifact와 SHA-256은 master의 단독 갱신을 보존하며, 통합 자체를 새 커버리지 측정으로 간주하지 않는다.

## 페이지 이름·순서 편집

페이지 편집은 기존 `libraryGateway`·library mutation lock·활동 자원·organization transaction을
직접 사용한다. 신규 facade/메타데이터 revision/UI modal을 위한 정확한 fan-in 상한은
`appActivityTypes` 39, `blockFingerprint` 150, `library/lock` 54, `libraryFiles` 50,
`ModalActionBar` 27, `libraryGateway` 32다. 출력 이름 검증의 직접 의존은
`linkedWorkspaceSyncService` 19, `pageImageExportJobRunner` 16이다. 일반 예산과 기존
coverage floor는 유지한다. 계약과 검증은 `docs/page-organization-editor.md`를 따른다.

페이지 이름 변경의 공백·대소문자·숫자 정리 도움말은 공용 `ControlTooltip`을 직접 사용한다.
스크롤 영역 밖 portal과 마우스/키보드 동작을 재사용하며, 해당 primitive의 소비 상한만
37에서 실제 소비 수 38로 조정했다.

# 2026-10-31 기본 결과 폴더 제목 동기화

작품·화 제목 변경의 native organization commit에서 결과물 동기화를 알린다. desktop과
MCP/Undo가 같은 경로를 사용하며, 보관함 쓰기 잠금이 풀린 다음 기존 activity gate와
동기화 서비스의 metadata publication 경계에서 기본 결과물만 옮긴다.
기존 삭제 모듈의 파일 소유권 목록과 정션 검사, storage의 경로 검사·원자적 JSON 저장을
직접 재사용한다. 변경된 파일·추가 파일·사용자 지정 폴더는 보존하고, 새 위치의 복사본을
검증한 뒤 registry를 전환한다. registry 전환 전후의 중단은 별도 이동 journal로 복구한다.
복구·일반 이동 모두 재귀 삭제 없이 검증된 파일과 빈 부모 디렉터리만 정리한다.

직접 소비 증가의 실측 상한은 storage runtimeImportedBy 43, linkedWorkspaceSyncService
runtimeImports 22, toastStore runtimeImportedBy 28이다. 결과 알림은 기존 공통 toast를
사용한다. 전역 예산 및 기존 coverage floor는 낮추지 않는다.
`linkedWorkspaceRelocation`, `resultOrganizationLinked`, `libraryOrganizationCompatibility`,
`linkedWorkspaceDeletion`, `linkedWorkspaceSettingsPanel` 테스트가 소유권 보존과 연결을 검증한다.

새 relocation 3개 모듈과 `LinkedResultsOrganization`의 최초 coverage는
`.tmp/issue166-focused-coverage/coverage-summary.json`에 기록했다.
SHA-256: `caafb83bd80fe0257162c73c68f4aa2a00559f7aa21f2b8b2e345725fbe06d90`.
기존 모듈의 기준과 역사 provenance는 변경하지 않았다.
불필요해진 `LinkedWorkspaceFolderRoles`와 전용 스타일·문구는 삭제했다. 이 파일은
cleanup 기준 이후 추가된 파일이므로 introduced inventory에서만 제거한다.

작품·화별 정리 요청과 보존 폴더 열기는 기존 linked workspace gateway/IPC를 확장한다.
보존 폴더는 registry에 기록된 경로를 기존 managed-root 검사로 검증하며 임의 경로를 받지 않는다.
이동 오류는 이미지 동기화 상태와 별도로 영속화하고, 해결 전에는 해당 화의 출력을 중지한다.
결과 열기의 최종 경로 조회도 metadata 직렬화 안에서 수행해 이동 중 옛 폴더를 재생성하지 않는다.
`linkedWorkspaceContext`는 실제 임시 파일을 사용해 범위 격리, 동시 결과 열기, 재시작,
원제목 복원, 동일 위치 재연결과 외부 수정 파일 보존을 검증한다.

설정 전용 `LinkedResultsOrganization`은 제거하고 보관함/출력/팔레트가 같은
`AppCommandId`와 결과 명령 정의를 사용한다. 새 `linkedResultsCommands`,
`libraryResultMenuItems`, `libraryTreeResults`의 최초 coverage는
`.tmp/issue166-context-ui-coverage/coverage-summary.json`이며 SHA-256은
`6a12febd65d10a00c22389b81208fd6edb9c2b6e9795151c519e8bc6b33e64dc`다.
introduced inventory는 1,595개이며 기존 floor는 유지했다.
