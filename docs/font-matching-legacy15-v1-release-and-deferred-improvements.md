# Font Matching legacy15 v1 출시 기록과 후속 개선 인계서

작성 시점: 2026-08-02

## 결론

현재 앱에는 **15개 한글 폰트를 대상으로 하는 실사용 우선 v1**을 탑재했다. 이 버전은 새로 학습한 SigLIP 기반 픽셀 모델, 동결 테스트, ONNX 변환, 실제 설치 폰트 검증, 앱 런타임 실추론을 모두 통과했다.

22개 폰트 확장, 추가 육안검수, r003/r004 보정 라운드, 장기 재라벨링은 이번 출시의 조건이 아니다. 이 작업들은 현 버전을 다시 막지 말고 별도의 후속 개선으로 진행한다. 특히 이미 끝난 9,781장 육안검사를 처음부터 반복하지 않는다.

## 현재 탑재된 버전

### 후보 폰트 15개

1. `cafe24-gowoonbam`
2. `chosun-gungseo`
3. `dohyeon`
4. `gaegu`
5. `griun-pol-sensibility`
6. `jua`
7. `mongtori`
8. `nanum-barun-gothic`
9. `nanum-gothic`
10. `nanum-myeongjo`
11. `ridi-batang`
12. `seoul-hangang`
13. `seoul-namsan`
14. `seoul-namsan-vertical`
15. `start-over`

활성 카탈로그 버전은 `fontclip-font-catalog-v1-legacy15-pragmatic`이다. 이번 결정은 기존 15개 후보를 즉시 출시하고 후속 7개 후보의 정식 전환을 미루는 임시 다리다. 사용자 승인 레코드는 `user-directive-2026-08-02-pragmatic-release`로 봉인했다.

### 학습 데이터와 경계

- audit-eligible 표본: 1,151개
- train: 697개
- validation: 204개
- frozen test: 250개
- 학습 중 frozen-test 픽셀을 연 횟수: 0
- optimizer, calibration, prototype, hard-negative에 frozen-test 행을 사용한 횟수: 0
- QA overlay와 synthetic/생성 이미지를 핵심 학습·평가에 포함한 수: 0
- 학습은 fresh initialization으로 시작했고 이전 모델은 optimizer 초기값으로 사용하지 않았다.
- 40 epoch 상한, early stopping 결과 14 epoch 실행, best epoch는 6이다.

데이터는 일반 대사만 많이 넣는 방식보다 말풍선 가장자리 문구, 강조 대사, 외침, 속삭임, 낙서체, 충격·움직임·감정·코믹·환경 효과음 등 변칙 역할을 우선하도록 구성했다. 일반 대사는 회귀 방지 기준을 따로 걸어 과도한 중복이 모델을 지배하지 않게 했다.

### 검증 성능

Validation 204개에서:

- 전체 acceptable@1: 81.37%
- 전체 recall@3: 89.22%
- P1 변칙 역할 macro acceptable@1: 86.55%
- P1 변칙 역할 recall@3: 99.23%
- 일반문 acceptable@1: 88.89%
- 일반문 회귀 방지 gate: 통과

학습과 완전히 분리된 frozen test 250개에서:

- 전체 acceptable@1: 83.62%
- 전체 recall@3: 96.55%
- P1 변칙 역할 macro acceptable@1: 77.04%
- 일반문 acceptable@1: 85.51%
- P0/P1 `none` F1: 25.00%
- 화 내부 local override 성공률: 62.75%
- 출시 gate: 전 항목 통과

`acceptable@1`은 1순위가 사람 라벨의 허용 폰트 집합 안에 들어간 비율이다. 폰트 인상은 하나의 절대 정답만 존재하지 않는 경우가 많으므로 단일 preferred 정답보다 이 지표를 주 지표로 사용한다.

### 보수적 자동 적용 정책

- 최소 보정 confidence: 0.82
- 최소 역할 confidence: 0.75
- 의도적인 변칙 폰트 변경 최소 confidence: 0.88
- 의도적 변경 최소 점수 margin: 0.12
- 번역 문자열의 glyph coverage 필수
- `noneAcceptable=false` 필수
- 봉인된 runtime artifact가 `ready` 상태여야 함
- 화 단위 prior의 최대 기여: 0.08
- 화 prior를 쓰기 위한 최소 anchor: 3개
- 실제 국소 변화가 있으면 화 prior보다 우선
- 국소 override 최소 margin: 0.12
- 모델·계약·폰트가 없거나 깨지면 자동 추측하지 않고 명시적으로 비활성화
- 사용자 수동 폰트 잠금은 항상 우선

