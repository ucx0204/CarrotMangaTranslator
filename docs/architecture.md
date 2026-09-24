# 코드 경계와 품질 규칙

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
