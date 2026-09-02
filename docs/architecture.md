# 코드 경계와 품질 규칙

이 문서는 새 기능과 리팩터링에서 지켜야 할 의존 방향, 공용 계약, 오류 처리, 테스트 기준을 정의한다. 실제 강제 규칙은 `.dependency-cruiser.cjs`, `eslint.config.mjs`, `scripts/check-*.cjs`가 담당한다.

## 의존 방향

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

## 렌더러 기능 경계

렌더러의 소유 기능은 번역, 가져오기, 보관함, 검수, 인페인팅, 설정, 공유, 조건부 일괄 편집, 효과음, 작업 센터다. 현재 큰 기능은 `components/<feature>`, `app/session`, 기능 전용 hook과 model에 걸쳐 있을 수 있지만 새 의존은 다음 규칙을 따른다.

- feature UI는 `components/ui`, `shared` 계약, renderer gateway, 같은 feature의 model/use case만 import한다.
- 다른 feature의 내부 component, hook, CSS Module을 직접 import하지 않는다. 두 기능이 정말 같은 계약을 쓰면 중립적인 하위 primitive나 shared domain contract로 먼저 승격한다.
- feature를 한꺼번에 재수출하는 barrel은 만들지 않는다. composition root는 필요한 public component를 소유 파일에서 직접 import한다.
- 동일 명령의 사이드바, 빈 화면, 명령 팔레트 진입점은 `AppCommandId`와 단일 command map을 공유한다. 진입 위치는 여러 곳이어도 실행 함수와 표시 이름의 권위는 하나다.
- 큰 화면은 UI, 상태 model, 순수 변환, 외부 effect를 분리한다. `ConditionalBatchRulePanel`과 `RichTranslationEditor`의 내부 모듈 구성이 기준 예시다.

UI 표면과 primitive 선택은 [`ui-design-rules.md`](ui-design-rules.md)를 따른다.

## 공용 계약과 SSOT

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
