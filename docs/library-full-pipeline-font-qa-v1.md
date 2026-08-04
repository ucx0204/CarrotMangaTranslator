# 보관함 40페이지 전체 파이프라인 폰트 QA

이 하네스는 컴퓨터 유즈 없이 실제 보관함 페이지를 고정 선정하고, 앱의 프로덕션 모듈로 OCR → 번역 → 폰트 자동 맞춤 → 인페인팅 → 말풍선 레이아웃 → PNG 렌더를 실행한다. 기본 명령은 항상 드라이런이며 `--execute`를 명시하기 전에는 모델, OCR, 번역, 인페인팅을 시작하지 않는다.

## 1. 두 코호트 고정

```powershell
npm run qa:library-fonts -- inspect --output artifacts/library-full-pipeline-font-qa-v9
```

기본 출력 경로 `artifacts/library-full-pipeline-font-qa-v7`은 이전 명령 호환용이다. 새 회차는 항상 명시적인 새 `--output`을 사용한다. v1~v7은 경계 보정 전 진단본이고, v8은 baseline 선점으로 holdout 작품 다양성이 부족했던 실행 전 진단본이므로 실사용 실행에 쓰지 않는다.

- `baseline40`: 첫 반복 개발에 쓰는 40페이지다.
- `holdout40`: baseline 반복이 만족스러워진 뒤에만 여는 완전히 다른 40페이지다.
- 두 코호트는 페이지와 화가 서로 겹치지 않는다. selector는 baseline을 먼저 완성하지 않고 두 코호트를 번갈아 공동 배정한다. 각 cohort에 아직 없는 작품을 우선하고, 화가 적게 남은 작품은 양쪽에 교차 배정하거나 한 화뿐인 작품을 양쪽에 나눠 준 뒤 작품별 선택 수를 균등화한다.
- 각 40장 중 최대 20장을 변칙 폰트 페이지로 먼저 예약한다. `fontRole`/`textRole`, 구형 chapter의 `type: sfx`, 회전·필기체 신호를 우선 쓰고, 부족한 작품은 OCR 문자열이나 픽셀을 열지 않은 채 detector의 normalized box만으로 극단 종횡비·큰 비말풍선 영역·페이지 가장자리 배치를 proxy로 사용한다. 작품별 cap은 이 enrichment보다 항상 우선한다.
- seed, 원본 이미지 SHA-256, `chapter.json` SHA-256, manifest SHA-256을 기록한다. 같은 출력 디렉터리의 선택은 덮어쓰지 않는다.
- `selection.json.cohortSelection`에는 공동 배정 알고리즘 버전, 전체 page/chapter disjoint 계약, 변칙 페이지 예약 비율을 함께 봉인한다.
- 기본 source boundary는 master-v2, strict supervised export, adjudicated val33이다. 그 안의 train/val/test/calibration/label source page id·경로·SHA는 모두 후보에서 제외한다. 80장을 고른 뒤 원본을 실제 해시하여, 다른 ID/경로를 가진 복제 이미지까지 제거하고 다시 선정한다. 다른 입력은 `--boundary <json-or-jsonl>`을 반복 지정한다.
- 학습 표본이 들어 있는 작품 전체를 격리하려면 select에서 `--work-boundary <json-or-jsonl-or-directory>`를 반복 지정한다. 각 JSON record의 최상위 `work_id`, `workId`, 또는 `work.id`만 읽으며 provenance 같은 더 깊은 중첩 필드는 따라가지 않는다. 디렉터리를 주면 바로 아래의 모든 `.json`/`.jsonl` 파일을 결정론적으로 스캔한다. 발견한 작품 ID에 속한 보관함 페이지는 page id나 SHA가 달라도 전부 후보에서 제외한다. 이 경계는 기존 page/경로/SHA source boundary를 대체하지 않고 추가로 적용된다.
- `selection.json`의 `workBoundary`에는 입력 파일별 경로·크기·SHA-256·record 수, 전체 binding SHA-256, 제외 작품 ID 수, 실제 보관함에서 제외된 작품·페이지 수가 봉인된다.