장르 정보는 약한 보조 prior로만 다룬다. 예를 들어 영애물과 명조체, 소년 액션물과 굵은 고딕체의 상관을 참고할 수는 있지만 장르만으로 폰트를 강제하지 않는다. 최종 판단은 실제 글자 픽셀, 역할, 처리 효과, 화 내부 증거가 우선이다.

## 출시 산출물과 재현 기준

### 핵심 경로

- 학습 결과: `artifacts/font-matching-siglip-legacy15-release-v1`
- feature cache: `artifacts/font-matching-siglip-legacy15-release-v1-feature-cache`
- frozen-test 예측: `artifacts/font-matching-frozen-test-legacy15-release-v1`
- frozen-test 출시 평가: `artifacts/font-matching-frozen-test-release-legacy15-v1.json`
- 15폰트 활성 카탈로그: `artifacts/font-matching-legacy15-pragmatic-active-catalog-v1`
- ONNX 변환: `artifacts/font-matching-runtime-onnx-legacy15-v1`
- 런타임 정책: `artifacts/font-matching-runtime-policy-legacy15-v1.json`
- 앱이 복사하는 최종 번들: `artifacts/font-matching-runtime-full22-final-v1`
- 개발 앱에 실제 탑재된 번들: `out/app-runtime/font-matching`

마지막 두 경로의 `full22` 문자열은 기존 배포 스크립트가 사용하는 고정 디렉터리 이름일 뿐이다. 실제 계약의 후보 수는 15이며 앱도 동적으로 15개를 읽는다.

### 중요 SHA-256

- checkpoint: `7f8ec67764c7c5e37223b3639df3612689ef97e65c75fb16b926e79a2880aec0`
- model-contract 파일: `e5b252f30e4e4781e645e7b2668d52a1cc61a536406a99baad1e0dce18e1ed89`
- training report 파일: `43079362bd03f7b1748cb0e0677a144f1c2627ef9d9b92fc6c17a741f2eed40c`
- frozen-test manifest: `e84adb95784bac7eb8ff7652714091dd6c5b5ecdca644af259426de2a256830f`
- frozen-test release 파일: `33791d3cc07569b2e6cf32c7251602501341c066e9f4686fbc9b997ee0324658`
- frozen-test release record: `f0b838e7f1ebb7cff0b87bcac4de594db2e88923cf3e809545d437a60ba3b3d6`
- 활성 카탈로그 record: `89e412722620c03f6cba5b2b0f17d67f9ea014ec00bde75452a809b21f581e5c`
- 실용 출시 승인 record: `968146c228b964bceead73351055b582603744b77e0d6e96dd11f25900e318bc`
- encoder ONNX: `8d0c792709e1b4fab0566a2f7a5a750bd188ca3e94127e66c3ee7e498bd4883f`
- ranker ONNX: `d89bc8e7da3fe5090896c7e32ab5460df4a66b53de08919af1198b90a6a6560f`
- prototype bank: `c2c7a0e0a39e4415523c5c6be0aa25a6c5f7f8852588ed64b6e7a35399d0a0bc`
- ONNX parity report 파일: `f21b2f2128629c04186c692c571d8566ba9d2f894f3bcf46193367f25dadf0da`
- runtime policy record: `1bbf7561017b74687d57d86110e0097ffa5eb3239d6d128ece699720007104c7`
- runtime contract 파일: `52de5c22333d71aaf698b195ca2e8f2e3a70a23448a958a080cf8fc55dff6d1c`

### 마지막 통합 검증

- ONNX CPU와 PyTorch encoder 최소 cosine similarity: 0.99999988
- ONNX CPU와 PyTorch ranker top-1 일치: 100%
- Electron `onnxruntime-web@1.27.0` WASM과 PyTorch ranker top-1 일치: 100%
- 실제 앱 로더가 설치된 15개 폰트 파일을 크기·SHA-256으로 검증: 통과
- 실제 탑재 encoder/ranker session 생성: 통과
- 실제 픽셀 1블록을 3-view로 전처리하고 15개 순위를 반환: 통과
- 이 실추론의 loader warning: 0개
- TypeScript 및 JavaScript typecheck: 통과
- 프로덕션 빌드: 통과
- 관련 Python release-chain 테스트: 43개 통과
- 관련 TypeScript/Vitest 집중 테스트: 6개 파일, 50개 통과

