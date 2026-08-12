# 폰트 자동 맞춤 v2 프로덕션 인계서

최종 갱신: 2026-08-12 KST
현재 제품 기준: `r3h manual-v2 production release`
모델 버전: `manga-font-v8-active21-dfa42ae17f-ffb3285338`

현재 배포 상태:

- GitHub runtime asset prerelease `font-matching-runtime-v2`: 게시 완료
- 게시 자산 7개 서버 재다운로드/SHA 검증: 완료
- 앱 소스의 v2 tag/cache/loader 연결과 로컬 검증: 완료
- 이 작업의 소스 commit/push: 아직 안 함
- 앱 버전 릴리스/installer 게시: 사용자의 별도 지시 전까지 보류

이 문서는 현재 앱에 반영된 폰트 자동 맞춤 v2의 정확한 상태, 출시 근거,
알려진 한계, 시행착오, 재현 명령, 정리 내역과 v3 작업 순서를 한곳에 모은다.
다음 세션은 오래된 계획서보다 이 문서를 먼저 읽는다.

## 1. 지금 무엇이 제품에 들어갔는가

기존 production v1 대신 r3h dual-branch ranker를 기본 runtime으로 연결했다.
후보는 한국어 폰트 21종이며, 픽셀 역할 예측에 따라 body/variant 점수 branch를
고른 뒤 Single Day 안전 마스크, selection calibration, 기존 페이지 일관성 정책을
거쳐 자동 적용한다.

제품 runtime:

`artifacts/font-matching-runtime-active21-v8-r3h-manual-v2-release-v1`

핵심 파일과 SHA-256:

| 파일                  |       bytes | SHA-256                                                            |
| --------------------- | ----------: | ------------------------------------------------------------------ |
| ownership marker      |         755 | `fc0e48ac7c02dac8b4da3a4a448fb579a34dbca42bb73ec3df5a248a25d2e55f` |
| runtime contract      |      21,941 | `11b430ac8782c2060d42592c3da133284ccbd90580c6991f3659c1f8e505b56a` |
| catalog               |      19,942 | `59f7ed49e2ca75d537a3dd4d91aff6d89175c885c45ca8f06b0b0f754ac45676` |
| selection calibration |      19,160 | `501c39cd12019e4334336c486a0b8a87699ea6a5e8845232af5537e0929dc3fb` |
| ranker                |     351,127 | `dfa42ae17f340768cae30f2219973eae1ff62a4c3c1544496502621e6e710c78` |
| prototype bank        |   1,720,320 | `cb4479cd7a48f052698235fd427c7fd90a91fb4ec47e74316bd574b1ffd7bcd3` |
| encoder               | 487,357,925 | `8b9db6bbe272510cedc0f5ce37ce0d1d7f90c146b7c42dd07ca14c26eff4a985` |

release acceptance record SHA는
`c2418e72d42d85be87a67973e7bd4af8b3df46c5b16a2d717280496bfec0a7fd`이다.
이 acceptance는 일반적인 gate 우회가 아니다. exact model, exact fresh work-disjoint
Gemma run, exact 수동 전수 감사에만 허용되는 고정 스키마다. strict calibration
gate가 실패했다는 사실도 contract에 그대로 남긴다.

## 2. 앱 통합과 배포 구조

자산 전용 GitHub prerelease:

`https://github.com/ucx0204/CarrotMangaTranslator/releases/tag/font-matching-runtime-v2`

- tag: `font-matching-runtime-v2`
- target commit: `e27f8509ef1b58f54a84694f9ff2a81ed56454f7`
- draft false / prerelease true
- 위 표의 7개 파일을 개별 asset으로 게시했다. marker의 GitHub asset 이름만
  `default.font-matching-runtime-artifact-owned.json`이다.
- 게시 후 별도의 새 디렉터리에 7개를 전부 다시 다운로드하여 asset count/name/bytes와
  SHA-256을 대조했다.
- 앱 빌드 후 기존 v1 cache가 전혀 없는 새 data root에서 실제
  `ensureFontMatchingRuntimeAssets`를 호출했다. catalog/prototype/encoder를 위 v2 URL에서
  내려받았고 bundle loader가 `qaOnly=false`, `releaseAccepted=true`,
  `failedCalibrationQualityAccepted=true`, model version exact match로 로드했다.