`inspect`는 80개 원본을 다시 해시하고 데이터 경계와의 page id, 상대 경로, source SHA 중복을 재검사한다. 선택 시 봉인한 work-boundary 파일을 다시 읽어 파일 hash/count drift와 cohort 작품 중복도 검사한다. 파일이 사라지거나 바뀌거나 한 페이지만이라도 경계 작품에 속하면 실패한다.

## 2. 비용 없는 실행 계획 확인

```powershell
npm run qa:library-fonts -- run --output artifacts/library-full-pipeline-font-qa-v9 --cohort baseline40 --candidate-id student-v2
```

이 명령은 실행 계획만 출력한다. 실제 실행 전에는 최신 코드를 컴파일한다.

컴파일된 22-font catalog, seal, ONNX session, calibration을 로드하되 OCR·번역·인페인팅을 시작하지 않는 안전 preflight는 다음과 같다.

```powershell
npm run compile:electron
npm run qa:library-fonts -- run --output artifacts/library-full-pipeline-font-qa-v9 --cohort baseline40 --candidate-id student-v2-preflight --runtime-dir <candidate-runtime> --preflight
```

```powershell
npm run compile:electron
npm run qa:library-fonts -- run --output artifacts/library-full-pipeline-font-qa-v9 --cohort baseline40 --candidate-id student-v2 --runtime-dir artifacts/manga-font-runtime-full22-calibrated-v2 --execute
```

현재 설정이 `openai-api` 또는 `openai-codex`이면 하네스는 중단한다. 원격 호출과 비용을 명시적으로 허용하려는 경우에만 `--allow-paid-provider`를 추가한다. 로컬 Gemma 설정에는 이 플래그가 필요 없다.

안전한 1페이지 셰이크다운은 `--page-limit 1`을 붙인다. 최종 실사용 QA 보고서에는 제한 없는 40페이지 실행만 사용한다.

## 3. 빠른 폰트 반복

첫 전체 실행은 페이지별로 다음 재사용 자산을 남긴다.

- 원본 이미지와 번역 전 과정 산출물
- 자동 폰트를 제거하고 앱 기본 서식으로 되돌린 번역 블록
- 프로덕션 font inference에 들어간 정확한 normalized overlay item
- 원문 제거가 끝난 이미지
- 전체 pixel inference와 상위 5개 후보 로그

새 모델은 번역/API/인페인팅을 다시 돌리지 않고 프로덕션 pixel inference → decision policy → 말풍선 레이아웃 → PNG 렌더만 반복할 수 있다.

```powershell
npm run qa:library-fonts -- run --output artifacts/library-full-pipeline-font-qa-v9 --cohort baseline40 --candidate-id student-v3 --runtime-dir artifacts/manga-font-runtime-full22-calibrated-v3 --cache-from <student-v2-run-dir> --execute
```

이 replay는 OCR/번역 결과를 임의로 재구성하지 않는다. 첫 실행 때 캡처한 실제 normalized item과 중립 번역 블록을 입력으로 쓰고, 앱의 `createFontMatchingPageInferencePort`, `resolveAutomaticFontDecisionV2`, `applyAutomaticFontDecisionV2`, chapter coordinator, bubble layout, page export를 그대로 호출한다.

모델은 그대로 두고 decision policy·화/페이지 일관성·레이아웃만 반복할 때는 검증된 raw pixel inference도 재사용할 수 있다. 이 모드는 ONNX `inferPage`를 생략하므로 40페이지 반복을 크게 단축한다.

```powershell
npm run qa:library-fonts -- run --output artifacts/library-full-pipeline-font-qa-v9 --cohort baseline40 --candidate-id pc-v4 --run-id r1 --runtime-dir <same-runtime-dir> --cache-from <completed-source-run-dir> --reuse-cached-font-inference required --execute
```

`required`만 허용한다. 현재 runtime 계약·모델·catalog와 후보 순서·renderer, 원본 페이지 ID/SHA, normalized request block ID/순서/내용, user-page boundary, 각 inference의 모델/catalog/renderer 결합, 후보 inventory, 폐기 폰트 정책이 모두 일치해야 한다. 하나라도 다르거나 trace가 없으면 해당 페이지는 fail-closed로 실패하며 live ONNX 추론으로 몰래 폴백하지 않는다. 모델이나 catalog를 바꾼 반복은 이 옵션을 빼고 바로 위의 일반 font replay를 사용한다.