배포 중 발견한 `policy_sha256` 계약 불일치는 수정했다. Python 빌더가 정책 해시를 필수로 넣었는데 앱 파서가 과거 테스트 계약의 두 필드만 허용하던 문제였다. 현재 파서는 정확히 세 필드를 요구하고 `policy_sha256`도 소문자 64자리 SHA-256인지 검사한다. 즉 해시를 무시하도록 완화한 것이 아니라 실제 최종 계약에 맞춰 fail-closed 검증을 강화했다.

## 22폰트 버전을 이번에 출시하지 않은 이유

추가 후보 7개는 다음과 같다.

1. `black-and-white-picture`
2. `black-han-sans`
3. `gasoek-one`
4. `gugi`
5. `kirang-haerang`
6. `nanum-brush-script`
7. `single-day`

이 7개가 전혀 쓰이지 않은 것은 아니다. 현재 수집·판정 자료에서 모두 실제 선택 증거가 있으므로 “사용 예가 없으니 삭제”할 대상은 없다. 다만 폰트별 표본 불균형과 독립 calibration이 아직 충분하지 않아, 이번 15폰트 출시보다 안전하다고 증명되지 않았다.

현재 정식 조건을 엄격히 만족하는 full22 export는 172개뿐이다.

- train: 109개
- validation: 33개
- test: 30개
- 작품 수: 24개
- 후보: 22개
- 상태: training-only / diagnostic
- formal calibration gate: 미통과

경로는 `artifacts/font-matching-training-export-full22-strict-v1`이다. 이 작은 풀로 만든 `artifacts/font-matching-siglip-full22-strict-gated-v2`와 utility report는 비교·진단용이지 현재 앱 배포 권한이 아니다.

한편 후속 라벨 판정에는 약 620개의 추가 adjudicated 표본이 남아 있다. 엄격 풀 172개와 합치면 최대 792개 후보 풀이 되며, 현재 계획상의 work-disjoint 분할은 train 483 / validation 152 / test 157이다. 이 숫자는 후속 정식 export를 다시 봉인할 때 재검증해야 한다. crop/source 검토가 끝나지 않은 11개는 이 풀에 억지로 재투입하지 않는다.

정확한 근거는 `datasets/font-matching-catalog-delta-ledger-production-v5/reviews.jsonl`이다. 이 ledger에는 primary 1,151 + secondary 738 + adjudication 631, 총 2,520 review가 있다. adjudication 631개 중 font-signal-present가 620개이고 crop-needs-review 11개는 제외되어 있다. 620개 내부는 `none` 290 / safe-positive 330이며 split은 train 374 / validation 119 / test 127이다. 제외 11개는 train 10 / test 1이다. 620개와 strict172 사이 sample overlap은 0개다.

## 현재 남은 약점

1. `none` 표본이 부족하다. frozen-test P0/P1 `none` F1이 25%로 다른 순위 지표보다 약하다. 따라서 현재 런타임은 confidence와 `noneAcceptable` 조건을 보수적으로 사용한다.
2. 데이터 방향이 세로쓰기 쪽으로 약 86% 치우친 구간이 있다. 가로쓰기 변칙 문구와 가로 효과음을 더 모아야 한다.
3. 희귀 역할인 `sfx_ambient`, `aside_balloon_edge`, 일부 손글씨·휘갈김·문장형 강조가 작품 다양성 면에서 부족하다.
4. 전체 작품 수가 아직 넓지 않다. 특정 작품이나 특정 장르의 스타일을 보편 규칙으로 오인하지 않도록 작품 단위 분리를 유지해야 한다.
5. 후속 7개 후보 사이 표본 수 차이가 크다. 단순히 샘플을 복제해 균형을 맞추면 과적합될 수 있다.
6. 화 단위 chapter pair 학습은 이번 legacy15 sealed export에서 비활성화되어 있다. 런타임의 약한 prior는 안전장치 중심이고, 학습된 화 일관성 신호는 다음 단계에서 보강해야 한다.
7. r003/r004 source review와 정식 두 차례 calibration이 끝나지 않았다.
8. 사용자 실사용에서 “추천을 그대로 수용했는지, 몇 초 뒤 어떤 폰트로 고쳤는지”에 대한 telemetry가 아직 없다.

## 다음 세션에서 이어갈 순서

### 1. 현재 v1을 기준선으로 고정

먼저 위 SHA-256과 `out/app-runtime/font-matching/runtime-contract.json`을 검증한다. legacy15 v1을 재학습하거나 9,781장 육안검사를 처음부터 반복하지 않는다. 다음 작업은 항상 이 모델과 frozen-test 결과를 baseline으로 비교한다.