- 이것은 runtime 자산 선게시이며 앱 버전 릴리스는 아직 하지 않았다. 앱 릴리스는
  사용자의 별도 지시를 기다린다.

주요 제품 파일:

- `src/main/pipeline/fontMatchingRuntimePaths.ts`: 새 cache version을 기본값으로 사용한다.
- `src/main/pipeline/fontMatchingRuntimeAssets.ts`: 소형 v2 trust files와 ranker를 앱에서
  설치하고, byte-identical 대형 3파일은 기존 v1 cache에서 검증 후 복사하거나 위의
  immutable v2 asset release에서 다운로드한다.
- `src/main/pipeline/fontMatchingRuntimeReleaseAcceptance.ts`: legacy v1 acceptance와
  exact manual-v2 acceptance를 fail-closed로 검증한다.
- `src/main/pipeline/fontMatchingRuntimeArtifactBundleLoader.ts`: releaseAccepted와
  failed-calibration manual acceptance를 model load에 전달한다.
- `src/main/pipeline/fontMatchingRuntimeArtifactStatus.ts`: production bundle은 유효한
  release acceptance 없이는 ready가 될 수 없다. QA-only는 명시적 opt-in에서만 된다.
- `src/main/pipeline/fontMatchingPagePixelInference.ts`: QA-only 또는 exact manual-v2
  acceptance에 한해서만 failed calibration record를 실행에 사용할 수 있다.
- `src/main/pipeline/fontMatchingPixelCandidateEligibility.ts`: Single Day eligibility.
- `scripts/prepare-runtime.cjs`: 빌드 staging에서도 release acceptance를 강제한다.
- `electron-builder.config.cjs`: marker/contract/calibration/ranker는 installer에 넣고,
  encoder/prototype/catalog만 외부 shared asset으로 남긴다.
- `src/main/runtime/font-matching/`: installer에 들어갈 소형 v2 파일 4개.
- `scripts/dev-build-cache.cjs`: `src/main/runtime/font-matching/`은 TypeScript
  산출물이 아니라 runtime-assets 단계가 소유하므로 Electron 컴파일 캐시 입력/필수
  `out/main` 산출물에서 제외한다. 이 경계가 없으면 `npm run dev`가
  `out/main/runtime/font-matching/.font-matching-runtime-artifact-owned.json` 누락으로
  컴파일 직후 실패한다.

이 구조는 새 cache directory를 사용하므로 v1 cache를 손상하지 않는다. shared file이
정확한 bytes/SHA이면 migration하고, 다르면 v2 tag에서 다시 받는다. marker, contract,
calibration, ranker는 v1에서 복사하지 않는다. 새 설치의 원격 권위는 v2 tag 하나이며,
v1 cache migration은 동일 바이트의 대역폭 절약 최적화일 뿐이다.

## 3. 실제 출시 근거

### 3.1 모델/holdout 근거

r3h adapter:

`artifacts/manga-font-student-v81-role-family-adapter-production-r3h`

- checkpoint SHA: `ff580ef87c949d9b5cc8f4552490015cb621814d6cd5c122018def415792f3de`
- best epoch: 24
- r3 전체 val 9,033행: acceptable 0.680284, preferred 0.596444,
  family accuracy 0.979298
- visual 1,047행: acceptable 0.673352, preferred 0.598854,
  family accuracy 0.993314
- Single Day body false top1: 0
- Single Day eligible top1: 58/9,033 = 0.6421%
- 최대 단일 후보 점유율: 0.5053

이 평가는 checkpoint-selection용 work-disjoint validation이지 독립 release gold가 아니다.
그 권위 제한은 report에 봉인되어 있다:

`artifacts/manga-font-student-v81-role-family-evaluation-production-r3h-v1`

### 3.2 새 작품·새 페이지 Gemma 40p

기존 모델/QA의 작품을 통째로 제외한 v11-r2를 새로 만들었다. 10개 작품,
40개 서로 다른 화, 작품당 최대 5페이지다. master-v3의 24개 작품과 work overlap 0,
기존 QA/검수 page ID/path/SHA overlap 0이다. v10 reserved holdout은 열지 않았다.