Windows의 Electron 임시 HTML 경로 한도를 넘기지 않도록 `candidate-id`와 `run-id`는 위 예시처럼 짧게 유지한다.

## 4. baseline과 candidate 비교

```powershell
npm run qa:library-fonts -- compare --baseline <baseline-run-dir> --candidate <candidate-run-dir>
```

두 실행의 frozen cohort SHA가 다르면 비교를 거부한다. 결과는 candidate run의 `comparison` 폴더에 생성된다.

- 완료/실패 페이지와 블록 수
- 자동 적용률, 적용 confidence, 선택 폰트 다양성
- 페이지별 렌더 SHA 변화
- 블록별 baseline/candidate 폰트, 역할, confidence
- 수동 판정용 `manualVerdict`, `manualNotes`

구조 guardrail 통과는 품질 합격을 뜻하지 않는다. 각 run의 `review.html`과 `comparison.json`으로 40페이지 렌더를 모두 확인해야 한다. candidate가 나빠지면 기존 runtime을 그대로 유지하고 그 run은 채택하지 않는다.

## 5. 새 holdout40

baseline 반복이 충분히 좋아진 뒤에만 다음을 실행한다.

```powershell
npm run qa:library-fonts -- run --output artifacts/library-full-pipeline-font-qa-v9 --cohort holdout40 --candidate-id accepted-vN --runtime-dir <accepted-runtime> --allow-holdout --execute
```

`--allow-holdout`이 없으면 실행을 거부한다. holdout 결과로 다시 모델이나 threshold를 튜닝했다면 그 40장은 더 이상 최종 holdout이 아니므로, 새 버전 출력 디렉터리와 새 seed로 다음 40페이지를 예약해야 한다.

## 6. 다음 40페이지로 계속 회전

두 코호트를 모두 사용한 뒤에는 새 출력 디렉터리와 seed를 사용하고, 이미 본 코호트 manifest를 `--extra-boundary`로 추가한다. 기본 학습 경계는 그대로 유지되며, 이전 80장의 ID·경로·원본 SHA도 함께 제외된다.

```powershell
npm run qa:library-fonts -- select --output artifacts/library-full-pipeline-font-qa-v9 --seed font-qa-20260803-v9-joint-work-disjoint --work-boundary artifacts/manga-font-legacy15-train-overlay-v1 --extra-boundary artifacts/library-full-pipeline-font-qa-v7/cohorts/baseline40.jsonl --extra-boundary artifacts/library-full-pipeline-font-qa-v7/cohorts/holdout40.jsonl --extra-boundary artifacts/manga-font-fresh-eval-cohort-v1/cohort.jsonl
npm run qa:library-fonts -- inspect --output artifacts/library-full-pipeline-font-qa-v9
```

이 예시는 이전 QA 페이지·원본 바이트뿐 아니라 legacy15 overlay에 들어간 15개 학습 작품 전체도 제외한다. 같은 방식을 반복하면 이미 본 페이지나 학습 작품을 다시 쓰지 않고 계속 새로운 baseline40/holdout40 쌍을 예약할 수 있다. 매 회차에서 baseline40으로 개선·되돌리기를 반복하고, 만족한 모델만 holdout40에 한 번 올린다.

## 생성물

각 run은 다음을 남긴다.

- `run-config.json`: 비밀값을 제외한 provider/model/runtime 계약
- `run-report.json`: 페이지 상태, 해시, 폰트 결정 로그, 선택 분포
- `review.html`: 원본과 최종 렌더 40페이지 검토 화면
- `pages/NN/font-input.json`: 빠른 반복용 중립 번역 입력
- `pages/NN/font-inference.json`: runtime 상태, 역할, calibration, 후보 점수
- `pages/NN/rendered.png`: 앱 렌더러의 최종 결과

원본 보관함의 `chapter.json`, 블록, 이미지에는 쓰지 않는다. 전체 실행은 원본을 run 디렉터리로 복사하고, 인페인팅 산출물도 그 격리 디렉터리 아래에만 만든다.