### 2. r003/r004 검토만 마무리

기존 blind review 산출물과 private binding을 재사용한다. 이미 판정된 행을 다시 처음부터 읽지 말고, 미완료·불일치·교체 요청 행만 처리한다. reviewer A/B는 후보 이름을 보지 않는 독립 판정을 유지하고, 합의가 없는 표본은 억지 top-1로 만들지 않는다.

현재 확인된 r003 핵심 경로:

- `datasets/font-matching-calibration-preflight-v5-round2/draws/003-extension`
- `datasets/font-matching-calibration-preflight-v5-round2/reviews/003-extension`
- `datasets/font-matching-calibration-preflight-v5-round2/review-inputs/extension-003-reviewer-a.jsonl`
- `datasets/font-matching-calibration-preflight-v5-round2/review-inputs/extension-003-reviewer-b.jsonl`

실제 source precheck 진행 상태는 다음과 같다.

- 기존 r003 120개 reviewer A: `C:\tmp\font-matching-redacted-precheck-r003-reviewer-a-v4-sealed\summary.json` — clean 71 / reject 49
- 기존 r003 120개 reviewer B: `C:\tmp\font-matching-redacted-precheck-r003-reviewer-b-v4-sealed\summary.json` — clean 27 / reject 93
- 양쪽 double-clean: 21개, 12작품
- r003 보충 queue: `C:\tmp\font-matching-r003-supplemental-source-precheck-v1\source-queue-manifest.json` — 65개, 아직 training/publication 미승인
- 보충 구성: ordinary 26, aside 8, emphasis 5, sign 11, SFX 15(5종 × 3)
- 보충 shortlist: 같은 폴더의 `shortlist-review-summary.sealed.json` — sign/SFX 후보 48개 확인, clean 26 / reject 22
- 보충 A/B pack: `C:\tmp\font-matching-redacted-precheck-r003-supplemental-reviewer-a-v5\reviewer-pack\manifest.json`, `C:\tmp\font-matching-redacted-precheck-r003-supplemental-reviewer-b-v5\reviewer-pack\manifest.json` — 각각 65 task, 아직 response/sealed summary 없음

r004 진행 상태:

- bundle: `C:\tmp\font-matching-r004-double-clean-precheck-v2\bundle-manifest.sealed.json`
- active 152개 / 15작품, 기존 master 128 + 신규 3작품 × 8 = 24, reserve 44
- A/B public pack은 각각 152 task
- reviewer A 응답: `C:\tmp\font-matching-r004-reviewer-a-responses.jsonl` — 10/152, 현재 모두 clean
- reviewer B 응답: 아직 없음
- bundle 상태: `sealed_packs_ready_review_not_performed`
- r003/r004 overlap 감사: `C:\tmp\font-matching-r004-double-clean-precheck-v2\integration\r003-r004-disjointness-audit.sealed.json` — overlap 0
- 통합 제안: 같은 `integration` 폴더의 `successor-integration-proposal.sealed.json` — training 승인 false, master/registry/production mutation 모두 false

`C:\tmp` 아래 파일은 정식 저장소 산출물이 아니므로 다음 세션을 시작할 때 먼저 존재 여부와 SHA-256을 확인한다. 보존이 필요하면 원본 구조와 sealed manifest를 함께 안전한 작업 폴더로 복제한 후 작업하되, 이전 draw를 덮어쓰지 않는다. r004 또는 후속 replacement 라운드는 같은 preflight contract와 replacement request를 기준으로 이어 붙인다.

### 3. 라벨 품질 gate

각 표본에 다음을 다시 강제한다.

- 실제 원문 crop이며 빨간/청록 박스, OCR debug box, QA overlay가 없음
- 글자 획이 잘리지 않고 과도한 주변 그림이 없음
- source family, acceptable set, preferred set, `none`, 역할, 방향, 외곽선, 그림자, 왜곡이 서로 모순되지 않음
- 효과음과 강조문은 장식 자체와 기본 glyph 인상을 분리해 기록
- 말풍선 본문은 같은 화의 반복을 줄이되, 실제 폰트 변화는 보존
- 작품/화 ID와 split binding이 유지됨
- 생성형 보정본은 실제 원문과 섞지 않고 augmentation 전용 quarantine에 둠
- 생성 이미지, 빨간 박스 이미지, QA 이미지는 validation/frozen test에 절대 넣지 않음