fresh full run:

`artifacts/library-full-pipeline-font-qa-v11-r2/runs/baseline40/r3h-v11-work-disjoint-fresh-gemma-v1/full-gemma-20260811-r1`

- run report SHA: `61570016f17039e982c05afb066c92bf649a5ac837d3e8254b847b96bb2d11cb`
- 40/40 completed, cache off, Gemma ja→ko 40/40
- 375 blocks, model apply 337, fallback 38
- Single Day 4, 전부 emphasis 계열, body 0
- outline 337/337 정상, scale 1, 최소 대비 약 17.14

수동 원본해상도 전수 감사:

`artifacts/library-full-pipeline-font-qa-v11-r2/manual-visual-audits/r3h-v11-work-disjoint-fresh-gemma-v1-full-gemma-20260811-r1/root-original-detail-r1/manual-visual-review.json`

- file SHA: `a92a751168d0cbde436371c30e1dcfe613194b80d3eff9787df6b2375f3364eb`
- content SHA: `39e45f037d15dd42f3aa74ee987a0e272d308c13115036f182fc1a6f0dfe1157`
- GOOD 10 / ACCEPTABLE 15 / BAD 5 / N/A 10
- 실제 내용이 있는 30페이지 중 usable 25 = 83.33%
- outline loss 0, Single Day body misuse 0
- authority는 evaluation-only이며 human gold/training/calibration/pseudo/release label 권한은 없다.

사용자가 이 수준을 v2로 앱에 반영하라고 명시적으로 승인했기 때문에 exact evidence에
한정된 manual-v2 acceptance를 만들었다. calibration의 다음 실패는 숨기지 않는다.

- global accepted 31: acceptable 22/31 = 0.709677,
  preferred 13/31 = 0.419355, precision target 0.88 미달
- predicted-variant accepted 30: acceptable 22/30 = 0.733333,
  preferred 13/30 = 0.433333, precision target 0.88 미달

### 3.3 제품 스모크

preflight:

`artifacts/library-full-pipeline-font-qa-v11-r2/runs/baseline40/r3h-v2-production/preflight-20260812-r1`

- QA 허용 플래그 없이 `state=ready`
- `automaticMutationAllowed=true`
- `modelLoaded=true`
- model version exact match

fresh 1-page full-pipeline smoke:

`artifacts/library-full-pipeline-font-qa-v11-r2/runs/baseline40/r3h-v2-production/smoke1-fresh-20260812-r1`

- report SHA: `d02f9a5af26e5844bfc87f591eb26ff38668ab8d3766818cad17635e2d8af848`
- Gemma → OCR → Flux inpainting → live font inference → render completed
- 11 blocks, verified pixel inference 11, font decisions 11, applied 9
- runtime ready/automatic mutation true, page-relative experimental flag false

## 4. 현재 모델의 실제 약점

현재 가장 큰 문제는 Single Day 남발이나 outline 손실이 아니다. 두 문제는 현재 gate로
잘 억제됐다. 문제는 body/variant 역할 일반화와 페이지 내 일관성이다.

- v11 applied 337 중 dialogue 64, emphasis_dialogue 273으로 variant 비중이 매우 높다.
- 일반 본문이 너무 굵거나 개성체가 되고, 반대로 진짜 강조가 얇아지는 케이스가 있다.
- 한 페이지에서 동일 대화군이 서로 다른 서체로 갈라지는 케이스가 있다.
- r3 validation의 family accuracy 99%와 fresh page domain의 체감 사이에 큰 domain shift가 있다.
- 33행 calibration은 차원 수와 role/font 분포에 비해 너무 작고, threshold가 miss를 잘
  분리하지 못한다.

v2는 “자동으로 쓸 수 있는 실용 수준”이지 최종 품질이 아니다. 수동 lock과 fallback은
계속 존중하고, v3가 확실히 이길 때까지 v2 runtime을 비교 기준으로 고정한다.

## 5. 해본 것과 폐기 이유

다음 실험을 반복하지 않는다.

