# 중복 코드 인벤토리

`jscpd 5.1.1`, weak mode, 최소 12줄/80토큰, JavaScript–TypeScript 교차 비교로 처음 잡힌 40개 exact clone의 판단 기록이다. 2026-09-02의 첫 정리에서 29~31번을 제거해 현재 기준선은 37개다. `scripts/jscpd-baseline.json`은 이 목록을 임시 허용하는 면허가 아니라 새 중복과 재도입을 막는 감소 전용 기준선이다.

판단 원칙은 다음과 같다.

- 소유 도메인, 입력·출력, 오류·취소 정책, 변경 이유가 모두 같을 때만 한 구현으로 합친다.
- 서로 import할 수 없는 격리 CJS runtime과 Electron TypeScript 사이의 계약 복제는 유지하되 동일 fixture를 실행하는 parity test를 둔다.
- 폰트 매칭 v2, Hayai geometry, work-context research처럼 봉인된 영역은 characterization test보다 먼저 이동하지 않는다.
- 모양만 비슷하고 실패 의미가 다른 코드는 합치지 않는다. 필요하면 더 작은 pure primitive만 공유한다.

## 2026-09-02 기준 분류

|   # | Clone 쌍                                                         | 판단                                    | 처리 방향                                                  |
| --: | ---------------------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------- |
|   1 | `amdRocmTargets.ts` ↔ runtime `amd-rocm-target.cjs`              | 의도적 runtime 복제                     | 동일 GPU 이름 fixture parity를 봉인하고 유지               |
|   2 | `bubbleMaskRefinement` ↔ `koharuMaskRefinement` crop clamp       | 같은 geometry 계약                      | shared crop primitive로 통합                               |
|   3 | 위 두 모듈의 prompt sample 범위 계산                             | 같은 geometry 계약                      | sample-range primitive로 통합                              |
|   4 | 위 두 모듈의 mask sample 변환                                    | 같은 geometry 계약                      | 공통 하위 primitive로 통합                                 |
|   5 | `bubbleSameBlockRegionPartition` 내부 두 branch                  | 같은 로컬 계약                          | branch 입력을 매개변수화한 helper로 통합                   |
|   6 | `httpResponseBudget.ts` ↔ runtime `bounded-response-body.cjs`    | 의도적 runtime 복제                     | byte/chunk/error fixture parity를 봉인하고 유지            |
|   7 | Flux `cpuRunner` ↔ `runner`                                      | 같은 asset-runner 계약                  | 실행 파일 해석·검증 primitive 공유                         |
|   8 | `fluxWorker` ↔ `koharuWorker`                                    | 같은 JSON-lines worker lifecycle        | transport/lifecycle adapter 공유, backend 오류 코드는 유지 |
|   9 | `koharuTypographyMask` ↔ `sharedBubbleTextBridge`                | 같은 raster crop 계산                   | pure raster geometry helper 공유                           |
|  10 | `rasterMasks` 내부 두 raster loop                                | 같은 로컬 계약                          | stride/bounds helper로 통합                                |
|  11 | `sourceGlyphEvidenceReceipt` ↔ `unassignedOcrResidualProvenance` | 검증 골격만 같고 권위는 다름            | 공통 fail-closed verifier primitive만 공유                 |
|  12 | `translationJobRunners` ↔ `translationRegionJobRunner`           | 같은 job settlement 계약                | cancellation/terminal settlement helper 공유               |
|  13 | `autoMatchActiveCatalogContract` ↔ calibration contract          | 봉인된 폰트 계약의 유사 schema          | v2 characterization 이후 schema primitive만 검토           |
|  14 | calibration contract 내부 두 validator                           | 같은 로컬 계약                          | 판별자 입력을 매개변수화                                   |
|  15 | `overlayItemReferences` ↔ `overlayOcrGeometryLocks`              | 같은 reference normalization            | shared overlay-reference primitive로 통합                  |
|  16 | `overlayOcrGeometryLocks` ↔ `overlayOcrSourceLineGeometry`       | 같은 line geometry normalization        | shared geometry primitive로 통합                           |
|  17 | `runtimeIntegrity.ts` ↔ runtime `runtime-integrity.cjs`          | 의도적 runtime 복제                     | manifest/hash fixture parity를 봉인하고 유지               |
|  18 | runtime result-artifact settings ↔ request summary               | 같은 CJS settings projection            | runtime settings helper 공유                               |
|  19 | runtime work-context prompt ↔ `workContextBudget.ts`             | 격리 runtime 계약 복제                  | budget fixture parity를 봉인하고 유지                      |
|  20 | semantic OCR region barriers ↔ reading-start partition           | 모양은 같지만 분할 정책이 다름          | 합치지 않고 작은 interval primitive만 검토                 |
|  21 | semantic OCR evidence ↔ review relations #1                      | 같은 relation projection                | CJS semantic relation helper 공유                          |
|  22 | semantic OCR evidence ↔ review relations #2                      | 같은 relation projection                | 위 helper로 통합                                           |
|  23 | review relations ↔ paddle recovery                               | 오류·복구 의미가 다름                   | 합치지 않음; 공통 shape builder만 검토                     |
|  24 | runtime language profile ↔ `translationLanguages.ts`             | 의도적 runtime 복제                     | language alias fixture parity를 봉인하고 유지              |
|  25 | runtime model config ↔ `apiSettings.ts`                          | 의도적 runtime 복제                     | endpoint/model default fixture parity를 봉인하고 유지      |
|  26 | request summary 내부 인접 projection                             | 같은 로컬 계약                          | keyed projection helper로 통합                             |
|  27 | `tavilyClient` ↔ `tavilyUsage`                                   | 같은 usage response 정규화              | Tavily response policy helper 공유                         |
|  28 | work-context evidence ↔ normalize                                | 보호 영역의 같은 proposal normalization | research characterization 이후 pure normalizer 공유        |
|  29 | Conditional Batch action ↔ conditions card                       | 같은 collapsible chrome                 | 완료: feature-owned disclosure를 공유하고 editor는 분리    |
|  30 | page retranslate ↔ translation options modal footer              | 같은 기본값 저장·취소·실행 계약         | 완료: `TranslationOptionsActionBar` 공유                   |
|  31 | Style Guide Characters ↔ Glossary tab                            | 같은 keyed-list editor 계약             | 완료: typed `ContextEntryTable` primitive 공유             |
|  32 | `useBlockReadingOrderActions` 내부 두 mutation                   | 같은 command transaction                | mutation command helper로 통합                             |
|  33 | reading-order action ↔ selected-block update                     | 같은 selected-block commit 골격         | selection/commit primitive 공유, 의미별 command 유지       |
|  34 | bubble disjoint geometry ↔ padding                               | 경계 clamp만 같음                       | bbox clamp primitive만 공유                                |
|  35 | conditional batch engine ↔ field registry                        | 같은 typed field-result construction    | registry-owned result constructor 공유                     |
|  36 | curve transform ↔ perspective transform                          | 같은 homogeneous point mapping          | pure transform math primitive 공유                         |
|  37 | font evidence schema ↔ profile schema                            | 봉인된 계약의 공통 schema fragment      | v2 parity 이후 명명된 schema primitive 공유                |
|  38 | `ipcJobSchemas` request variant A ↔ B                            | 같은 base envelope                      | base schema `.extend()` 사용                               |
|  39 | `ipcJobSchemas` request variant A ↔ C                            | 같은 base envelope                      | base schema `.extend()` 사용                               |
|  40 | `ipcJobSchemas` request variant A ↔ D                            | 같은 base envelope                      | base schema `.extend()` 사용                               |

## 기준선 갱신 규칙

clone을 제거한 변경은 `jscpd`를 같은 옵션과 `--baseline scripts/jscpd-baseline.json --update-baseline`로 실행해 사라진 fingerprint를 같은 커밋에서 제거한다. 새 clone을 기준선에 추가해 검사를 통과시키는 것은 금지한다. 격리 runtime 복제를 새로 만들 수밖에 없다면 먼저 계약 fixture parity test와 이 문서의 사유를 추가하고 리뷰에서 명시적으로 승인한다.