“데이터 양보다 품질”을 우선한다. 5천장을 채우기 위해 경계가 잘리거나 폰트 신호가 없는 이미지를 넣지 않는다. 희귀 변칙 역할은 수량 목표보다 역할별 최소 작품 수와 독립 판정률을 우선한다.

### 4. 792 후보 풀 재봉인

620 adjudicated + 172 strict의 중복, parent/supersession, source hash, 작품 분리, 11개 미완료 crop 제외를 재검증한다. 목표 분할 483/152/157이 실제 work-disjoint 조건을 만족하는지 확인한 뒤 새 `training-export-full22`를 만든다.

일반 말풍선 본문은 동일 작품·화·역할·스타일 cluster에서 중복 상한을 둔다. 반대로 변칙 역할, 손글씨, 휘갈김, 효과음, 강조문, 세로/가로 처리 차이는 보호 표본으로 유지한다.

### 5. full22 fresh 학습과 비교

동일한 SigLIP encoder, 3-view 전처리, prototype-bag ranker를 사용해 fresh initialization으로 학습한다. 후보 ID embedding이나 후보별 bias를 추가하지 않는다. frozen test는 optimizer, calibration, prototype, hard-negative에서 계속 차단한다.

legacy15와 다음을 동일 표에서 비교한다.

- 전체 acceptable@1 / recall@3
- P1 변칙 역할 macro acceptable@1
- 역할별 recall@3
- 일반문 acceptable@1과 불필요한 화내 폰트 변경
- `none` precision/recall/F1
- local override 성공률
- 후보별 독자적 utility와 대체 가능성
- 작품별/장르별 편차
- 가로/세로 방향별 편차

22폰트가 전체 평균만 비슷하고 변칙 역할을 개선하지 못하면 출시하지 않는다. 반대로 추가 7개 중 특정 폰트가 충분한 실제 표본에서도 독자적 utility가 없고 다른 후보에 완전히 지배되면, 그때 근거와 함께 prune한다. 현재 단계에서 7개를 일괄 삭제하지 않는다.

### 6. calibration 두 라운드

서로 다른 작품으로 최소 두 번의 scored calibration을 수행한다. 한 라운드의 threshold를 다음 라운드에 맞춰 임의 조정하지 않는다. confidence calibration, `none` threshold, 변칙 override margin, 화 prior 기여도를 따로 측정한다.

### 7. 실사용 telemetry로 마지막 개선

사용자 동의가 있는 로컬 우선 telemetry를 설계한다.

- 자동 추천 폰트를 그대로 유지했는지
- 사용자가 최종적으로 바꾼 폰트
- 추천 후 수정까지 걸린 시간
- top-3 중 하나로 바꿨는지
- 역할, confidence, margin, 방향, 처리 효과
- 같은 화에서 반복적으로 같은 수정이 발생했는지
- 작품 ID는 원문 제목 대신 로컬 hash 사용

이 신호를 다음 active-learning queue에 사용하면, 일반 대사 중복을 늘리지 않고 실제로 틀린 변칙 사례부터 보강할 수 있다.

## 다음 작업자에게 줄 짧은 시작 지시문

> `docs/font-matching-legacy15-v1-release-and-deferred-improvements.md`를 먼저 읽고, 현재 legacy15 v1과 frozen-test 결과를 기준선으로 보존하라. 9,781장 검수를 반복하거나 현재 배포를 다시 막지 말고, 미완료 r003/r004와 11개 crop/source review만 정리한 뒤 620+172 후보 풀을 work-disjoint하게 재봉인하라. full22 fresh 모델을 학습해 변칙 역할, none, 화 일관성, 일반문 회귀를 legacy15와 비교하고, 우월할 때만 새 ONNX/runtime bundle로 승격하라.

## 하지 말아야 할 것

- 현 15폰트 출시를 22폰트 연구가 끝날 때까지 다시 막지 않는다.
- 이미 끝난 전체 육안검사를 이유 없이 반복하지 않는다.
- 빨간 박스·청록 박스·OCR debug 이미지를 데이터로 쓰지 않는다.
- 생성형 이미지를 실제 frozen-test 근거로 쓰지 않는다.
- 장르만 보고 명조/고딕/효과음체를 강제하지 않는다.
- 화 일관성을 hard constraint로 만들어 실제 강조·효과음 변화를 지우지 않는다.
- 사람 합의가 없는 애매한 표본에 억지 단일 정답을 붙이지 않는다.
- 추가 7개를 단순 사용 횟수 하나만 보고 삭제하거나, 반대로 존재한다는 이유만으로 모두 출시하지 않는다.