1. **r4/r5/r7 high-value label을 동일 가중치로 재학습**
   - 새 라벨 train-fit은 올랐지만 r3/visual/fresh 진단이 하락했다.
   - 181, 358, 697, 1,347 label은 모두 training-only이고 human gold가 아니다.
   - 누적 최신 데이터는 보존하되 그대로 강하게 fine-tune하지 않는다.
2. **r4a25 interpolation**
   - offline visual/145 blind에서 소폭 좋아졌지만 40p에서 일관된 승자가 아니었다.
   - runtime/ONNX 대용량 복제본은 정리했고 작은 adapter/evidence는 남겼다.
3. **r7a35**
   - offline metric은 소폭 개선됐으나 독립 40p 비교에서 improved 4, regressed 6으로 HOLD.
   - 특히 굵은 강조→얇음, fragment Single Day 회귀가 있었다.
4. **page-relative role reroute v1/v2**
   - 역할 라벨 일부는 정정했지만 실제 selected font/rendered page 개선이 없거나
     p35/p38처럼 role 정정 뒤 폰트가 나빠졌다. production 기본값은 false다.
5. **고정 body override classifier**
   - train work-LOGO에서는 precision 1.0처럼 보였지만 sealed non-val33 9,000에서
     override 27건이 전부 false positive, visual 2건도 전부 false positive였다.
   - rejection artifact:
     `artifacts/experiments/manga-font-r3h-high-precision-body-override-rejection-20260811-r2`
6. **v6-r2/hybrid와 큰 score blend**
   - r3 holdout과 Single Day 안전성에서 크게 회귀했다.
7. **v7 score 15% blend**
   - r3/visual은 소폭 개선했지만 val33과 충돌해 출시하지 않았다.
8. **token-attention residual v8.2**
   - bounded raw candidate가 gate는 통과했으나 alpha sweep에서 r3h base를 이기지 못했다.
9. **33행에 66차원 안팎 calibration**
   - 과적합/불안정하며 strict precision/preferred gate를 못 넘었다.

## 6. 데이터 권위와 절대 지켜야 할 경계

최신 누적 training-only overlay:

`artifacts/manga-font-student-v8-role-family-dataset-r10-high-value-agent-001-1600-training-only-r3-base-r1/role-family-dataset.npz`

- SHA: `e6fcff9926dbde49e9be2b032666535d07b0ca1cbcb4b1549e74b62d42df1a14`
- direct visual labels 1,347 / blind rows 1,600
- `human_gold=false`
- `review_authority=codex_agent_direct_visual_supervision`
- training-only true; calibration/evaluation/release authority false
- r3 val 9,033행은 byte-identical, validation modified 0
- val33/blind-cal/blind-eval/master val/test/adapter-validation/QA page overlap 0

v3에서 이 1,347행을 label authority 이상으로 과장하지 않는다. v11 40p 수동 감사도
evaluation-only라 학습 라벨로 바꾸면 안 된다. v10 reserved holdout은 계속 미개봉으로
유지한다. 이미 모델/정책을 보고 사용한 v11은 다음 모델 선택용 locked test가 아니다.
v3 모델을 고정한 뒤 또 다른 whole-work-disjoint fresh cohort를 만든다.

대규모 재현 cache 중 특히 다음은 삭제하지 않는다.

- `artifacts/manga-font-master-v3-siglip2-hidden-cache-v1`
- `artifacts/manga-font-student-v8-role-family-dataset-r3-body-holdout`
- 위 r10 overlay NPZ
- r3h adapter/evaluation/evaluation-only runtime/corrected graph/base
- v11-r2 selection, run, visual review
- 최종 production v2 runtime

## 7. v3 우선순위

### P0. 역할 supervision을 다시 만든다

가장 먼저 whole-work-disjoint한 body/variant 직접 라벨을 최소 10개 이상 작품에서 만든다.
말풍선, 내레이션, 일반 대사, 실제 강조, shout, sign/title, SFX를 균형화한다. 모델이 만든
`fontRole`, source category, v11 결과를 gold로 쓰지 않는다. crop과 페이지 문맥을 직접
보고, 작품 단위 fold를 사용한다.

필수 gate:

- heldout override가 0이면 neutral pass
- 1건 이상이면 heldout precision ≥ 0.90
- family accuracy 비하락
- acceptable/preferred 비하락
- Single Day body false = 0
- 각 work fold를 별도로 보고하고 macro 지표를 사용

### P1. calibration fit과 locked eval을 분리한다

현재 33행 대신 10개 이상 작품, 최소 200개 고품질 preferred 중심 calibration-fit을
만든다. role/font 균형과 work-LOGO를 유지한다. 별도의 unseen locked evaluation을
같은 시점에 분리하고 calibration 선택에 읽지 않는다. selector는 raw top3 안의 작은
rerank부터 시작하고 candidate one-hot 과적합을 경계한다.

### P2. sample-conditioned ranker는 보수적으로

다음 후보는 frozen r3h를 base로 두고 작은 bounded residual 또는 mixture-of-experts를
학습한다. train-only label을 한 번에 강하게 넣지 말고 staged curriculum/low LR/early
stop을 사용한다. selection은 non-val33 work-disjoint + visual holdout + family/Single Day
gate로만 하고, val33은 승자 고정 후 진단으로만 연다.

### P3. 페이지 일관성은 font selection과 분리해 검증

OCR geometry, visual cluster, bbox 근접성만 사용하되, ordinary cluster의 anchor가 모든
행 raw top3 안에 있을 때만 공유한다. 기존 baseline selected font를 정확히 snapshot하여
no-op/revert 시 byte-identical 복원한다. 역할 accuracy 개선만으로 승격하지 말고 실제
font change block과 rendered page를 독립 육안 비교한다.

### P4. 새 release gate

모델/selector/calibration을 모두 고정한 뒤 새 40페이지를 다음 조건으로 만든다.

- master와 whole-work disjoint
- 모든 이전 QA/라벨 page ID/path/SHA disjoint
- 10개 이상 작품, 40개 서로 다른 화
- fresh Gemma, cache off
- 기존 v2와 blind A/B
- 구조 오류 0, outline loss 0, Single Day body 0
- 내용 페이지 usable rate는 현재 v2의 83.33%를 최소 기준으로 사용
- 회귀 페이지가 있으면 anchor와 원인을 문서화하고 무리하게 승격하지 않는다.

## 8. 재현과 검증 명령

production release 재생성:

```powershell
python scripts/promote_manga_font_r3h_manual_v2_release.py promote `
  --source-runtime artifacts/manga-font-student-v81-role-family-runtime-evaluation-only-production-r3h-v1 `
  --manual-review artifacts/library-full-pipeline-font-qa-v11-r2/manual-visual-audits/r3h-v11-work-disjoint-fresh-gemma-v1-full-gemma-20260811-r1/root-original-detail-r1/manual-visual-review.json `
  --output-dir artifacts/font-matching-runtime-active21-v8-r3h-manual-v2-release-v1
```

검증:

```powershell
python scripts/promote_manga_font_r3h_manual_v2_release.py validate `
  --output-dir artifacts/font-matching-runtime-active21-v8-r3h-manual-v2-release-v1
node scripts/prepare-runtime.cjs
npm run typecheck
npm run typecheck:js
npm run arch:deps
npx vitest run tests/prepareRuntime.test.ts tests/fontMatchingRuntimeAssets.test.ts `
  tests/fontMatchingRuntimeArtifactStatus.test.ts tests/fontMatchingPagePixelInference.test.ts `
  tests/mangaFontV7RuntimeArtifact.test.ts tests/devBuildCache.test.ts tests/installerConfig.test.ts
npm run build
```

개발 실행 캐시 회귀 검증:

```powershell
npx vitest run tests/devBuildCache.test.ts tests/prepareRuntime.test.ts
npm run typecheck:js
npm run dev
```

2026-08-12에 실제 `npm run dev` 첫 실행은 runtime-assets/Electron compile을 다시
빌드한 뒤 Vite ready, Electron 시작, renderer 연결까지 통과했다. 두 번째 실행은 두
build cache 모두 `skip (input and output content are unchanged)`로 재사용하면서 같은
기동 지점까지 통과했고, Electron 종료 뒤 Vite와 repository dev lock도 정상 정리됐다.
`font-matching` marker의 권위 있는 staging 위치는
`out/app-runtime/font-matching/`이며 `out/main/runtime/font-matching/`가 아니다.

