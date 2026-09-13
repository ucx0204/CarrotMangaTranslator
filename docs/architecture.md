# 코드 경계와 품질 규칙

이 문서는 새 기능과 리팩터링에서 지켜야 할 의존 방향, 공용 계약, 오류 처리, 테스트 기준을 정의한다. 실제 강제 규칙은 `.dependency-cruiser.cjs`, `eslint.config.mjs`, `scripts/check-*.cjs`가 담당한다.

## 의존 방향

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
