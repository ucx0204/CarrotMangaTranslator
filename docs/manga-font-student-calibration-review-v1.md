# MangaFont student22 supervised calibration

이 절차는 22개 폰트 student runtime의 `selection-calibration.json`을 만드는
전용 경로다. 기존 `blind_agreement` 라벨은 추천 참고자료일 뿐 calibration
gold가 아니다. 이름이 보이는 validation contact sheet를 사람이 확인한 뒤에만
`primary` 또는 `adjudicated` finals로 승격된다. Test 행은 어느 단계에도
포함되지 않는다.

## 1. 이름 표시 validation 검수 카드

```powershell
python scripts\build_manga_font_student_calibration_review.py build `
  --reference-finals artifacts\font-matching-training-export-full22-strict-v1\resolved-labels-full22.jsonl `
  --master-manifest datasets\font-matching-master-v2\manifest.jsonl `
  --catalog-registry datasets\font-matching-catalog-registry-v2.json `
  --render-bank-manifest datasets\fontclip-font-render-bank-v2\manifest.json `
  --output-dir artifacts\manga-font-student-calibration-named-review-val33-v1 `
  --expected-count 33 --rows-per-sheet 11
```

출력 contact sheet는 원문 `raw_224`, `context_224`, `glyph_224`와 이름이
표시된 22개 후보 렌더를 함께 보여준다. 후보 테두리 색은 기존 blind tier를
찾기 쉽게 표시할 뿐 정답 권위가 아니다.

Bundle 내부에는 새 파일을 넣거나 기존 파일을 바꾸지 않는다. 권장 경로인
`apply-judgments`는 봉인된 template를 제자리에서 읽고, 완성본만 bundle 밖에
쓴다. 전체 template를 직접 편집하는 대체 경로를 쓸 때만 먼저 복사한다.

## 2. 짧은 판단 파일을 완전한 decisions JSONL로 변환

33행짜리 22후보 partition을 직접 편집할 필요는 없다. Contact sheet를 보고
선택한 결과만 bundle 밖의 작은 JSON 파일에 `sample_id` 키로 적는다.

```json
{
  "val-sample-001": {
    "preferred": ["nanum-myeongjo"],
    "acceptable": ["ridi-batang"],
    "marginal": ["seoul-hangang"],
    "confidence": 0.97,
    "notes": "명조 계열의 가는 대사"
  },
  "val-sample-002": {
    "preferred": ["gasoek-one"],
    "acceptable": [],
    "marginal": ["black-han-sans"]
  }
}
```

JSONL도 지원한다. 이때는 각 행에 같은 필드와 `sample_id`를 넣는다. 두 형식
모두 validation 33개를 정확히 한 번씩 포함해야 하고 `preferred`,
`acceptable`, `marginal`은 반드시 배열로 쓴다. `confidence`와 `notes`만
생략할 수 있다.

```powershell
python scripts\promote_manga_font_student_calibration_finals.py apply-judgments `
  --review-bundle-dir artifacts\manga-font-student-calibration-named-review-val33-v1 `
  --judgments artifacts\manga-font-student-calibration-judgments-val33-v1.json `
  --output artifacts\manga-font-student-calibration-decisions-val33-v1.jsonl `
  --reviewer sam40-font-review --default-confidence 0.95
```

명시하지 않은 렌더 가능한 후보는 모두 `unacceptable`이 된다. `unrenderable`은
사람의 취향 tier로 새로 지정할 수 없고, 봉인된 원본 template에서 실제 렌더
불가로 기록된 후보만 보존한다. `not_reviewed`는 비워지고 `none_acceptable`은
자동 계산된다. 도구는 완료 상태, evidence 확인, reviewer, UTC 시각도 채운 뒤
기존 promotion validator를 그대로 통과한 JSONL만 원자적으로 출력한다.
출력은 불변 review bundle 밖이어야 한다.

`--reviewed-at 2026-08-03T06:45:00Z`로 UTC 시각을 명시할 수 있으며, 생략하면
실행 시점의 UTC가 들어간다. 기존 정상 출력 파일을 의도적으로 다시 만들
때만 `--replace-valid-output`을 사용한다. 임의 파일이나 불완전한 decisions는
이 옵션으로도 덮어쓸 수 없다.

### 전체 template를 직접 편집하는 대체 경로