production preflight는 `--allow-qa-only-runtime` 없이 실행해야 한다.

```powershell
node scripts/run-library-full-pipeline-qa.cjs run `
  --output artifacts/library-full-pipeline-font-qa-v11-r2 `
  --cohort baseline40 `
  --candidate-id r3h-v2-production `
  --runtime-dir artifacts/font-matching-runtime-active21-v8-r3h-manual-v2-release-v1 `
  --run-id preflight-v2-production `
  --preflight
```

## 9. 2026-08-12 cleanup 기록

20개 경로, 총 7.311 GiB를 Windows 휴지통으로 옮겼다. 영구 삭제가 아니므로 필요하면
복구할 수 있다. 범주는 stale/invalid graph, gate에서 폐기된 후보의 대용량 runtime
복제본, 중단된 QA run이다.

삭제 경로:

- `artifacts/library-full-pipeline-font-qa-v11` (runner manifestPath가 빠진 invalid v1; v11-r2가 대체)
- `artifacts/library-full-pipeline-font-qa-v9/runs/baseline40/r3h-eval-v1/replay-20260811-r1`
- `artifacts/library-full-pipeline-font-qa-v9/runs/baseline40/r3h-eval-v1/replay-20260811-r2`
- `artifacts/library-full-pipeline-font-qa-v9/runs/baseline40/r3h-eval-v1/run-20260811-r1`
- `artifacts/manga-font-student-v81-role-family-onnx-production-r3h-v1`
- `artifacts/manga-font-student-v81-role-family-runtime-base-production-r3h-v1`
- `artifacts/manga-font-student-v81-role-family-onnx-production-r3k-v1-provenance`
- `artifacts/manga-font-student-v81-role-family-runtime-base-production-r3k-v1-provenance`
- `artifacts/manga-font-student-v81-role-family-onnx-r3d-v1`
- `artifacts/manga-font-student-v81-role-family-onnx-r3g-parent-v1`
- `artifacts/manga-font-student-v81-role-family-onnx-interpolated-r3h-r4h-a25-v1`
- `artifacts/manga-font-student-v81-role-family-runtime-base-interpolated-r3h-r4h-a25-v2`
- `artifacts/manga-font-student-v81-role-family-runtime-evaluation-only-interpolated-r3h-r4h-a25-v1`
- `artifacts/font-matching-runtime-active21-v8-r4a25-overlay-base-v1`
- `artifacts/manga-font-student-v81-role-family-onnx-interpolated-r3h-r5h-a50-v1`
- `artifacts/manga-font-student-v8-role-family-graph-r2c`
- `artifacts/experiments/manga-font-v2-r7-interpolated-r3h-full-restart-a35-onnx-20260811-r1`
- `artifacts/experiments/manga-font-v2-r7-interpolated-r3h-full-restart-a35-runtime-base-20260811-r1`
- `artifacts/experiments/manga-font-v2-r7-interpolated-r3h-full-restart-a35-runtime-evaluation-only-20260811-r1`
- `artifacts/experiments/manga-font-v2-r2-distill-r7a35-a03-onnx-20260811-r1`

작은 adapter, rejection report, metric/evaluation report는 학습 이력과 v3 반례로 남겼다.
중간 dataset r4-r9도 일부 스크립트의 재현 기본값이 남아 있어 이번 정리에서는 보존했다.

## 10. 다음 세션 시작 체크리스트

1. 이 문서와 `git status --short`를 먼저 읽는다.
2. final v2 runtime `validate`와 production preflight를 재실행한다.
3. 현재 작업트리의 untracked 학습/평가 scripts를 실수로 버리지 않는다.
4. v11/v10 결과를 training label이나 model-selection test로 재사용하지 않는다.
5. v3 첫 작업은 새 work-disjoint role supervision과 calibration/eval 분리다.
6. 모든 후보는 r3h/v2와 동일 페이지 blind A/B까지 통과한 뒤에만 app default를 바꾼다.