```powershell
Copy-Item `
  artifacts\manga-font-student-calibration-named-review-val33-v1\decisions-template.jsonl `
  artifacts\manga-font-student-calibration-decisions-val33-v1.jsonl
```

각 JSONL 행에서 다음 값만 채우거나 판단 결과에 맞게 고친다.

- `decision_status`: `"complete"`
- `reviewer`: 영문·숫자와 `._:-`로 된 식별자
- `reviewed_at`: UTC RFC3339 시각. 예: `"2026-08-03T04:30:00Z"`
- `confidence`: `0.0`부터 `1.0`
- `review_sheet_acknowledged`: `true`
- `font_judgment`: 필요하면 prefilled blind 참고 partition을 수정
- `notes`: 선택 사항

`decision_id`, `review_id`, `review_item_sha256`, `sample_id`, `schema_version`,
`record_type`은 바꾸지 않는다.

판정 기준은 다음과 같다.

- `preferred`: 가장 잘 맞는 후보. 실제 동률일 때만 복수 사용
- `acceptable`: 앱이 골라도 충분히 자연스러운 후보
- `marginal`: 제한된 상황에서만 쓸 수 있는 후보
- `unacceptable`: 원문의 역할·획·인상과 맞지 않는 후보
- `unrenderable`: 취향 문제가 아니라 글리프 누락이나 기술적 렌더 실패
- `not_reviewed`: 최종 결정에서는 반드시 빈 배열
- `none_acceptable`: `preferred`와 `acceptable`이 모두 비었을 때만 `true`

22개 후보는 여섯 tier에 중복 없이 정확히 한 번씩 들어가야 한다. 기존 blind
partition을 그대로 확인한 행도 사람 인증 필드는 반드시 채운다.

## 3. 사람 결정을 calibration gold로 승격

```powershell
python scripts\promote_manga_font_student_calibration_finals.py promote `
  --review-bundle-dir artifacts\manga-font-student-calibration-named-review-val33-v1 `
  --decisions artifacts\manga-font-student-calibration-decisions-val33-v1.jsonl `
  --output-dir artifacts\manga-font-student-calibration-gold-val33-v1
```

사람 판단이 blind 참고 partition과 같으면 `primary`, 달라지면 contact sheet
SHA와 이름 노출 사실을 결합한 `adjudicated` final이 된다. 기존
`blind_agreement` 행이 직접 승격되는 경우는 없다.

## 4. ONNX runtime에서 supervised operating point 생성

먼저 `export_manga_font_student_runtime_onnx.py`로 base runtime을 만든다.
Calibration builder는 checkpoint가 아니라 이 봉인된 ONNX runtime을 읽으며,
runtime contract SHA가 student checkpoint와 model-contract SHA까지 전이적으로
결합한다.

```powershell
python scripts\build_font_matching_selection_calibration.py build `
  --finals artifacts\manga-font-student-calibration-gold-val33-v1\finals-calibration-val.jsonl `
  --master-manifest datasets\font-matching-master-v2\manifest.jsonl `
  --catalog-registry datasets\font-matching-catalog-registry-v2.json `
  --runtime-dir artifacts\manga-font-runtime-full22-v1 `
  --output artifacts\manga-font-student-selection-calibration-full22-v1.json `
  --coverage-target 0.90 --precision-target 0.88
```

생성기는 runtime 후보 순서를 그대로 사용해 45개 연속 feature와 22개 후보
one-hot feature를 만든다. Candidate order, encoder, ranker, prototype bank,
catalog registry, base runtime contract SHA가 모두 일치해야 한다. Work-group
LOGO OOF에서 global 정상 표본 coverage 90%를 충족하지 못하면 출력하지 않는다.

## 5. Calibration 부착 및 검증

```powershell
python scripts\attach_font_matching_selection_calibration.py attach `
  --runtime-dir artifacts\manga-font-runtime-full22-v1 `
  --selection-calibration artifacts\manga-font-student-selection-calibration-full22-v1.json `
  --output-dir artifacts\manga-font-runtime-full22-calibrated-v1
```

```powershell
python scripts\attach_font_matching_selection_calibration.py validate `
  --output-dir artifacts\manga-font-runtime-full22-calibrated-v1
```

앱의 TypeScript loader도 15개 legacy와 22개 student catalog만 허용하며,
calibration 또는 SHA binding이 없으면 자동 폰트 변경을 계속 fail-closed한다.
